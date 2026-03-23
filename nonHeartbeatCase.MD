> **Note:** As of **`solana-traderclaw@1.0.18`**, use `npm install -g solana-traderclaw`. OpenClaw plugin id remains **`solana-trader`**. Historical logs below predate that alignment.

root@vultr:~# # 1. Is heartbeat in the actual config?
openclaw config get agents

# 2. Is the gateway actually running?
openclaw gateway status

# 3. Is Telegram channel healthy?
openclaw channels status --probe

# 4. Gateway logs — does heartbeat fire?
journalctl -u openclaw -n 100 --no-pager | grep -i heartbeat
Config warnings:\n- plugins.entries.solana-trader: plugin solana-trader: plugin id mismatch (manifest uses "solana-trader", entry hints "solana-traderclaw-v1")

🦞 OpenClaw 2026.3.13 (61d171a) — Alexa, but with taste.

{
  "defaults": {
    "model": {
      "primary": "anthropic/claude-haiku-4-5-20251001"
    },
    "models": {
      "anthropic/claude-haiku-4-5-20251001": {
        "params": {
          "cacheRetention": "short"
        }
      }
    },
    "contextPruning": {
      "mode": "cache-ttl",
      "ttl": "1h"
    },
    "compaction": {
      "mode": "safeguard"
    },
    "heartbeat": {
      "every": "30m"
    },
    "maxConcurrent": 4,
    "subagents": {
      "maxConcurrent": 8
    }
  },
  "list": [
    {
      "id": "main",
      "default": true,
      "heartbeat": {
        "every": "5m",
        "target": "last"
      }
    }
  ]
}
03:54:11 [plugins] [solana-trader] Session config: refreshToken=present (fa8b30cd...), apiKey=present, walletPublicKey=present
03:54:11 [plugins] [solana-trader] Registered 3 X/Twitter read tools (search, mentions, threads). Profiles: unconfigured
03:54:11 [plugins] [solana-trader] Registered web_fetch_url tool (website analysis, metadata URI inspection)
03:54:11 [plugins] [solana-trader] Registered 67 tools (67 trading + 0 X/Twitter read) for walletId 8482f2c7-46e4-4061-a263-a5e77039436a (session auth mode)
Config warnings:\n- plugins.entries.solana-trader: plugin solana-trader: plugin id mismatch (manifest uses "solana-trader", entry hints "solana-traderclaw-v1")
Config warnings:\n- plugins.entries.solana-trader: plugin solana-trader: plugin id mismatch (manifest uses "solana-trader", entry hints "solana-traderclaw-v1")

🦞 OpenClaw 2026.3.13 (61d171a) — I'm like tmux: confusing at first, then suddenly you can't live without me.

03:54:16 [plugins] [solana-trader] Session config: refreshToken=present (fa8b30cd...), apiKey=present, walletPublicKey=present
03:54:16 [plugins] [solana-trader] Registered 3 X/Twitter read tools (search, mentions, threads). Profiles: unconfigured
03:54:16 [plugins] [solana-trader] Registered web_fetch_url tool (website analysis, metadata URI inspection)
03:54:16 [plugins] [solana-trader] Registered 67 tools (67 trading + 0 X/Twitter read) for walletId 8482f2c7-46e4-4061-a263-a5e77039436a (session auth mode)
│
◇  Config warnings ──────────────────────────────────────────────────────────────────────────╮
│                                                                                            │
│  - plugins.entries.solana-trader: plugin solana-trader: plugin id mismatch (manifest uses  │
│    "solana-trader", entry hints "solana-traderclaw-v1")                                    │
│                                                                                            │
├────────────────────────────────────────────────────────────────────────────────────────────╯
Config warnings:\n- plugins.entries.solana-trader: plugin solana-trader: plugin id mismatch (manifest uses "solana-trader", entry hints "solana-traderclaw-v1")
Config warnings:\n- plugins.entries.solana-trader: plugin solana-trader: plugin id mismatch (manifest uses "solana-trader", entry hints "solana-traderclaw-v1")
│
Config warnings:\n- plugins.entries.solana-trader: plugin solana-trader: plugin id mismatch (manifest uses "solana-trader", entry hints "solana-traderclaw-v1")
◇  
Service: systemd (enabled)
File logs: /tmp/openclaw/openclaw-2026-03-23.log
Command: /usr/bin/node /usr/lib/node_modules/openclaw/dist/index.js gateway --port 18789
Service file: ~/.config/systemd/user/openclaw-gateway.service
Service env: OPENCLAW_GATEWAY_PORT=18789

Config (cli): ~/.openclaw/openclaw.json
Config (service): ~/.openclaw/openclaw.json

Gateway: bind=loopback (127.0.0.1), port=18789 (service args)
Probe target: ws://127.0.0.1:18789
Dashboard: http://127.0.0.1:18789/
Probe note: Loopback-only gateway; only local clients can connect.

Runtime: running (pid 12409, state active, sub running, last exit 0, reason 0)
RPC probe: ok

Listening: 127.0.0.1:18789
Troubles: run openclaw status
Troubleshooting: https://docs.openclaw.ai/troubleshooting
Config warnings:\n- plugins.entries.solana-trader: plugin solana-trader: plugin id mismatch (manifest uses "solana-trader", entry hints "solana-traderclaw-v1")
Config warnings:\n- plugins.entries.solana-trader: plugin solana-trader: plugin id mismatch (manifest uses "solana-trader", entry hints "solana-traderclaw-v1")

🦞 OpenClaw 2026.3.13 (61d171a) — WhatsApp automation without the "please accept our new privacy policy".

03:54:22 [plugins] [solana-trader] Session config: refreshToken=present (fa8b30cd...), apiKey=present, walletPublicKey=present
03:54:22 [plugins] [solana-trader] Registered 3 X/Twitter read tools (search, mentions, threads). Profiles: unconfigured
03:54:22 [plugins] [solana-trader] Registered web_fetch_url tool (website analysis, metadata URI inspection)
03:54:22 [plugins] [solana-trader] Registered 67 tools (67 trading + 0 X/Twitter read) for walletId 8482f2c7-46e4-4061-a263-a5e77039436a (session auth mode)
│
◇  Config warnings ──────────────────────────────────────────────────────────────────────────╮
│                                                                                            │
│  - plugins.entries.solana-trader: plugin solana-trader: plugin id mismatch (manifest uses  │
│    "solana-trader", entry hints "solana-traderclaw-v1")                                    │
│                                                                                            │
├────────────────────────────────────────────────────────────────────────────────────────────╯
│
Config warnings:\n- plugins.entries.solana-trader: plugin solana-trader: plugin id mismatch (manifest uses "solana-trader", entry hints "solana-traderclaw-v1")
◇  
Gateway reachable.
- Telegram default: enabled, configured, running, in:1m ago, mode:polling, bot:@traderclawv15bot, token:config, works

Tip: status --deep adds gateway health probes to status output (requires a reachable gateway).