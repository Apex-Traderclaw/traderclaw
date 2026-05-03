#!/usr/bin/env bash
# OpenClaw session / checkpoint cleanup (safe for cron: resolves gateway unit, fixes user-systemd env)
#
# Archives bloated heartbeat session logs + *.checkpoint.*.jsonl shards (defaults: size >= CHECKPOINT_MIN_MB),
# trims stale sessions.json keys (heartbeat pointer + alpha_stream), restarts the gateway like TraderClaw:
#   systemctl --user stop|daemon-reload|start  openclaw-gateway.service
# Unit name matches `resolveGatewayUnitNameFromStatusJson` when `openclaw gateway status --json` works.
#
# Typical weekly cron (root VPS, state under /root/.openclaw):
#   0 3 * * 0 OPENCLAW_STATE_DIR=/root/.openclaw /usr/local/lib/node_modules/solana-traderclaw/scripts/openclaw-session-cleanup.sh >> /var/log/openclaw-session-cleanup.log 2>&1
#
# Aggressive mode (move every checkpoint shard, not only large ones):
#   STRIP_ALL_CHECKPOINTS=1 OPENCLAW_STATE_DIR=/root/.openclaw …/openclaw-session-cleanup.sh
#
# Optional env:
#   OPENCLAW_STATE_DIR       default: $HOME/.openclaw
#   OPENCLAW_AGENT_ID        default: main
#   OPENCLAW_GATEWAY_UNIT    default: auto from openclaw JSON, else openclaw-gateway.service
#   CHECKPOINT_MIN_MB        default: 10
#   STRIP_ALL_CHECKPOINTS    default: 0  (set 1 to archive all *.checkpoint.*.jsonl)
#   ARCHIVE_RETENTION_DAYS   if set, delete archive subdirs older than this many days
#   DRY_RUN                  if 1, only print planned actions (still resolves unit; does not stop gateway)

set -euo pipefail

STATE="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
AGENT_ID="${OPENCLAW_AGENT_ID:-main}"
SESSIONS="$STATE/agents/$AGENT_ID/sessions"
ARCHIVE="$SESSIONS.archive"
MIN_MB="${CHECKPOINT_MIN_MB:-10}"
STRIP_ALL="${STRIP_ALL_CHECKPOINTS:-0}"
DRY="${DRY_RUN:-0}"
UNIT="${OPENCLAW_GATEWAY_UNIT:-}"
RETAIN_DAYS="${ARCHIVE_RETENTION_DAYS:-}"

fix_user_systemd_env_for_cron() {
  if [[ -z "${XDG_RUNTIME_DIR:-}" ]] && [[ -n "${HOME:-}" ]]; then
    local uid
    uid="$(id -u)"
    if [[ -d "/run/user/$uid" ]]; then
      export XDG_RUNTIME_DIR="/run/user/$uid"
    fi
  fi
}

resolve_gateway_unit() {
  if [[ -n "$UNIT" ]]; then
    echo "$UNIT"
    return
  fi
  if ! command -v openclaw >/dev/null 2>&1; then
    echo "openclaw-gateway.service"
    return
  fi
  local j
  j="$(openclaw gateway status --json 2>/dev/null || true)"
  if [[ -z "$j" ]]; then
    echo "openclaw-gateway.service"
    return
  fi
  python3 -c '
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    print("openclaw-gateway.service")
    raise SystemExit(0)
try:
    d = json.loads(raw)
except json.JSONDecodeError:
    print("openclaw-gateway.service")
    raise SystemExit(0)
svc = d.get("service") or {}
systemd = svc.get("systemd") or {}
u = systemd.get("unit") or ""
if isinstance(u, str) and u.endswith(".service"):
    print(u)
    raise SystemExit(0)
for key in ("file",):
    f = svc.get(key) or ""
    if isinstance(f, str) and "/" in f and f.endswith(".service"):
        print(f.split("/")[-1])
        raise SystemExit(0)
for key in ("file", "unitPath"):
    f = systemd.get(key) or ""
    if isinstance(f, str) and "/" in f and f.endswith(".service"):
        print(f.split("/")[-1])
        raise SystemExit(0)
print("openclaw-gateway.service")
' <<<"$j"
}

prune_old_archives() {
  [[ -n "$RETAIN_DAYS" ]] || return 0
  [[ "$DRY" == "1" ]] && return 0
  [[ -d "$ARCHIVE" ]] || return 0
  find "$ARCHIVE" -mindepth 1 -maxdepth 1 -type d -mtime "+${RETAIN_DAYS}" -print -exec rm -rf {} +
}

ts="$(date +%Y%m%d-%H%M%S)"

echo "== OpenClaw session cleanup $ts"
echo "   State dir: $STATE"
echo "   Sessions:  $SESSIONS"

if [[ ! -d "$SESSIONS" ]]; then
  echo "   No sessions directory — nothing to do."
  exit 0
fi

fix_user_systemd_env_for_cron
UNIT="$(resolve_gateway_unit)"
echo "   Gateway unit: $UNIT"

mkdir -p "$ARCHIVE/$ts"

stop_gateway() {
  if [[ "$DRY" == "1" ]]; then
    echo "   [dry-run] would: systemctl --user stop $UNIT"
    return
  fi
  systemctl --user stop "$UNIT" || true
  sleep 2
}

start_gateway() {
  if [[ "$DRY" == "1" ]]; then
    echo "   [dry-run] would: systemctl --user daemon-reload && systemctl --user start $UNIT"
    return
  fi
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user start "$UNIT"
  sleep 3
  systemctl --user is-active "$UNIT" || {
    echo "   WARN: gateway not active — check: journalctl --user -u $UNIT -n 80 --no-pager" >&2
    return 1
  }
}

backup_registry() {
  local reg="$SESSIONS/sessions.json"
  if [[ ! -f "$reg" ]]; then
    echo "   No sessions.json — skipping registry backup."
    return
  fi
  if [[ "$DRY" == "1" ]]; then
    echo "   [dry-run] would backup $reg"
    return
  fi
  cp -a "$reg" "$SESSIONS/sessions.json.bak.$ts"
  echo "   Registry backup: sessions.json.bak.$ts"
}

archive_heartbeat_and_checkpoints() {
  export SESSIONS ARCHIVE_BASE="$ARCHIVE" ARCHIVE_TS="$ts" DRY STRIP_ALL MIN_MB OPENCLAW_AGENT_ID="$AGENT_ID"
  python3 <<'PY'
import json, os, shutil, sys

sessions = os.environ["SESSIONS"]
archive_ts = os.environ["ARCHIVE_TS"]
dry = os.environ["DRY"] == "1"
strip_all = os.environ["STRIP_ALL"] == "1"
min_mb = int(os.environ["MIN_MB"])
agent = os.environ["OPENCLAW_AGENT_ID"]

dest = os.path.join(os.environ["ARCHIVE_BASE"], archive_ts)
os.makedirs(dest, exist_ok=True)

reg_path = os.path.join(sessions, "sessions.json")
hb_sid = ""

if os.path.isfile(reg_path):
    try:
        with open(reg_path, encoding="utf-8") as f:
            r = json.load(f)
        e = r.get(f"agent:{agent}:main:heartbeat") or r.get("agent:main:main:heartbeat")
        if e and isinstance(e.get("sessionId"), str):
            hb_sid = e["sessionId"]
    except Exception as ex:
        print(f"   WARN: could not read registry: {ex}", file=sys.stderr)

def move_if_exists(src):
    if not os.path.isfile(src):
        return
    base = os.path.basename(src)
    dst = os.path.join(dest, base)
    if dry:
        print(f"   [dry-run] would mv {src} -> {dst}")
        return
    shutil.move(src, dst)
    print(f"   archived {base}")

if hb_sid:
    move_if_exists(os.path.join(sessions, f"{hb_sid}.jsonl"))
    for name in os.listdir(sessions):
        if name.startswith(hb_sid + ".checkpoint.") and name.endswith(".jsonl"):
            move_if_exists(os.path.join(sessions, name))

min_bytes = max(min_mb, 0) * 1024 * 1024
for name in os.listdir(sessions):
    if not (name.endswith(".jsonl") and ".checkpoint." in name):
        continue
    path = os.path.join(sessions, name)
    try:
        st = os.stat(path)
    except OSError:
        continue
    if strip_all or st.st_size >= min_bytes:
        move_if_exists(path)

print(f"   Archive batch: {dest}")
PY
}

clean_stale_registry_keys() {
  local reg="$SESSIONS/sessions.json"
  [[ -f "$reg" ]] || return 0
  if [[ "$DRY" == "1" ]]; then
    echo "   [dry-run] would trim heartbeat + alpha_stream keys in sessions.json"
    return
  fi
  export REG="$reg" OPENCLAW_AGENT_ID="$AGENT_ID"
  python3 <<'PY'
import json, os
agent = os.environ["OPENCLAW_AGENT_ID"]
reg = os.environ["REG"]
hb_key = f"agent:{agent}:main:heartbeat"
with open(reg, encoding="utf-8") as f:
    r = json.load(f)
n0 = len(r)
r.pop(hb_key, None)
r.pop("agent:main:main:heartbeat", None)
for k in [k for k in list(r.keys()) if "alpha_stream" in k]:
    r.pop(k, None)
tmp = reg + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(r, f, indent=2)
os.replace(tmp, reg)
print(f"   Registry entries: {n0} -> {len(r)}")
PY
}

prune_old_archives

stop_gateway
backup_registry
archive_heartbeat_and_checkpoints
clean_stale_registry_keys

if [[ "$DRY" != "1" ]]; then
  echo "   Archived size:"
  du -sh "$ARCHIVE/$ts" 2>/dev/null || true
fi

start_gateway

echo "OK — heartbeat will open a fresh session on the next tick."
echo "    Archive: $ARCHIVE/$ts (delete old archives when comfortable)"
