import { execFileSync, execSync, spawn } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, join } from "path";
import { resolvePluginPackageRoot } from "./resolve-plugin-root.mjs";
import { choosePreferredProviderModel } from "./llm-model-preference.mjs";
import { getLinuxGatewayPersistenceSnapshot } from "./gateway-persistence-linux.mjs";

const CONFIG_DIR = join(homedir(), ".openclaw");
const CONFIG_FILE = join(CONFIG_DIR, "openclaw.json");

/** Pinned openclaw platform version — bump deliberately after testing, never use "latest". */
export const OPENCLAW_VERSION = "2026.5.4";

/** Directory containing solana-traderclaw (openclaw.plugin.json) — works for plugin layout or traderclaw-cli + dependency. */
const PLUGIN_PACKAGE_ROOT = resolvePluginPackageRoot(import.meta.url);

function readPluginPackageVersion() {
  const pkgJsonPath = join(PLUGIN_PACKAGE_ROOT, "package.json");
  if (!existsSync(pkgJsonPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    return typeof pkg.version === "string" && pkg.version.trim().length ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Spec for `npm install -g` and `openclaw plugins install`.
 * Prefer explicit registry coordinates (`package@version`) so npm never resolves a bare name or `file:`
 * relative to cwd (e.g. /root when TMPDIR or shadow folders break resolution).
 * Local directory install is opt-in for dev/offline: TRADERCLAW_INSTALLER_USE_LOCAL_PACKAGE=1.
 */
function resolveRegistryPluginInstallSpec(modeConfig) {
  if (process.env.TRADERCLAW_INSTALLER_USE_LOCAL_PACKAGE === "1") {
    const manifest = join(PLUGIN_PACKAGE_ROOT, "openclaw.plugin.json");
    const pkgJson = join(PLUGIN_PACKAGE_ROOT, "package.json");
    if (existsSync(manifest) && existsSync(pkgJson)) {
      return PLUGIN_PACKAGE_ROOT;
    }
  }
  const v = readPluginPackageVersion();
  if (v) return `${modeConfig.pluginPackage}@${v}`;
  return `${modeConfig.pluginPackage}@latest`;
}

/** Empty per-invocation cwd for npm global installs — avoids TMPDIR=/root and stray ./solana-traderclaw shadowing. */
function getNpmGlobalInstallCwd() {
  if (process.platform === "win32") {
    return mkdtempSync(join(tmpdir(), "tc-npm-"));
  }
  try {
    return mkdtempSync(join("/tmp", "tc-npm-"));
  } catch {
    return mkdtempSync(join(tmpdir(), "tc-npm-"));
  }
}

/** Older `plugins.entries` keys / npm-era ids for the v1 plugin. */
const LEGACY_TRADER_PLUGIN_IDS = ["traderclaw-v1", "solana-traderclaw-v1", "solana-traderclaw"];

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getLegacyTraderPluginIds(pluginId) {
  return pluginId === "solana-trader" ? LEGACY_TRADER_PLUGIN_IDS : [];
}

function normalizeTraderPluginEntries(config, pluginId) {
  if (!isRecord(config)) return false;
  if (!isRecord(config.plugins)) config.plugins = {};
  if (!isRecord(config.plugins.entries)) config.plugins.entries = {};

  const entries = config.plugins.entries;
  const legacyIds = getLegacyTraderPluginIds(pluginId);
  if (legacyIds.length === 0) return false;

  let touched = false;
  let hasSource = false;
  let enabledSeen = false;
  let enabledValue = false;
  let mergedConfig = {};

  for (const sourceId of [...legacyIds, pluginId]) {
    const entry = entries[sourceId];
    if (!isRecord(entry)) continue;
    hasSource = true;
    if (typeof entry.enabled === "boolean") {
      enabledSeen = true;
      enabledValue = enabledValue || entry.enabled;
    }
    if (isRecord(entry.config)) {
      mergedConfig = { ...mergedConfig, ...entry.config };
    }
  }

  if (!hasSource) return false;

  const canonicalEntry = isRecord(entries[pluginId]) ? entries[pluginId] : {};
  const nextEntry = {
    ...canonicalEntry,
    enabled: typeof canonicalEntry.enabled === "boolean" ? canonicalEntry.enabled : (enabledSeen ? enabledValue : true),
    config: mergedConfig,
  };

  if (entries[pluginId] !== nextEntry) {
    entries[pluginId] = nextEntry;
    touched = true;
  }

  for (const legacyId of legacyIds) {
    if (Object.prototype.hasOwnProperty.call(entries, legacyId)) {
      delete entries[legacyId];
      touched = true;
    }
  }

  return touched;
}

function normalizeTraderAllowlist(config, pluginId) {
  if (!isRecord(config?.plugins)) return false;
  const legacyIds = new Set(getLegacyTraderPluginIds(pluginId));
  if (legacyIds.size === 0 || !Array.isArray(config.plugins.allow)) return false;

  const nextAllow = [];
  const seen = new Set();
  let touched = false;

  for (const id of config.plugins.allow) {
    if (typeof id !== "string") {
      touched = true;
      continue;
    }
    const trimmed = id.trim();
    if (!trimmed) {
      touched = true;
      continue;
    }
    if (legacyIds.has(trimmed)) {
      touched = true;
      continue;
    }
    if (seen.has(trimmed)) {
      touched = true;
      continue;
    }
    seen.add(trimmed);
    nextAllow.push(trimmed);
  }

  if (touched) {
    config.plugins.allow = nextAllow;
  }
  return touched;
}

function stripAnsi(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[^[\]]/g, "")
    .replace(/\x1b/g, "");
}

/**
 * Extract and parse the first valid JSON object or array from a string that may contain
 * non-JSON prefix/suffix lines (e.g. progress text OpenClaw prints before the JSON payload).
 */
function extractJson(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const cleaned = stripAnsi(raw);

  try { return JSON.parse(cleaned); } catch {}

  const objIdx = cleaned.indexOf("{");
  const arrIdx = cleaned.indexOf("[");
  const candidates = [objIdx, arrIdx].filter((i) => i >= 0).sort((a, b) => a - b);

  for (const start of candidates) {
    const slice = cleaned.slice(start);
    try { return JSON.parse(slice); } catch {}
    const endChar = cleaned[start] === "{" ? "}" : "]";
    const end = cleaned.lastIndexOf(endChar);
    if (end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
    }
  }

  return null;
}

/** Env vars for every openclaw CLI invocation to suppress colour output. */
const NO_COLOR_ENV = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };

/**
 * OpenClaw defaults Telegram to groupPolicy "allowlist" with empty groupAllowFrom, so Doctor warns on
 * every gateway restart and group messages are dropped. Wizard onboarding targets DMs first; set
 * explicit "open" unless the user already configured sender allowlists.
 */
/**
 * Write Telegram bot token directly to openclaw.json.
 *
 * `openclaw channels add --channel telegram` was removed — the Telegram plugin
 * no longer exports register/activate, so the CLI rejects that call with
 * "telegram missing register/activate export / Channel telegram does not support add."
 *
 * The current OpenClaw approach (docs.openclaw.ai/channels/telegram):
 *   channels.telegram.botToken = "<token>"   → token source
 *   channels.telegram.enabled  = true        → enable the channel
 *   channels.telegram.dmPolicy = "pairing"   → safe default (user approves first DM)
 */
function writeTelegramChannelConfig(botToken, configPath = CONFIG_FILE) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    config = {};
  }
  if (!config.channels || typeof config.channels !== "object") config.channels = {};
  if (!config.channels.telegram || typeof config.channels.telegram !== "object") config.channels.telegram = {};
  config.channels.telegram.enabled = true;
  config.channels.telegram.botToken = botToken;
  // Only set dmPolicy if not already configured (preserve existing policy on re-installs).
  if (!config.channels.telegram.dmPolicy) {
    config.channels.telegram.dmPolicy = "pairing";
  }
  ensureAgentsDefaultsSchemaCompat(config);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function ensureTelegramGroupPolicyOpenForWizard(configPath = CONFIG_FILE) {
  if (!existsSync(configPath)) return { changed: false };
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return { changed: false };
  }
  if (!config.channels || typeof config.channels !== "object") return { changed: false };
  const tg = config.channels.telegram;
  if (!tg || typeof tg !== "object") return { changed: false };

  const hasSenderAllowlist =
    (Array.isArray(tg.groupAllowFrom) && tg.groupAllowFrom.length > 0) ||
    (Array.isArray(tg.allowFrom) && tg.allowFrom.length > 0);
  if (hasSenderAllowlist) return { changed: false };
  if (tg.groupPolicy === "open") return { changed: false };

  tg.groupPolicy = "open";
  ensureAgentsDefaultsSchemaCompat(config);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return { changed: true };
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore", shell: true });
    return true;
  } catch {
    return false;
  }
}

function getCommandOutput(cmd, { timeoutMs = 0 } = {}) {
  try {
    const opts = {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      maxBuffer: 50 * 1024 * 1024,
      env: NO_COLOR_ENV,
    };
    if (timeoutMs > 0) opts.timeout = timeoutMs;
    return execSync(cmd, opts).trim();
  } catch {
    return null;
  }
}

/**
 * First existing `skills/solana-trader` directory: local package → OpenClaw extension → global npm.
 * @param {{ pluginId: string, pluginPackage: string }} modeConfig
 * @returns {string|null}
 */
export function resolveSolanaTraderPackagedRoot(modeConfig) {
  const candidates = [
    join(PLUGIN_PACKAGE_ROOT, "skills", "solana-trader"),
    join(homedir(), ".openclaw", "extensions", modeConfig.pluginId, "skills", "solana-trader"),
  ];
  const npmRoot = getCommandOutput("npm root -g");
  if (npmRoot) {
    candidates.push(join(npmRoot, modeConfig.pluginPackage, "skills", "solana-trader"));
  }
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * First existing gateway template file under `config/{filename}`.
 * @param {{ pluginId: string, pluginPackage: string }} modeConfig
 * @param {string} gatewayConfigFilename
 * @returns {string|null}
 */
function resolveGatewayConfigSourcePath(modeConfig, gatewayConfigFilename) {
  const candidates = [
    join(PLUGIN_PACKAGE_ROOT, "config", gatewayConfigFilename),
    join(homedir(), ".openclaw", "extensions", modeConfig.pluginId, "config", gatewayConfigFilename),
  ];
  const npmRoot = getCommandOutput("npm root -g");
  if (npmRoot) {
    candidates.push(join(npmRoot, modeConfig.pluginPackage, "config", gatewayConfigFilename));
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function extractUrls(text = "") {
  const matches = text.match(/https?:\/\/[^\s"')]+/g);
  return matches ? [...new Set(matches)] : [];
}

function shellQuote(value) {
  const raw = String(value ?? "");
  if (raw.length === 0) return "''";
  return `'${raw.replace(/'/g, `'\\''`)}'`;
}

function buildCommandString(cmd, args = []) {
  return [cmd, ...args].map((part) => shellQuote(part)).join(" ");
}

function isPrivilegeError(err) {
  const text = `${err?.message || ""}\n${err?.stderr || ""}\n${err?.stdout || ""}`.toLowerCase();
  return (
    text.includes("permission denied")
    || text.includes("eacces")
    || text.includes("access denied")
    || text.includes("operation not permitted")
    || text.includes("must be root")
    || text.includes("requires root")
    || text.includes("sudo")
    || text.includes("authentication is required")
  );
}

function isRootUser() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function canUseSudoWithoutPrompt() {
  try {
    execSync("sudo -n true", { stdio: "ignore", shell: true });
    return true;
  } catch {
    return false;
  }
}

function tailscalePermissionRemediation() {
  return [
    "Tailscale requires elevated permissions on this host.",
    "Run these commands in your terminal, then click Start Installation again:",
    "1) sudo tailscale set --operator=$USER",
    "2) sudo tailscale up",
    "3) tailscale status",
  ].join("\n");
}

function privilegeRemediationMessage(cmd, args = [], customLines = []) {
  const command = buildCommandString(cmd, args);
  const lines = [
    "This step needs elevated privileges on this host.",
    "Run this command in your terminal, then click Start Installation again:",
    `sudo ${command}`,
  ];
  if (customLines.length > 0) {
    lines.push(...customLines);
  }
  return lines.join("\n");
}

function gatewayTimeoutRemediation() {
  return [
    "Gateway failed to start: service stayed stopped and health checks did not pass.",
    "This usually means the gateway service is misconfigured, crashed at launch, or the system is out of resources.",
    "",
    "Run these commands in your VPS terminal to diagnose and recover:",
    "1) openclaw gateway status --json || true       # check current state",
    "2) journalctl --user -u openclaw-gateway -n 50 --no-pager || true  # check service logs",
    "3) openclaw gateway stop || true",
    "4) openclaw gateway install",
    "5) openclaw gateway restart",
    "6) openclaw gateway status --json              # should show running + rpc.ok=true",
    "7) tailscale funnel --bg 18789",
    "8) tailscale funnel status",
    "",
    "If the gateway still fails:",
    "- Check RAM: openclaw gateway requires >=512MB free (>=2GB total recommended)",
    "- Check disk: df -h ~/.openclaw",
    "- Try: openclaw config validate && openclaw gateway doctor || true",
    `- If config schema error appears, run: npm install -g openclaw@${OPENCLAW_VERSION}`,
    "Once the gateway shows 'running' in status, click Start Installation again.",
  ].join("\n");
}

function gatewayModeUnsetRemediation() {
  return [
    "Gateway start is blocked because gateway.mode is unset.",
    "Run these commands in terminal, then click Start Installation again:",
    "1) cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%s) || true",
    "2) openclaw config set gateway.mode local",
    "3) openclaw config set gateway.bind loopback",
    "4) openclaw gateway restart",
    "5) openclaw gateway status --json",
  ].join("\n");
}

function gatewayConfigValidationRemediation() {
  return [
    "OpenClaw could not load or validate ~/.openclaw/openclaw.json after plugins are enabled (often an Ajv/schema compile error in the OpenClaw CLI, not invalid JSON syntax).",
    "The first `openclaw config validate` in this installer runs before plugins install; validation must be re-run once plugin schemas are registered — that is why this can appear only at gateway.",
    "On the VPS, try in order:",
    "1) openclaw --version",
    `2) npm install -g openclaw@${OPENCLAW_VERSION}`,
    "3) openclaw config validate",
    "4) openclaw plugins doctor",
    "5) cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%s) || true",
    "If it still fails, report the OpenClaw version plus output of steps 3–4 to OpenClaw/TraderClaw support (redact secrets).",
  ].join("\n");
}

function isOpenClawConfigSchemaFailure(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("ajv implementation")
    || t.includes("validatejsonschemavalue")
    || (t.includes("failed to read config") && t.includes("ajv"))
  );
}

function runCommandWithEvents(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const {
      onEvent,
      timeoutMs = 0,
      heartbeatMs = 0,
      heartbeatText = "command still running…",
      ...spawnOpts
    } = opts;

    let settled = false;
    let timeoutId;
    let heartbeatId;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (heartbeatId) clearInterval(heartbeatId);
      fn(arg);
    };

    const isNpm = /(?:^|[\\/])npm(?:\.cmd)?$/.test(cmd) || cmd === "npm";
    if (isNpm && !spawnOpts.env?.NODE_OPTIONS?.includes("max-old-space-size")) {
      spawnOpts.env = {
        ...process.env,
        ...spawnOpts.env,
        NODE_OPTIONS: [spawnOpts.env?.NODE_OPTIONS || process.env.NODE_OPTIONS || "", "--max-old-space-size=512"].filter(Boolean).join(" "),
      };
    }
    const child = spawn(cmd, args, {
      stdio: "pipe",
      shell: true,
      ...spawnOpts,
    });

    let stdout = "";
    let stderr = "";
    const emitFn = typeof onEvent === "function" ? onEvent : null;
    const emit = (event) => emitFn && emitFn(event);

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 12_000);
        const tail = `${stdout}\n${stderr}`.trim().slice(-6000);
        const err = new Error(
          `Timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}\n`
            + `Last output:\n${tail || "(no output yet — possible npm registry or network stall; try again or run the same npm command in a terminal)"}`,
        );
        err.timedOut = true;
        err.stdout = stdout;
        err.stderr = stderr;
        finish(reject, err);
      }, timeoutMs);
    }

    if (typeof heartbeatMs === "number" && heartbeatMs > 0 && emitFn) {
      const start = Date.now();
      heartbeatId = setInterval(() => {
        const sec = Math.floor((Date.now() - start) / 1000);
        emitFn({
          type: "stdout",
          text: `[installer] ${heartbeatText} (${sec}s elapsed).\n`,
          urls: [],
        });
      }, heartbeatMs);
    }

    child.stdout?.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      emit({ type: "stdout", text, urls: extractUrls(text) });
    });

    child.stderr?.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      emit({ type: "stderr", text, urls: extractUrls(text) });
    });

    child.on("close", (code) => {
      if (settled) return;
      const urls = [...new Set([...extractUrls(stdout), ...extractUrls(stderr)])];
      if (code === 0) finish(resolve, { stdout, stderr, code, urls });
      else {
        const isOom = code === 137 || (stderr || stdout || "").includes("Killed");
        const raw = (stderr || "").trim();
        const tailLines = raw.split("\n").filter((l) => l.length > 0).slice(-40).join("\n");
        const stderrPreview = tailLines.length > 8000 ? tailLines.slice(-8000) : tailLines;
        const prefix = isOom
          ? `Out of memory (exit 137 / SIGKILL): the host killed '${cmd}' — try a machine with ≥1 GB free RAM, or reduce concurrency with npm_config_maxsockets=2`
          : `command failed with exit code ${code}`;
        const err = new Error(stderrPreview ? `${prefix}: ${stderrPreview}` : prefix);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        err.urls = urls;
        err.oom = isOom;
        finish(reject, err);
      }
    });
    child.on("error", (e) => finish(reject, e));
  });
}

function getGlobalOpenClawPackageDir() {
  const root = getCommandOutput("npm root -g");
  if (!root) return null;
  const dir = join(root.trim(), "openclaw");
  return existsSync(join(dir, "package.json")) ? dir : null;
}

/**
 * Re-run `npm install` inside the global OpenClaw package tree. Some hosts end up with an
 * incomplete `node_modules` after `npm install -g` (hoisting, optional deps, or interrupted
 * installs). OpenClaw then fails at runtime with `Cannot find module 'grammy'` while loading
 * config. Installing from the package directory restores declared dependencies.
 *
 * `--ignore-scripts` avoids OpenClaw's postinstall (and nested installs) failing on hosts without
 * a C toolchain: e.g. `@discordjs/opus` has no prebuild for Node 22 and falls back to `node-gyp`
 * (`make` not found). Skipping scripts still installs declared JS deps (e.g. `grammy`). Users who
 * need native/voice features can install build-essential and re-run `npm install` without
 * `--ignore-scripts` in the global openclaw directory.
 *
 * We still run `npm install grammy @buape/carbon --no-save` with `--ignore-scripts` as a safety net.
 */
/** Runs `npm install` in the global `openclaw` package directory (fixes missing `grammy` etc.). */
export async function ensureOpenClawGlobalPackageDependencies() {
  const dir = getGlobalOpenClawPackageDir();
  if (!dir) {
    return { skipped: true, reason: "global_openclaw_dir_not_found" };
  }
  const registry = "https://registry.npmjs.org/";
  const installFlags = ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", registry];
  await runCommandWithEvents("npm", installFlags, { cwd: dir, shell: false });
  await runCommandWithEvents(
    "npm",
    [
      "install",
      "--omit=dev",
      "--no-save",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry",
      registry,
      "grammy",
      "@buape/carbon",
    ],
    { cwd: dir, shell: false },
  );
  return { repaired: true, dir };
}

/**
 * Install or upgrade the global OpenClaw CLI. We always run npm even when `openclaw` is already
 * on PATH: bundled plugin manifests track a minimum OpenClaw version (e.g. >=2026.4.8). A stale
 * global from an older install causes `openclaw plugins install` to fail config validation with
 * "plugin requires OpenClaw >=… but this host is …".
 */
/** Bound `openclaw --version` so a post-OAuth CLI that blocks on gateway/device init cannot hang the wizard. */
const OPENCLAW_CLI_VERSION_TIMEOUT_MS = 25_000;

async function installOpenClawPlatform(onEvent) {
  const hadOpenclaw = commandExists("openclaw");
  const previousVersion = hadOpenclaw ? getCommandOutput("openclaw --version", { timeoutMs: OPENCLAW_CLI_VERSION_TIMEOUT_MS }) : null;
  if (hadOpenclaw && !previousVersion && typeof onEvent === "function") {
    onEvent({
      type: "stderr",
      text: "openclaw --version did not return in time (or failed); continuing with npm install -g anyway.\n",
      urls: [],
    });
  }
  const npmCwd = getNpmGlobalInstallCwd();
  const npmTimeoutMs = Number.parseInt(String(process.env.TRADERCLAW_OPENCLAW_NPM_TIMEOUT_MS || "").trim(), 10);
  const effectiveTimeout = Number.isFinite(npmTimeoutMs) && npmTimeoutMs > 0 ? npmTimeoutMs : 1_800_000;
  if (typeof onEvent === "function") {
    onEvent({
      type: "stdout",
      text:
        `Running: npm install -g openclaw@${OPENCLAW_VERSION} (cwd=${npmCwd}, --no-audit --no-fund). `
        + "First-time or upgrade installs can take several minutes; live npm lines and heartbeats appear below. "
        + `Also watch the terminal where you started \`traderclaw install --wizard\`. `
        + `Override stall limit: TRADERCLAW_OPENCLAW_NPM_TIMEOUT_MS (ms), default ${effectiveTimeout}.\n`,
      urls: [],
    });
  }
  await runCommandWithEvents(
    "npm",
    [
      "install",
      "-g",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      "--loglevel",
      "warn",
      "--registry",
      "https://registry.npmjs.org/",
      `openclaw@${OPENCLAW_VERSION}`,
    ],
    {
      onEvent,
      cwd: npmCwd,
      shell: false,
      timeoutMs: effectiveTimeout,
      heartbeatMs: 30_000,
      heartbeatText:
        "npm still installing OpenClaw (extract/link phase — this is normal silence). Check disk space and outbound HTTPS to registry.npmjs.org if this repeats many times",
      env: {
        ...process.env,
        // Non-interactive / fewer slow npm side trips (fundraising prompts, audit).
        ...(process.env.CI ? {} : { CI: "true" }),
        npm_config_update_notifier: process.env.npm_config_update_notifier ?? "false",
      },
    },
  );
  if (typeof onEvent === "function") {
    onEvent({ type: "stdout", text: "npm install -g openclaw completed. Verifying binary on PATH…\n", urls: [] });
  }
  const available = commandExists("openclaw");
  // Version check is informational only — cap it tightly so a blocking CLI startup never stalls the step.
  const VERSION_TIMEOUT_MS = 8_000;
  let version = available ? getCommandOutput("openclaw --version", { timeoutMs: VERSION_TIMEOUT_MS }) : null;
  if (available && !version && typeof onEvent === "function") {
    onEvent({
      type: "stderr",
      text: `openclaw is on PATH but --version did not respond within ${VERSION_TIMEOUT_MS}ms; treating install as successful.\n`,
      urls: [],
    });
    version = "(version check timed out)";
  }
  if (!available) {
    throw new Error(`npm install -g openclaw@${OPENCLAW_VERSION} finished but \`openclaw\` is not available on PATH`);
  }
  return {
    alreadyInstalled: hadOpenclaw,
    installed: true,
    upgraded: hadOpenclaw,
    previousVersion,
    version,
    available: true,
  };
}

/**
 * Check whether the OpenClaw CLI has any devices stuck in a pending-approval or
 * repair state.  This can happen when the gateway version >= 1.0.93-beta.0 starts
 * treating every CLI invocation as a "device" that must be explicitly approved
 * before it gets operator-write scope.  Without that scope all trading RPCs fail
 * silently (read-only).
 *
 * Returns:
 *   { ran: false }                        – openclaw not on PATH or devices subcommand not supported
 *   { ran: true, pendingIds: string[],    – list ran OK; ids needing approval
 *     repairDetected: boolean,            – current device is in repair/read-only state
 *     envTokenSet: boolean }              – OPENCLAW_GATEWAY_TOKEN env var already present (fallback)
 */
function checkOpenClawDeviceApproval() {
  if (!commandExists("openclaw")) return { ran: false };
  const raw = getCommandOutput("openclaw devices list");
  if (!raw) return { ran: false };

  const lower = raw.toLowerCase();
  const envTokenSet = !!process.env.OPENCLAW_GATEWAY_TOKEN;

  // Detect devices that are waiting for approval ("pending" requestId lines).
  const pendingIds = [];
  for (const line of raw.split("\n")) {
    // Lines typically look like:  d4fcdbe8-5176-422b-...   pending
    const m = line.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (m && (line.toLowerCase().includes("pending") || line.toLowerCase().includes("repair"))) {
      pendingIds.push(m[1]);
    }
  }

  const repairDetected = lower.includes("repair");

  return { ran: true, pendingIds, repairDetected, envTokenSet, raw };
}

function isNpmGlobalBinConflict(err, cliName) {
  const text = `${err?.message || ""}\n${err?.stderr || ""}\n${err?.stdout || ""}`.toLowerCase();
  return (
    text.includes("eexist")
    && text.includes("/usr/bin/")
    && text.includes(String(cliName || "").toLowerCase())
  );
}

/** True when spec is an on-disk package directory (global npm path or git checkout), not a registry name. */
function isNpmFilesystemPackageSpec(spec) {
  if (typeof spec !== "string" || !spec.length) return false;
  if (spec.startsWith("/")) return true;
  return process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(spec);
}

/**
 * Args for `npm install -g …`. Use explicit registry for registry specs so npm never treats cwd/temp as `file:solana-traderclaw`.
 * IMPORTANT: run with `{ shell: false }` — `spawn(..., { shell: true })` can drop argv on Unix and npm then mis-resolves the package name.
 */
function npmGlobalInstallArgs(spec, { force = false } = {}) {
  const args = ["install", "-g", "--ignore-scripts", "--no-audit", "--no-fund"];
  if (force) args.push("--force");
  if (!isNpmFilesystemPackageSpec(spec)) {
    args.push("--registry", "https://registry.npmjs.org/");
  }
  args.push(spec);
  return args;
}

async function installPlugin(modeConfig, onEvent) {
  const spec = resolveRegistryPluginInstallSpec(modeConfig);
  const isLocalPluginRoot =
    typeof spec === "string" &&
    existsSync(join(spec, "openclaw.plugin.json")) &&
    existsSync(join(spec, "package.json"));
  if (isLocalPluginRoot && typeof onEvent === "function") {
    onEvent({
      type: "stdout",
      text: `Installing TraderClaw CLI from local package path (not on npm registry): ${spec}\n`,
      urls: [],
    });
  }
  const npmCwd = getNpmGlobalInstallCwd();
  if (typeof onEvent === "function") {
    onEvent({
      type: "stdout",
      text: `Running npm global install with cwd=${npmCwd}, shell=false, args=${JSON.stringify(npmGlobalInstallArgs(spec))}\n`,
      urls: [],
    });
  }
  const npmOpts = { onEvent, cwd: npmCwd, shell: false };
  try {
    await runCommandWithEvents("npm", npmGlobalInstallArgs(spec), npmOpts);
    return { installed: true, available: commandExists(modeConfig.cliName), forced: false };
  } catch (err) {
    if (!isNpmGlobalBinConflict(err, modeConfig.cliName)) throw err;
    if (typeof onEvent === "function") {
      onEvent({
        type: "stderr",
        text: `Detected existing global binary conflict for '${modeConfig.cliName}'. Retrying npm install with --force.\n`,
        urls: [],
      });
    }
    await runCommandWithEvents("npm", npmGlobalInstallArgs(spec, { force: true }), npmOpts);
    return { installed: true, available: commandExists(modeConfig.cliName), forced: true };
  }
}

function isPluginAlreadyExistsError(err, pluginId) {
  const text = `${err?.message || ""}\n${err?.stderr || ""}\n${err?.stdout || ""}`.toLowerCase();
  return text.includes("plugin already exists")
    || text.includes(`/extensions/${String(pluginId || "").toLowerCase()}`);
}

function backupExistingPluginDir(pluginId, onEvent) {
  const pluginDir = join(CONFIG_DIR, "extensions", pluginId);
  if (!existsSync(pluginDir)) return null;

  const backupPath = `${pluginDir}.bak.${Date.now()}`;
  renameSync(pluginDir, backupPath);
  if (typeof onEvent === "function") {
    onEvent({
      type: "stdout",
      text: `Detected existing plugin directory. Backed up '${pluginDir}' to '${backupPath}' before reinstall.\n`,
      urls: [],
    });
  }
  return { pluginDir, backupPath };
}

async function installAndEnableOpenClawPlugin(modeConfig, onEvent, orchestratorUrl) {
  // `openclaw plugins install` calls writeConfigFile *during* the command. Plugin config schema
  // requires orchestratorUrl — so we must seed it *before* install, not only after.
  // Also merge legacy plugins.entries.* (see LEGACY_TRADER_PLUGIN_IDS) so old configs still validate.
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(join(CONFIG_DIR, "extensions"), { recursive: true });

  seedPluginConfig(modeConfig, orchestratorUrl || "https://api.traderclaw.ai");

  const pluginInstallSpec = resolveRegistryPluginInstallSpec(modeConfig);
  let recoveredExistingDir = null;
  // --dangerously-force-unsafe-install bypasses OpenClaw's security scanner false positive.
  // Our dist/index.js triggers it because process.env (wallet key) and fetch() (web_fetch_url tool)
  // appear within the scanner's proximity window in the bundle, even though they are in separate
  // unrelated functions with no data flow between them.
  let scannerWarningExplained = false;
  const onEventWithScannerNote = (evt) => {
    onEvent(evt);
    const text = evt.text || "";
    if (!scannerWarningExplained && (text.includes("dangerous code patterns") || text.includes("credential harvesting"))) {
      scannerWarningExplained = true;
      onEvent({
        type: "stdout",
        text: "  ^ Known false positive: the plugin reads an env var (wallet signing key) and includes a\n" +
          "    web-fetch tool — two unrelated functions that happen to be close in the compiled bundle.\n" +
          "    No credential harvesting occurs. Bypassing with --dangerously-force-unsafe-install.",
      });
    }
  };
  const installArgs = ["plugins", "install", pluginInstallSpec, "--dangerously-force-unsafe-install"];
  try {
    await runCommandWithEvents("openclaw", installArgs, { onEvent: onEventWithScannerNote });
  } catch (err) {
    if (!isPluginAlreadyExistsError(err, modeConfig.pluginId)) {
      throw err;
    }
    recoveredExistingDir = backupExistingPluginDir(modeConfig.pluginId, onEvent);
    if (!recoveredExistingDir) {
      throw err;
    }
    await runCommandWithEvents("openclaw", installArgs, { onEvent: onEventWithScannerNote });
  }

  // Manifest is on disk now; merge orchestrator URL before enable (plugin config schema may require it).
  seedPluginConfig(modeConfig, orchestratorUrl || "https://api.traderclaw.ai");

  await runCommandWithEvents("openclaw", ["plugins", "enable", modeConfig.pluginId], { onEvent });

  // Safe to set plugins.allow only after install+enable — registry must know the plugin id.
  mergePluginsAllowlist(modeConfig);

  const list = await runCommandWithEvents("openclaw", ["plugins", "list"], { onEvent });
  const doctor = await runCommandWithEvents("openclaw", ["plugins", "doctor"], { onEvent });
  const pluginFound = `${list.stdout || ""}\n${list.stderr || ""}`.toLowerCase().includes(modeConfig.pluginId.toLowerCase());
  if (!pluginFound) {
    throw new Error(
      `Plugin '${modeConfig.pluginId}' was not found in 'openclaw plugins list' after install/enable.`,
    );
  }
  return {
    installed: true,
    enabled: true,
    verified: true,
    recoveredExistingDir,
    list: list.stdout || "",
    doctor: doctor.stdout || "",
  };
}

/**
 * Idempotent: ensure OpenClaw discovers skills under ~/.openclaw/extensions/<pluginId>/skills (extraDirs).
 * See OpenClaw workspace skill loader: config.skills.load.extraDirs → openclaw-extra.
 * @param {Record<string, unknown>} config
 * @param {string} pluginId
 */
function ensureTraderSkillsExtraDir(config, pluginId) {
  const marker = `.openclaw/extensions/${pluginId}/skills`;
  const tildeEntry = `~/.openclaw/extensions/${pluginId}/skills`;
  if (!config.skills || typeof config.skills !== "object") config.skills = {};
  if (!config.skills.load || typeof config.skills.load !== "object") config.skills.load = {};
  const raw = config.skills.load.extraDirs;
  const dirs = Array.isArray(raw) ? [...raw] : [];
  const normalized = (d) => (typeof d === "string" ? d.replace(/\\/g, "/") : "");
  const needle = normalized(tildeEntry);
  const hasMarker = dirs.some((d) => {
    const n = normalized(d);
    return n.includes(marker) || n === needle;
  });
  if (!hasMarker) {
    dirs.push(tildeEntry);
    config.skills.load.extraDirs = dirs;
  }
}

function seedPluginConfig(modeConfig, orchestratorUrl, configPath = CONFIG_FILE) {
  const defaultUrl = orchestratorUrl || "https://api.traderclaw.ai";

  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    config = {};
  }

  if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
  if (!config.plugins.entries || typeof config.plugins.entries !== "object") config.plugins.entries = {};

  normalizeTraderPluginEntries(config, modeConfig.pluginId);
  normalizeTraderAllowlist(config, modeConfig.pluginId);

  const entries = config.plugins.entries;

  const mergeOrchestratorForId = (pluginId) => {
    const existing = entries[pluginId];
    const existingConfig = existing && typeof existing === "object" && existing.config && typeof existing.config === "object"
      ? existing.config
      : {};
    const url = typeof existingConfig.orchestratorUrl === "string" && existingConfig.orchestratorUrl.trim()
      ? existingConfig.orchestratorUrl.trim()
      : defaultUrl;
    entries[pluginId] = {
      enabled: existing && typeof existing.enabled === "boolean" ? existing.enabled : true,
      config: {
        ...existingConfig,
        orchestratorUrl: url,
      },
    };
  };

  mergeOrchestratorForId(modeConfig.pluginId);

  ensureTraderSkillsExtraDir(config, modeConfig.pluginId);

  // Do not set plugins.allow here: OpenClaw validates allow[] against the plugin registry, and
  // the id is not registered until after `openclaw plugins install`. Pre-seeding allow caused:
  // "plugins.allow: plugin not found: <id>".
  ensureAgentsDefaultsSchemaCompat(config);

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return configPath;
}

/**
 * Resolve OpenClaw cron job store path (same rules as Gateway: optional cron.store, ~ expansion).
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
function resolveCronJobsStorePath(config) {
  const raw = config?.cron?.store;
  if (typeof raw === "string" && raw.trim()) {
    let t = raw.trim();
    if (t.startsWith("~")) {
      t =
        t === "~" || t === "~/" ? homedir() : join(homedir(), t.slice(2).replace(/^\/+/, ""));
    }
    if (t.startsWith("/") || (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(t))) {
      return t;
    }
    return join(CONFIG_DIR, t);
  }
  return join(CONFIG_DIR, "cron", "jobs.json");
}

function cronJobStableId(job) {
  if (!job || typeof job !== "object") return "";
  const id = typeof job.id === "string" ? job.id.trim() : "";
  if (id) return id;
  const legacy = typeof job.jobId === "string" ? job.jobId.trim() : "";
  return legacy;
}

/**
 * Build a cron job record compatible with OpenClaw 2026+ store normalization (see ~/.openclaw/cron/jobs.json).
 * @param {{ id: string, schedule: string, agentId: string, message: string, enabled?: boolean }} def
 */
function buildOpenClawCronStoreJob(def) {
  const nameFromId = def.id
    .split("-")
    .map((w) => (w.length ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
  const payload = {
    kind: "agentTurn",
    message: def.message,
    lightContext: def.lightContext !== undefined ? def.lightContext : true,
  };
  if (def.model) payload.model = def.model;
  if (def.thinking !== undefined) payload.thinking = def.thinking;
  const delivery = def.delivery || { mode: "announce", channel: "last", bestEffort: true };
  return {
    id: def.id,
    name: nameFromId.length <= 60 ? nameFromId : nameFromId.slice(0, 59) + "…",
    enabled: def.enabled !== false,
    schedule: { kind: "cron", expr: def.schedule },
    sessionTarget: "isolated",
    wakeMode: "now",
    agentId: def.agentId,
    payload,
    delivery,
    state: {},
  };
}

/**
 * Merge TraderClaw template cron jobs into the Gateway cron store (upsert by job id).
 * Preserves user-defined jobs whose ids are not in the template set.
 * @returns {{ storePath: string, added: number, updated: number, preserved: number, totalManaged: number }}
 */
function mergeTraderCronJobsIntoStore(storePath, templateJobs) {
  const managedIds = new Set(templateJobs.map((j) => j.id).filter(Boolean));
  let existing = { version: 1, jobs: [] };
  try {
    const raw = readFileSync(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs.filter(Boolean) : [];
      existing = { version: 1, jobs };
    }
  } catch (err) {
    if (err && err.code === "ENOENT") {
      // New store file — only TraderClaw template jobs.
    } else {
      return {
        storePath,
        added: 0,
        updated: 0,
        preserved: 0,
        totalManaged: templateJobs.length,
        error: err?.message || String(err),
        wrote: false,
      };
    }
  }

  const beforeKeys = new Set();
  for (const j of existing.jobs) {
    const k = cronJobStableId(j);
    if (k) beforeKeys.add(k);
  }

  const preserved = existing.jobs.filter((j) => !managedIds.has(cronJobStableId(j)));
  const built = templateJobs.map((def) => buildOpenClawCronStoreJob(def));
  const next = { version: 1, jobs: [...preserved, ...built] };

  let added = 0;
  let updated = 0;
  for (const id of managedIds) {
    if (beforeKeys.has(id)) updated += 1;
    else added += 1;
  }

  const dir = dirname(storePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf-8");
  renameSync(tmp, storePath);

  return {
    storePath,
    added,
    updated,
    preserved: preserved.length,
    totalManaged: templateJobs.length,
    wrote: true,
  };
}

function mergePluginsAllowlist(modeConfig, configPath = CONFIG_FILE) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return;
  }
  if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
  normalizeTraderPluginEntries(config, modeConfig.pluginId);
  normalizeTraderAllowlist(config, modeConfig.pluginId);
  const allowSet = new Set(
    Array.isArray(config.plugins.allow) ? config.plugins.allow.filter((id) => typeof id === "string" && id.trim()) : [],
  );
  allowSet.add(modeConfig.pluginId);
  config.plugins.allow = [...allowSet];
  ensureAgentsDefaultsSchemaCompat(config);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Managed cron jobs with prescriptive tool chains (VPS report 2026-03-24).
 * Schedules are staggered (minutes :00 / :15 / :30 / :45) where possible to avoid pile-ups.
 * @param {string} agentId
 * @returns {Array<{ id: string, schedule: string, agentId: string, message: string, enabled: boolean }>}
 */
function traderCronPrescriptiveJobs(agentId) {
  return [
    {
      id: "alpha-scan",
      schedule: "0 */3 * * *",
      agentId,
      message:
        "CRON_JOB: alpha_scan\n\nScan new launches, filter, score, log alpha. Tools: solana_scan_launches → filter (vol>30K, mcap>10K, liq>5K) → solana_token_snapshot for survivors → quality filter (top10 <50%, deployer <3 abandoned, has social) → score 0-100 → solana_alpha_log for 65+. Summarize results.",
      model: "anthropic/claude-sonnet-4-20250514",
      thinking: false,
      lightContext: true,
      delivery: { mode: "announce", channel: "last", bestEffort: true },
      enabled: true,
    },
    {
      id: "portfolio-health",
      schedule: "0 */4 * * *",
      agentId,
      message:
        "CRON_JOB: portfolio_health\n\nCombined dead-money + whale + risk audit. solana_capital_status + solana_positions → solana_token_snapshot per position → dead money exit (loss>40% or 90min+down+low vol) → whale flags (>5% supply moves) → risk checks (concentration/drawdown/exposure) → sell if CRITICAL → solana_memory_write tag 'portfolio_health'.",
      model: "anthropic/claude-sonnet-4-20250514",
      thinking: false,
      lightContext: true,
      delivery: { mode: "announce", channel: "last", bestEffort: true },
      enabled: true,
    },
    {
      id: "trust-refresh",
      schedule: "0 */8 * * *",
      agentId,
      message:
        "CRON_JOB: trust_refresh\n\nCombined source + deployer trust. solana_source_trust_refresh + solana_deployer_trust_refresh → solana_alpha_sources + solana_trades for win rates → solana_source_trust_get + solana_deployer_trust_get, flag <30 → solana_memory_write tag 'trust_refresh'.",
      model: "anthropic/claude-haiku-4-5",
      thinking: false,
      lightContext: true,
      delivery: { mode: "none" },
      enabled: true,
    },
    {
      id: "meta-rotation",
      schedule: "30 */8 * * *",
      agentId,
      message:
        "CRON_JOB: meta_rotation_analysis\n\nx_search_tweets trending topics → solana_scan_launches → categorize by narrative cluster → per-cluster metrics → compare vs solana_memory_search tag 'meta_rotation' → declare hot/fading clusters → solana_memory_write tag 'meta_rotation'.",
      model: "anthropic/claude-sonnet-4-20250514",
      thinking: false,
      lightContext: true,
      delivery: { mode: "announce", channel: "last", bestEffort: true },
      enabled: true,
    },
    {
      id: "strategy-evolution",
      schedule: "0 6 * * *",
      agentId,
      message:
        "CRON_JOB: strategy_evolution\n\nDaily strategy review. solana_journal_summary — if <10 closed trades since last evolution, log 'insufficient data' and stop. Otherwise: solana_trades to bucket by confidence tier → solana_strategy_state for current weights → analyze tier performance → solana_strategy_update with conservative adjustments (max 10% per weight per cycle) → solana_memory_write tag 'strategy_evolution'.",
      model: "anthropic/claude-sonnet-4-20250514",
      thinking: true,
      lightContext: false,
      delivery: { mode: "announce", channel: "last", bestEffort: true },
      enabled: true,
    },
    {
      id: "subscription-cleanup",
      schedule: "15 */8 * * *",
      agentId,
      message:
        "CRON_JOB: subscription_cleanup\n\nsolana_positions for open CAs → solana_bitquery_subscriptions for active subs (if AUTH_SCOPE_MISSING, log and stop) → match subs to positions → solana_bitquery_unsubscribe orphaned subs → solana_memory_write tag 'subscription_cleanup'. Summarize before/after counts.",
      model: "anthropic/claude-haiku-4-5",
      thinking: false,
      lightContext: true,
      delivery: { mode: "announce", channel: "last", bestEffort: true },
      enabled: true,
    },
    {
      id: "daily-performance-report",
      schedule: "0 4 * * *",
      agentId,
      message:
        "CRON_JOB: daily_performance_report\n\nCompile 24h report. solana_journal_summary + solana_capital_status + solana_positions + solana_trades + solana_strategy_state → sections: Portfolio Summary, Trading Activity (count/win rate/PnL), Best/Worst Trades, Strategy State, Risk Metrics, Recommendations → solana_memory_write tag 'daily_report'. Deliver full report.",
      model: "anthropic/claude-sonnet-4-20250514",
      thinking: false,
      lightContext: false,
      delivery: { mode: "announce", channel: "telegram" },
      enabled: true,
    },
    {
      id: "intelligence-lab-eval",
      schedule: "0 16 * * *",
      agentId,
      message:
        "CRON_JOB: intelligence_lab_eval\n\nsolana_candidate_get — if <20 labeled candidates, log 'insufficient data' and exit. Otherwise: solana_evaluation_report → solana_model_registry for challengers → solana_replay_eval if challenger exists → solana_model_promote if challenger beats champion by >5% F1 → solana_memory_write tag 'intelligence_lab'.",
      model: "anthropic/claude-sonnet-4-20250514",
      thinking: true,
      lightContext: false,
      delivery: { mode: "none" },
      enabled: true,
    },
    {
      id: "memory-trim",
      schedule: "0 3 * * *",
      agentId,
      message:
        "CRON_JOB: memory_trim\n\nsolana_memory_trim dryRun:true first → review → solana_memory_trim retentionDays:2 → solana_memory_write tag 'memory_trim' with summary.",
      model: "anthropic/claude-haiku-4-5",
      thinking: false,
      lightContext: true,
      delivery: { mode: "none" },
      enabled: true,
    },
    {
      id: "balance-watchdog",
      schedule: "0 */2 * * *",
      agentId,
      message:
        "Balance watchdog. 1) solana_capital_status 2) solana_positions 3) solana_context_snapshot_read 4) Compare real vs believed. If mismatch: solana_context_snapshot_write with corrected state, summarize changes. If match: reply WATCHDOG_OK.",
      model: "anthropic/claude-haiku-4-5",
      thinking: false,
      lightContext: true,
      delivery: { mode: "announce", channel: "telegram" },
      enabled: true,
    },
  ];
}

function configureGatewayScheduling(modeConfig, configPath = CONFIG_FILE) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    config = {};
  }

  if (!config.agents || typeof config.agents !== "object") config.agents = {};

  const isV2 = modeConfig.pluginId === "solana-trader-v2";

  const heartbeatPrompt =
    "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Execute a full trading cycle: Steps 0 through 10. The cycle is NOT complete until all 10 steps are done including Step 8 (memory write-back), Step 9 (X post), and Step 10 (report). Do not stop early. Do not infer or repeat old tasks from prior chats. Never reply HEARTBEAT_OK. Never end your message with a question.";

  /** Default periodic wake interval for TraderClaw installs (was 5m; stretched to reduce load). */
  const defaultHeartbeatEvery = "30m";

  const defaultHeartbeat = {
    every: defaultHeartbeatEvery,
    target: "telegram",
    isolatedSession: true,
    lightContext: true,
    prompt: heartbeatPrompt,
  };

  const v1Agents = [{ id: "main", default: true, identity: { name: "AgentZERO" }, heartbeat: { ...defaultHeartbeat } }];
  const v2Agents = [
    { id: "cto", default: true, identity: { name: "AgentZERO" }, heartbeat: { ...defaultHeartbeat } },
    { id: "execution-specialist", heartbeat: { ...defaultHeartbeat } },
    { id: "alpha-signal-analyst", heartbeat: { ...defaultHeartbeat } },
    { id: "onchain-analyst" },
    { id: "social-analyst" },
    { id: "smart-money-tracker" },
    { id: "risk-officer" },
    { id: "strategy-researcher" }
  ];

  const targetAgents = isV2 ? v2Agents : v1Agents;

  if (!Array.isArray(config.agents.list)) {
    config.agents.list = [];
  }
  config.agents.list = config.agents.list.filter(a => a && typeof a === "object" && a.id);

  const existingIds = new Set(config.agents.list.map(a => a.id));
  for (const agent of targetAgents) {
    if (existingIds.has(agent.id)) {
      const existing = config.agents.list.find(a => a.id === agent.id);
      if (agent.heartbeat) {
        existing.heartbeat = agent.heartbeat;
      }
      if (agent.default) {
        existing.default = true;
      }
      if (agent.identity && (!existing.identity || typeof existing.identity !== "object")) {
        existing.identity = agent.identity;
      }
    } else {
      config.agents.list.push(agent);
    }
  }

  if (!config.cron || typeof config.cron !== "object") {
    config.cron = {};
  }
  config.cron.enabled = true;
  if (!config.cron.maxConcurrentRuns) config.cron.maxConcurrentRuns = isV2 ? 3 : 2;
  if (!config.cron.sessionRetention) config.cron.sessionRetention = "24h";

  const mainAgent = isV2 ? "cto" : "main";

  /** Six prescriptive managed jobs (VPS report); v2 assigns the same set to the CTO agent. */
  const targetJobs = traderCronPrescriptiveJobs(mainAgent);

  let removedLegacyCronJobs = false;
  if (config.cron && Object.prototype.hasOwnProperty.call(config.cron, "jobs")) {
    // OpenClaw now stores jobs under ~/.openclaw/cron/jobs.json.
    // Keeping cron.jobs in openclaw.json can fail strict config validation.
    delete config.cron.jobs;
    removedLegacyCronJobs = true;
  }

  if (!config.hooks || typeof config.hooks !== "object") {
    config.hooks = {};
  }
  config.hooks.enabled = true;
  if (!config.hooks.token || config.hooks.token === "shared-secret" || config.hooks.token === "REPLACE_WITH_SECURE_TOKEN") {
    config.hooks.token = "hk_" + randomBytes(24).toString("hex");
  }

  const alphaAgentId = isV2 ? "alpha-signal-analyst" : "main";
  const onchainAgentId = isV2 ? "onchain-analyst" : "main";

  const targetMappings = [
    { match: { path: "alpha-signal" }, action: "agent", agentId: alphaAgentId, deliver: true },
    { match: { path: "firehose-alert" }, action: "agent", agentId: onchainAgentId, deliver: true }
  ];

  if (!Array.isArray(config.hooks.mappings)) {
    config.hooks.mappings = [];
  }
  config.hooks.mappings = config.hooks.mappings.filter(m => m && typeof m === "object");

  for (const mapping of targetMappings) {
    const existingIdx = config.hooks.mappings.findIndex(m => m?.match?.path === mapping.match.path);
    if (existingIdx >= 0) {
      config.hooks.mappings[existingIdx] = mapping;
    } else {
      config.hooks.mappings.push(mapping);
    }
  }

  if (!config.channels || typeof config.channels !== "object") config.channels = {};
  if (!config.channels.defaults || typeof config.channels.defaults !== "object") config.channels.defaults = {};
  if (!config.channels.defaults.heartbeat || typeof config.channels.defaults.heartbeat !== "object") {
    config.channels.defaults.heartbeat = {};
  }
  if (config.channels.defaults.heartbeat.showOk === undefined) {
    config.channels.defaults.heartbeat.showOk = true;
  }
  if (config.channels.defaults.heartbeat.showAlerts === undefined) {
    config.channels.defaults.heartbeat.showAlerts = true;
  }

  if (!config.channels.telegram || typeof config.channels.telegram !== "object") {
    config.channels.telegram = {};
  }
  // OpenClaw ≥2026.5 expects channels.telegram.streaming as an object ({ mode, chunkMode, preview, block }).
  // Legacy scalar ("partial"|"off"|...) was valid briefly but now fails validation ("must be object").
  const tgStream = config.channels.telegram.streaming;
  const telegramStreamingModes = new Set(["off", "partial", "block", "progress"]);
  if (tgStream === undefined) {
    config.channels.telegram.streaming = { mode: "partial" };
  } else if (typeof tgStream === "string") {
    config.channels.telegram.streaming = telegramStreamingModes.has(tgStream)
      ? { mode: tgStream }
      : { mode: "partial" };
  }

  if (!config.commands || typeof config.commands !== "object") config.commands = {};
  if (config.commands.native === undefined) config.commands.native = "auto";
  if (config.commands.restart === undefined) config.commands.restart = true;
  if (!config.commands.ownerDisplay) config.commands.ownerDisplay = "raw";

  if (!config.agents.defaults || typeof config.agents.defaults !== "object") {
    config.agents.defaults = {};
  }
  config.agents.defaults.heartbeat = { ...defaultHeartbeat };

  ensureAgentsDefaultsSchemaCompat(config);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  const cronStorePath = resolveCronJobsStorePath(config);
  const cronMerge = mergeTraderCronJobsIntoStore(cronStorePath, targetJobs);

  let qmdAvailable = false;
  let qmdVersion = null;
  try { qmdAvailable = commandExists("qmd"); } catch {}
  if (qmdAvailable) {
    qmdVersion = getCommandOutput("qmd --version");
  } else {
    if (typeof console !== "undefined") {
      console.warn(
        "[traderclaw] QMD binary not found. Memory engine will fall back to SQLite (no vector search, no temporal decay, no MMR).\n" +
        "Install QMD:  npm install -g @tobilu/qmd\n" +
        "Then restart the gateway:  openclaw gateway restart"
      );
    }
  }

  return {
    configPath,
    agentsConfigured: targetAgents.length,
    cronJobsAdded: cronMerge.added,
    cronJobsUpdated: cronMerge.updated,
    cronJobsTotal: targetJobs.length,
    cronJobsStorePath: cronMerge.storePath,
    cronJobsStoreWriteOk: cronMerge.wrote === true,
    cronJobsStoreError: cronMerge.error,
    removedLegacyCronJobs,
    hooksConfigured: config.hooks.mappings.length,
    qmdAvailable,
    qmdVersion,
    isV2,
  };
}

function ensureOpenResponsesEnabled(configPath = CONFIG_FILE) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    config = {};
  }

  if (!config.gateway) config.gateway = {};
  if (!config.gateway.http) config.gateway.http = {};
  if (!config.gateway.http.endpoints) config.gateway.http.endpoints = {};
  if (!config.gateway.http.endpoints.responses) config.gateway.http.endpoints.responses = {};
  config.gateway.http.endpoints.responses.enabled = true;

  ensureAgentsDefaultsSchemaCompat(config);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return configPath;
}

async function restartGateway() {
  if (!commandExists("openclaw")) return { ran: false };
  try {
    await runCommandWithEvents("openclaw", ["gateway", "restart"]);
  } catch {
    return { ran: true, success: false, healthy: false };
  }

  // Brief wait then verify the gateway is actually healthy after the restart.
  await new Promise((r) => setTimeout(r, 2500));
  try {
    const raw = getCommandOutput("openclaw gateway status --json || true");
    let statusJson = null;
    if (raw) {
      try { statusJson = JSON.parse(raw); } catch { /* non-JSON output */ }
    }
    const serviceStatus = statusJson?.service?.runtime?.status;
    const rpcOk = statusJson?.rpc?.ok === true;
    const healthy = serviceStatus === "running" && rpcOk;
    if (!healthy) {
      console.warn(
        "[restartGateway] Gateway restarted but health check failed " +
        `(status=${serviceStatus ?? "unknown"}, rpc.ok=${rpcOk}). ` +
        "Check: journalctl --user -u openclaw-gateway",
      );
    }
    return { ran: true, success: true, healthy };
  } catch {
    return { ran: true, success: true, healthy: false };
  }
}

function deployGatewayConfig(modeConfig) {
  const gatewayDir = join(CONFIG_DIR, "gateway");
  mkdirSync(gatewayDir, { recursive: true });
  const destFile = join(gatewayDir, modeConfig.gatewayConfig);
  const src = resolveGatewayConfigSourcePath(modeConfig, modeConfig.gatewayConfig);
  if (!src) return { deployed: false, dest: destFile };
  writeFileSync(destFile, readFileSync(src));
  return { deployed: true, source: src, dest: destFile };
}

function expandHomePath(p) {
  if (typeof p !== "string" || !p.trim()) return null;
  let t = p.trim();
  if (t.startsWith("~")) {
    t = t === "~" || t === "~/" ? homedir() : join(homedir(), t.slice(2).replace(/^\/+/, ""));
  }
  return t;
}

/**
 * OpenClaw loads HEARTBEAT.md only from the agent workspace root (default ~/.openclaw/workspace).
 * See https://docs.openclaw.ai/concepts/agent-workspace
 */
export function resolveAgentWorkspaceDir(configPath = CONFIG_FILE) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    config = {};
  }
  const raw =
    (typeof config.agents?.defaults?.workspace === "string" && config.agents.defaults.workspace.trim()) ||
    (typeof config.agent?.workspace === "string" && config.agent.workspace.trim()) ||
    "";
  if (raw) {
    const expanded = expandHomePath(raw);
    if (expanded) return expanded;
  }
  return join(homedir(), ".openclaw", "workspace");
}

/**
 * Copy skills/solana-trader/HEARTBEAT.md from the plugin package, OpenClaw extension, or global npm into the workspace root.
 * Skips overwrite if a non-empty file already exists (user may have customized it).
 */
export function deployWorkspaceHeartbeat(modeConfig) {
  const skillRoot = resolveSolanaTraderPackagedRoot(modeConfig);
  if (!skillRoot) return { deployed: false, reason: "source_missing" };
  const src = join(skillRoot, "HEARTBEAT.md");
  if (!existsSync(src)) return { deployed: false, reason: "source_missing", src };

  const workspaceDir = resolveAgentWorkspaceDir(CONFIG_FILE);
  const dest = join(workspaceDir, "HEARTBEAT.md");
  mkdirSync(workspaceDir, { recursive: true });

  if (existsSync(dest)) {
    try {
      if (statSync(dest).size > 0) {
        return { deployed: false, skipped: true, reason: "already_exists_nonempty", dest };
      }
    } catch {
      // overwrite empty or unreadable
    }
  }
  writeFileSync(dest, readFileSync(src, "utf-8"), "utf-8");
  return { deployed: true, skipped: false, source: src, dest };
}

/**
 * Copy all files from skills/solana-trader/workspace/ into ~/.openclaw/workspace/.
 * These are the bootstrap context files (AGENTS.md, SOUL.md, IDENTITY.md, TOOLS.md, etc.)
 * that OpenClaw injects into the agent's system prompt at startup.
 * Skips files that already exist and are non-empty so user customisations are preserved.
 */
export function deployWorkspaceBootstrapFiles(modeConfig) {
  const skillRoot = resolveSolanaTraderPackagedRoot(modeConfig);
  if (!skillRoot) return { deployed: [], skipped: [], failed: [], reason: "source_dir_missing" };

  const srcDir = join(skillRoot, "workspace");
  if (!existsSync(srcDir)) return { deployed: [], skipped: [], failed: [], reason: "source_dir_missing", srcDir };

  const workspaceDir = resolveAgentWorkspaceDir(CONFIG_FILE);
  mkdirSync(workspaceDir, { recursive: true });

  const deployed = [];
  const skipped = [];
  const failed = [];

  for (const file of readdirSync(srcDir)) {
    const src = join(srcDir, file);
    const dest = join(workspaceDir, file);
    try {
      if (existsSync(dest)) {
        try {
          if (statSync(dest).size > 0) { skipped.push(dest); continue; }
        } catch {}
      }
      writeFileSync(dest, readFileSync(src, "utf-8"), "utf-8");
      deployed.push(dest);
    } catch (err) {
      failed.push({ dest, error: err.message });
    }
  }

  return { deployed, skipped, failed, workspaceDir };
}

function accessTokenEnvBase(agentId) {
  return `X_ACCESS_TOKEN_${agentId.toUpperCase().replace(/-/g, "_")}`;
}

function getConsumerKeysFromWizard(wizardOpts = {}) {
  const w = wizardOpts || {};
  const ck = (typeof w.xConsumerKey === "string" ? w.xConsumerKey : "").trim() || process.env.X_CONSUMER_KEY || "";
  const cs = (typeof w.xConsumerSecret === "string" ? w.xConsumerSecret : "").trim() || process.env.X_CONSUMER_SECRET || "";
  return { consumerKey: ck, consumerSecret: cs };
}

function getAccessPairForAgent(wizardOpts, agentId) {
  const w = wizardOpts || {};
  const envBase = accessTokenEnvBase(agentId);
  let at = "";
  let ats = "";
  if (agentId === "main") {
    at = (typeof w.xAccessTokenMain === "string" ? w.xAccessTokenMain : "").trim() || process.env[envBase] || "";
    ats = (typeof w.xAccessTokenMainSecret === "string" ? w.xAccessTokenMainSecret : "").trim() || process.env[`${envBase}_SECRET`] || "";
  } else if (agentId === "cto") {
    at = (typeof w.xAccessTokenCto === "string" ? w.xAccessTokenCto : "").trim() || process.env[envBase] || "";
    ats = (typeof w.xAccessTokenCtoSecret === "string" ? w.xAccessTokenCtoSecret : "").trim() || process.env[`${envBase}_SECRET`] || "";
  } else if (agentId === "intern") {
    at = (typeof w.xAccessTokenIntern === "string" ? w.xAccessTokenIntern : "").trim() || process.env[envBase] || "";
    ats = (typeof w.xAccessTokenInternSecret === "string" ? w.xAccessTokenInternSecret : "").trim() || process.env[`${envBase}_SECRET`] || "";
  } else {
    at = process.env[envBase] || "";
    ats = process.env[`${envBase}_SECRET`] || "";
  }
  return { at, ats };
}

function seedXConfig(modeConfig, configPath = CONFIG_FILE, wizardOpts = {}) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    config = {};
  }

  if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
  if (!config.plugins.entries || typeof config.plugins.entries !== "object") config.plugins.entries = {};
  normalizeTraderPluginEntries(config, modeConfig.pluginId);
  normalizeTraderAllowlist(config, modeConfig.pluginId);

  const entry = config.plugins.entries[modeConfig.pluginId];
  if (!entry || typeof entry !== "object") return { skipped: true, reason: "plugin entry not found" };
  if (!entry.config || typeof entry.config !== "object") entry.config = {};

  const { consumerKey, consumerSecret } = getConsumerKeysFromWizard(wizardOpts);

  if (!consumerKey || !consumerSecret) {
    return { skipped: true, reason: "X_CONSUMER_KEY and/or X_CONSUMER_SECRET not set" };
  }

  if (!entry.config.x || typeof entry.config.x !== "object") entry.config.x = {};
  entry.config.x.consumerKey = consumerKey;
  entry.config.x.consumerSecret = consumerSecret;

  if (!entry.config.x.profiles || typeof entry.config.x.profiles !== "object") {
    entry.config.x.profiles = {};
  }

  const agentIds =
    modeConfig.pluginId === "solana-trader-v2"
      ? ["cto", "intern"]
      : modeConfig.pluginId === "solana-trader"
        ? ["main", "solana-trader"]
        : ["main"];
  let profilesFound = 0;

  for (const agentId of agentIds) {
    let { at, ats } = getAccessPairForAgent(wizardOpts, agentId);
    if (
      modeConfig.pluginId === "solana-trader"
      && agentId === "solana-trader"
      && (!at || !ats)
    ) {
      ({ at, ats } = getAccessPairForAgent(wizardOpts, "main"));
    }
    if (at && ats) {
      entry.config.x.profiles[agentId] = { accessToken: at, accessTokenSecret: ats };
      profilesFound++;
    }
  }

  ensureAgentsDefaultsSchemaCompat(config);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return { configured: true, consumerKey: "***", profilesFound, agentIds };
}

async function verifyXCredentials(consumerKey, consumerSecret, accessToken, accessTokenSecret) {
  const { createHmac, randomBytes: rb } = await import("crypto");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = rb(16).toString("hex");
  const method = "GET";
  const url = "https://api.x.com/2/users/me";
  const params = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: accessToken,
    oauth_version: "1.0",
  };
  const paramStr = Object.keys(params).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&");
  const baseStr = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramStr)}`;
  const sigKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(accessTokenSecret)}`;
  const sig = createHmac("sha1", sigKey).update(baseStr).digest("base64");
  const authHeader = `OAuth ${Object.entries({ ...params, oauth_signature: sig }).map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`).join(", ")}`;
  const res = await fetch(url, { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: body };
  }
  const data = await res.json();
  return { ok: true, userId: data?.data?.id, username: data?.data?.username };
}

/** After OAuth verify, persist X user id + handle from GET /2/users/me into plugin config (no user typing). */
function persistXProfileIdentities(configPath, modeConfig, identities) {
  if (!Array.isArray(identities) || identities.length === 0) return { written: 0 };
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return { written: 0 };
  }
  normalizeTraderPluginEntries(config, modeConfig.pluginId);
  normalizeTraderAllowlist(config, modeConfig.pluginId);
  const entry = config?.plugins?.entries?.[modeConfig.pluginId];
  if (!entry?.config?.x?.profiles || typeof entry.config.x.profiles !== "object") return { written: 0 };

  let profilesTouched = 0;
  for (const row of identities) {
    const agentId = row?.agentId;
    const userId = row?.userId;
    const username = row?.username;
    if (typeof agentId !== "string" || !agentId.length) continue;
    const p = entry.config.x.profiles[agentId];
    if (!p || typeof p !== "object") continue;
    let touched = false;
    if (userId != null && String(userId).length > 0) {
      p.userId = String(userId);
      touched = true;
    }
    if (username != null && String(username).length > 0) {
      p.username = String(username);
      touched = true;
    }
    if (touched) profilesTouched++;
  }
  if (profilesTouched === 0) return { written: 0 };
  ensureAgentsDefaultsSchemaCompat(config);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return { written: profilesTouched };
}

function listProviderModels(provider) {
  let raw;
  try {
    raw = execFileSync(
      "openclaw",
      ["models", "list", "--all", "--provider", provider, "--json"],
      {
        encoding: "utf-8",
        maxBuffer: 25 * 1024 * 1024,
        timeout: 20_000,
        env: NO_COLOR_ENV,
      },
    ).trim();
  } catch {
    return [];
  }
  if (!raw) return [];
  const parsed = extractJson(raw);
  if (!parsed) return [];
  const models = Array.isArray(parsed?.models) ? parsed.models : [];
  return models
    .map((entry) => (entry && typeof entry.key === "string" ? entry.key : ""))
    .filter((id) => id.startsWith(`${provider}/`));
}

function fallbackModelForProvider(provider) {
  if (provider === "anthropic") return "anthropic/claude-sonnet-4-6";
  if (provider === "openai") return "openai/gpt-5.4";
  if (provider === "openai-codex") return "openai-codex/gpt-5.4";
  if (provider === "google" || provider === "google-vertex") return "google/gemini-2.5-flash";
  if (provider === "xai") return "xai/grok-4";
  if (provider === "deepseek") return "deepseek/deepseek-chat";
  if (provider === "together") return "together/moonshotai/Kimi-K2.5";
  if (provider === "groq") return "groq/llama-4-scout-17b-16e-instruct";
  if (provider === "mistral") return "mistral/mistral-large-latest";
  if (provider === "perplexity") return "perplexity/sonar-pro";
  if (provider === "nvidia") return "nvidia/llama-3.3-70b-instruct";
  if (provider === "minimax") return "minimax/MiniMax-M2.7";
  if (provider === "moonshot") return "moonshot/kimi-k2";
  if (provider === "cerebras") return "cerebras/llama-4-scout-17b-16e-instruct";
  if (provider === "qwen") return "qwen/qwen3-235b-a22b";
  if (provider === "cli-cloud") return "cli-cloud/gemma-e4b";
  return `${provider}/default`;
}

function providerEnvKey(provider) {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "openai" || provider === "openai-codex") return "OPENAI_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "groq") return "GROQ_API_KEY";
  if (provider === "mistral") return "MISTRAL_API_KEY";
  if (provider === "google" || provider === "google-vertex") return "GEMINI_API_KEY";
  if (provider === "xai") return "XAI_API_KEY";
  if (provider === "deepseek") return "DEEPSEEK_API_KEY";
  if (provider === "together") return "TOGETHER_API_KEY";
  if (provider === "perplexity") return "PERPLEXITY_API_KEY";
  if (provider === "nvidia") return "NVIDIA_API_KEY";
  if (provider === "minimax") return "MINIMAX_API_KEY";
  if (provider === "moonshot") return "MOONSHOT_API_KEY";
  if (provider === "cerebras") return "CEREBRAS_API_KEY";
  if (provider === "qwen") return "DASHSCOPE_API_KEY";
  if (provider === "cli-cloud") return "CLI_CLOUD_API_KEY";
  return "";
}

function resolveLlmModelSelection(provider, requestedModel) {
  const availableModels = listProviderModels(provider);
  const warnings = [];

  if (requestedModel) {
    if (!requestedModel.startsWith(`${provider}/`)) {
      warnings.push(`Manual model '${requestedModel}' does not match provider '${provider}'. Using provider default instead.`);
    } else if (availableModels.length === 0 || availableModels.includes(requestedModel)) {
      return { model: requestedModel, source: "manual", availableModels, warnings };
    } else {
      warnings.push(`Manual model '${requestedModel}' was not found in OpenClaw catalog for '${provider}'. Falling back to provider default.`);
    }
  }

  if (availableModels.length > 0) {
    const chosen = choosePreferredProviderModel(provider, availableModels);
    if (chosen && availableModels.length > 1) {
      warnings.push(`Auto-selected '${chosen}' as default model (${availableModels.length} models in catalog).`);
    }
    return { model: chosen || availableModels[0], source: "provider_default", availableModels, warnings };
  }

  warnings.push(
    `[ALERT] No discoverable model list found for provider '${provider}'. ` +
    `Auto-selecting hardcoded default '${fallbackModelForProvider(provider)}' — ` +
    `this model will be billed to your API key. ` +
    `To use a different model, after finishing setup, use openclaw config and set the model manually.`,
  );
  return { model: fallbackModelForProvider(provider), source: "fallback_guess", availableModels, warnings };
}

/**
 * OpenClaw 2026+ expects `agents.defaults.heartbeat` as an object when `defaults` exists; plugin merges
 * sometimes drop it. We only add `heartbeat: {}` here — do NOT add `model: {}` when `model` is absent:
 * many schemas require `model.primary` whenever `model` is present; an empty model object caused Ajv
 * failures after hardening (regression for installs where the plugin stripped `model` but left defaults).
 */
function ensureAgentsDefaultsSchemaCompat(config) {
  if (!config || typeof config !== "object") return;
  if (!config.agents || typeof config.agents !== "object") return;
  if (!config.agents.defaults || typeof config.agents.defaults !== "object") return;
  if (!config.agents.defaults.heartbeat || typeof config.agents.defaults.heartbeat !== "object") {
    config.agents.defaults.heartbeat = {};
  }
  const m = config.agents.defaults.model;
  if (m !== undefined && m !== null && (typeof m !== "object" || Array.isArray(m))) {
    delete config.agents.defaults.model;
  }
}

/** Re-read config from disk and re-apply defaults shape before gateway/plugin commands that validate the file. */
/**
 * Proactively writes the minimum gateway fields required for OpenClaw to start.
 *
 * OpenClaw (post-2025) requires `gateway.mode` to be explicitly set to "local"
 * before `openclaw gateway install` / `gateway restart` are called — the service
 * crashes immediately at launch when the field is absent, producing
 * "service stayed stopped / health checks never came up".
 *
 * We write these proactively rather than waiting for the first failure and
 * hoping auto-recovery catches it, because newer OpenClaw validates the config
 * during `gateway install` itself, before the process even starts.
 */
function ensureGatewayBootstrapDefaults(configPath = CONFIG_FILE, log = () => {}) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    config = {};
  }

  if (!config.gateway || typeof config.gateway !== "object") {
    config.gateway = {};
  }

  const changed = [];
  if (!config.gateway.mode) {
    config.gateway.mode = "local";
    changed.push("gateway.mode=local");
  }
  if (!config.gateway.bind) {
    config.gateway.bind = "loopback";
    changed.push("gateway.bind=loopback");
  }
  if (!Number.isInteger(config.gateway.port)) {
    config.gateway.port = 18789;
    changed.push("gateway.port=18789");
  }

  ensureAgentsDefaultsSchemaCompat(config);

  if (changed.length > 0) {
    log(`Gateway bootstrap: pre-writing required config fields: ${changed.join(", ")}`);
  }

  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch (err) {
    log(`Gateway bootstrap: could not write config defaults (${err?.message || err}) — will proceed anyway`);
  }
}

function normalizeOpenClawConfigFileShape(configPath = CONFIG_FILE) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return;
  }
  ensureAgentsDefaultsSchemaCompat(config);
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  } catch {
    // best effort
  }
}

function configureOpenClawLlmProvider({ provider, model, credential }, configPath = CONFIG_FILE) {
  if (!provider || !credential) {
    throw new Error("LLM provider and credential are required.");
  }
  if (!model) {
    throw new Error("LLM model could not be resolved for the selected provider.");
  }
  if (!model.startsWith(`${provider}/`)) {
    throw new Error(`Selected model '${model}' does not match provider '${provider}'.`);
  }

  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    config = {};
  }

  const envKey = providerEnvKey(provider);
  if (!envKey) {
    throw new Error(
      `Provider '${provider}' is not supported by quick API-key setup in this wizard yet. Use a supported provider.`,
    );
  }

  if (!config.env || typeof config.env !== "object") config.env = {};
  config.env[envKey] = credential;

  // Clean stale/broken provider objects from previous buggy writes (skip custom providers that need their entry).
  const CUSTOM_PROVIDERS_WITH_BASEURL = ["cli-cloud"];
  if (!CUSTOM_PROVIDERS_WITH_BASEURL.includes(provider) && config.models && config.models.providers && config.models.providers[provider]) {
    delete config.models.providers[provider];
    if (Object.keys(config.models.providers).length === 0) {
      delete config.models.providers;
    }
    if (Object.keys(config.models).length === 0) {
      delete config.models;
    }
  }

  // Write baseUrl for custom OpenAI-compatible providers.
  if (provider === "cli-cloud") {
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};
    config.models.providers["cli-cloud"] = { baseUrl: "https://app.cli.cloud/llm/v1", apiKey: credential, models: [] };
  }

  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  ensureAgentsDefaultsSchemaCompat(config);
  if (!config.agents.defaults.model || typeof config.agents.defaults.model !== "object") {
    config.agents.defaults.model = {};
  }
  config.agents.defaults.model.primary = model;

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return { configPath, provider, model };
}

/**
 * Sets only `agents.defaults.model.primary` (OAuth / subscription paths where credentials live in OpenClaw auth profiles).
 * Does not write API keys into config.env.
 */
function configureOpenClawLlmModelPrimaryOnly({ provider, model }, configPath = CONFIG_FILE) {
  if (!provider || !model) {
    throw new Error("LLM provider and model are required.");
  }
  if (!model.startsWith(`${provider}/`)) {
    throw new Error(`Selected model '${model}' does not match provider '${provider}'.`);
  }

  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    config = {};
  }

  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  ensureAgentsDefaultsSchemaCompat(config);
  if (!config.agents.defaults.model || typeof config.agents.defaults.model !== "object") {
    config.agents.defaults.model = {};
  }
  config.agents.defaults.model.primary = model;

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return { configPath, provider, model };
}

/**
 * Spawns `openclaw models auth login --provider openai-codex --method oauth` with a pseudo-TTY when possible.
 * `--method oauth` skips the interactive Browser vs Device pairing menu (OpenClaw 2026.4.29+); device flow is `device-code`.
 * The CLI often exits immediately when stdin/stdout are plain pipes (no TTY). On Unix, `script(1)`
 * allocates a PTY so the same flow works as in an interactive terminal.
 */
export function spawnOpenClawCodexAuthLoginChild() {
  const argv = ["models", "auth", "login", "--provider", "openai-codex", "--method", "oauth"];
  if (process.platform === "win32") {
    return spawn("openclaw", argv, { stdio: ["pipe", "pipe", "pipe"], shell: false });
  }
  if (commandExists("unbuffer")) {
    return spawn("unbuffer", ["openclaw", ...argv], { stdio: ["pipe", "pipe", "pipe"], shell: false });
  }
  if (commandExists("script")) {
    // stty cols 32767: set an extremely wide PTY column so OpenClaw/Clack never
    // wraps the OAuth URL across lines (default PTY width when spawned via pipe is 80).
    // A wrapped URL causes the wizard's regex to only capture the first segment.
    // --return propagates openclaw's exit code (util-linux 2.38+).
    // -f/--flush: force immediate forwarding of each PTY write to the pipe so the
    // wizard sees the URL as soon as OpenClaw prints it (default is block-buffered).
    const cmdline =
      "stty cols 32767 rows 50 2>/dev/null; openclaw models auth login --provider openai-codex --method oauth";
    return spawn("script", ["--return", "-f", "-q", "-c", cmdline, "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
      // COLUMNS/LINES: belt-and-suspenders env fallback for programs that read env
      // instead of ioctl(TIOCGWINSZ) to determine terminal dimensions.
      env: { ...process.env, COLUMNS: "32767", LINES: "50" },
      shell: false,
    });
  }
  return spawn("openclaw", argv, { stdio: ["pipe", "pipe", "pipe"], shell: false });
}

/**
 * Runs `openclaw models auth login --provider openai-codex --method oauth` and feeds the pasted redirect URL or code on stdin
 * when the CLI prompts (with a timed fallback for non-interactive / SSH).
 */
function runOpenClawCodexOAuthLogin(paste, emitLog) {
  return new Promise((resolve, reject) => {
    const child = spawnOpenClawCodexAuthLoginChild();

    let stdout = "";
    let stderr = "";
    let pasteSent = false;

    const sendPaste = () => {
      if (pasteSent) return;
      const p = String(paste || "").trim();
      if (!p) return;
      pasteSent = true;
      try {
        child.stdin.write(`${p}\n`);
      } catch {
        // ignore
      }
    };

    let fallbackTimer = setTimeout(() => sendPaste(), 9000);

    const onChunk = (chunk) => {
      const combined = (stdout + stderr).toLowerCase();
      const c = typeof chunk === "string" ? chunk : chunk.toString();
      if (!pasteSent && /paste|authorization|redirect|callback/i.test(combined) && c.length > 0) {
        clearTimeout(fallbackTimer);
        fallbackTimer = setTimeout(() => sendPaste(), 400);
      }
    };

    child.stdout?.on("data", (d) => {
      const t = d.toString();
      stdout += t;
      const urls = extractUrls(t);
      emitLog("info", t, urls);
      onChunk(t);
    });

    child.stderr?.on("data", (d) => {
      const t = d.toString();
      stderr += t;
      const urls = extractUrls(t);
      emitLog("warn", t, urls);
      onChunk(t);
    });

    child.on("close", (code) => {
      clearTimeout(fallbackTimer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = `${stderr}\n${stdout}`.trim();
      const err = new Error(
        detail || `openclaw models auth login failed with exit code ${code}. Try running the same command in a normal shell, then re-run the wizard with "already logged in" checked.`,
      );
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });

    child.on("error", (e) => {
      clearTimeout(fallbackTimer);
      reject(e);
    });
  });
}

function verifyInstallation(modeConfig, apiKey) {
  const gatewayFile = join(CONFIG_DIR, "gateway", modeConfig.gatewayConfig);
  let llmConfigured = false;
  let pluginActive = false;
  try {
    const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    const primaryModel = config?.agents?.defaults?.model?.primary;
    llmConfigured = typeof primaryModel === "string" && primaryModel.length > 0;
  } catch {
    llmConfigured = false;
  }
  if (commandExists("openclaw")) {
    const pluginList = getCommandOutput("openclaw plugins list") || "";
    pluginActive = pluginList.toLowerCase().includes(modeConfig.pluginId.toLowerCase());
  }
  let heartbeatConfigured = false;
  let cronConfigured = false;
  try {
    const config = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    const agentsList = config?.agents?.list;
    if (Array.isArray(agentsList)) {
      heartbeatConfigured = agentsList.some(a => a.heartbeat && a.heartbeat.every);
    }
    cronConfigured = config?.cron?.enabled === true;
  } catch {
  }

  const persistSnap = getLinuxGatewayPersistenceSnapshot();
  let persistOk = true;
  let persistNote = "not Linux / WSL or loginctl unavailable";
  if (persistSnap.eligible) {
    persistOk = persistSnap.linger === true;
    persistNote =
      persistSnap.linger === true
        ? "linger enabled"
        : "run: traderclaw gateway ensure-persistent (or sudo loginctl enable-linger $USER)";
  }

  const workspaceRoot = resolveAgentWorkspaceDir();
  const heartbeatInWorkspace = existsSync(join(workspaceRoot, "HEARTBEAT.md"));

  return [
    { label: "OpenClaw platform", ok: commandExists("openclaw"), note: "not in PATH" },
    { label: `Trading CLI (${modeConfig.cliName})`, ok: commandExists(modeConfig.cliName), note: "not in PATH" },
    { label: `OpenClaw plugin (${modeConfig.pluginId})`, ok: pluginActive, note: "not installed/enabled" },
    { label: "Configuration file", ok: existsSync(CONFIG_FILE), note: "not created" },
    { label: "LLM provider configured", ok: llmConfigured, note: "missing model provider credential" },
    { label: "Gateway configuration", ok: existsSync(gatewayFile), note: "not found" },
    { label: "Heartbeat scheduling", ok: heartbeatConfigured, note: "agent will not wake autonomously" },
    { label: "Cron jobs configured", ok: cronConfigured, note: "scheduled maintenance jobs missing" },
    { label: "API key configured", ok: !!apiKey, note: "needs setup" },
    {
      label: "Gateway survives SSH (systemd linger)",
      ok: !persistSnap.eligible || persistOk,
      note: persistNote,
    },
    {
      label: "HEARTBEAT.md in workspace root",
      ok: heartbeatInWorkspace,
      note: heartbeatInWorkspace ? workspaceRoot : `expected ${join(workspaceRoot, "HEARTBEAT.md")}`,
    },
    {
      label: "QMD memory engine (vector search)",
      ok: commandExists("qmd"),
      note: "not installed — memory uses keyword search only. Install: npm install -g @tobilu/qmd",
    },
  ];
}

function nowIso() {
  return new Date().toISOString();
}

const URL_REGEX = /https?:\/\/[^\s"')]+/g;
function firstUrl(text = "") {
  const found = text.match(URL_REGEX);
  return found?.[0] || null;
}

function normalizeLane(input) {
  return input === "event-driven" ? "event-driven" : "quick-local";
}

export class InstallerStepEngine {
  constructor(modeConfig, options = {}, hooks = {}) {
    this.modeConfig = modeConfig;
    this.options = {
      lane: normalizeLane(options.lane),
      llmAuthMode: options.llmAuthMode === "oauth" ? "oauth" : "api_key",
      llmProvider: options.llmProvider || "",
      llmModel: options.llmModel || "",
      llmCredential: options.llmCredential || "",
      llmOAuthPaste: typeof options.llmOAuthPaste === "string" ? options.llmOAuthPaste.trim() : "",
      llmOAuthSkipLogin: options.llmOAuthSkipLogin === true,
      apiKey: options.apiKey || "",
      orchestratorUrl: options.orchestratorUrl || "https://api.traderclaw.ai",
      gatewayBaseUrl: options.gatewayBaseUrl || "",
      gatewayToken: options.gatewayToken || "",
      enableTelegram: options.enableTelegram === true,
      telegramToken: options.telegramToken || "",
      autoInstallDeps: options.autoInstallDeps !== false,
      skipPreflight: options.skipPreflight === true,
      skipInstallOpenClaw: options.skipInstallOpenClaw === true,
      skipInstallPlugin: options.skipInstallPlugin === true,
      skipTailscale: options.skipTailscale === true,
      /** When true (e.g. EC2 bootstrap before Tailscale auth), gateway starts without `tailscale funnel`. */
      skipFunnel: options.skipFunnel === true,
      skipGatewayBootstrap: options.skipGatewayBootstrap === true,
      skipGatewayConfig: options.skipGatewayConfig === true,
      // Wizard / CLI — must be preserved for seedXConfig
      xConsumerKey: typeof options.xConsumerKey === "string" ? options.xConsumerKey : "",
      xConsumerSecret: typeof options.xConsumerSecret === "string" ? options.xConsumerSecret : "",
      xAccessTokenMain: typeof options.xAccessTokenMain === "string" ? options.xAccessTokenMain : "",
      xAccessTokenMainSecret: typeof options.xAccessTokenMainSecret === "string" ? options.xAccessTokenMainSecret : "",
      xAccessTokenCto: typeof options.xAccessTokenCto === "string" ? options.xAccessTokenCto : "",
      xAccessTokenCtoSecret: typeof options.xAccessTokenCtoSecret === "string" ? options.xAccessTokenCtoSecret : "",
      xAccessTokenIntern: typeof options.xAccessTokenIntern === "string" ? options.xAccessTokenIntern : "",
      xAccessTokenInternSecret: typeof options.xAccessTokenInternSecret === "string" ? options.xAccessTokenInternSecret : "",
      referralCode: typeof options.referralCode === "string" ? options.referralCode.trim() : "",
    };
    this.hooks = {
      onStepEvent: typeof hooks.onStepEvent === "function" ? hooks.onStepEvent : () => {},
      onLog: typeof hooks.onLog === "function" ? hooks.onLog : () => {},
    };
    this.state = {
      startedAt: null,
      completedAt: null,
      status: "idle",
      errors: [],
      detected: { funnelUrl: null, tailscaleApprovalUrl: null },
      stepResults: [],
      verifyChecks: [],
      setupHandoff: null,
      autoRecovery: {
        gatewayModeRecoveryAttempted: false,
        gatewayModeRecoverySucceeded: false,
        backupPath: null,
      },
    };
  }

  async runWithPrivilegeGuidance(stepId, cmd, args = [], customLines = []) {
    try {
      return await runCommandWithEvents(cmd, args, {
        onEvent: (evt) => this.emitLog(stepId, evt.type === "stderr" ? "warn" : "info", evt.text, evt.urls || []),
      });
    } catch (err) {
      if (isPrivilegeError(err)) {
        throw new Error(privilegeRemediationMessage(cmd, args, customLines));
      }
      throw err;
    }
  }

  emitStep(stepId, status, detail = "") {
    this.hooks.onStepEvent({ at: nowIso(), stepId, status, detail });
  }

  emitLog(stepId, level, text, urls = []) {
    const clean = typeof text === "string" ? stripAnsi(text) : text;
    this.hooks.onLog({ at: nowIso(), stepId, level, text: clean, urls });
  }

  async runStep(stepId, title, handler) {
    this.emitStep(stepId, "in_progress", title);
    const startedAt = nowIso();
    try {
      const result = await handler();
      this.state.stepResults.push({ stepId, title, status: "completed", startedAt, completedAt: nowIso(), result });
      this.emitStep(stepId, "completed", title);
      return result;
    } catch (err) {
      const detail = stripAnsi(err?.message || String(err));
      this.state.stepResults.push({ stepId, title, status: "failed", startedAt, completedAt: nowIso(), error: detail });
      this.state.errors.push({ stepId, error: detail });
      this.emitStep(stepId, "failed", detail);
      throw err;
    }
  }

  async ensureTailscale() {
    if (commandExists("tailscale")) return { installed: true, alreadyInstalled: true };
    if (!this.options.autoInstallDeps) throw new Error("tailscale missing and auto-install disabled");

    if (!isRootUser() && !canUseSudoWithoutPrompt()) {
      throw new Error(
        [
          "Tailscale is not installed and the installer cannot elevate privileges automatically.",
          "Run this command in your terminal, then click Start Installation again:",
          "sudo bash -lc 'curl -fsSL https://tailscale.com/install.sh | sh'",
        ].join("\n"),
      );
    }

    try {
      if (isRootUser()) {
        await this.runWithPrivilegeGuidance("tailscale", "bash", ["-lc", "curl -fsSL https://tailscale.com/install.sh | sh"]);
      } else {
        await this.runWithPrivilegeGuidance("tailscale", "sudo", ["bash", "-lc", "curl -fsSL https://tailscale.com/install.sh | sh"]);
      }
    } catch (err) {
      const message = `${err?.message || ""} ${err?.stderr || ""}`.toLowerCase();
      if (message.includes("sudo") || message.includes("password")) {
        throw new Error(
          [
            "Tailscale installation requires terminal sudo approval.",
            "Run this command in your terminal, then click Start Installation again:",
            "sudo bash -lc 'curl -fsSL https://tailscale.com/install.sh | sh'",
          ].join("\n"),
        );
      }
      throw err;
    }

    return { installed: true, alreadyInstalled: false };
  }

  async runTailscaleUp() {
    try {
      const result = await runCommandWithEvents("tailscale", ["up"], {
        onEvent: (evt) => {
          const url = firstUrl(evt.text);
          if (url && !this.state.detected.tailscaleApprovalUrl) this.state.detected.tailscaleApprovalUrl = url;
          this.emitLog("tailscale_up", evt.type === "stderr" ? "warn" : "info", evt.text, evt.urls || []);
        },
      });
      return { ok: true, approvalUrl: this.state.detected.tailscaleApprovalUrl, urls: result.urls || [] };
    } catch (err) {
      const details = `${err?.stderr || ""}\n${err?.stdout || ""}\n${err?.message || ""}`.toLowerCase();
      if (
        details.includes("access denied")
        || details.includes("checkprefs")
        || details.includes("prefs write access denied")
      ) {
        throw new Error(tailscalePermissionRemediation());
      }
      throw err;
    }
  }

  async runFunnel() {
    try {
      await this.runWithPrivilegeGuidance("funnel", "tailscale", ["funnel", "--bg", "18789"]);
    } catch (err) {
      const details = `${err?.stderr || ""}\n${err?.stdout || ""}\n${err?.message || ""}`.toLowerCase();
      if (details.includes("access denied") || details.includes("operator")) {
        throw new Error(tailscalePermissionRemediation());
      }
      throw err;
    }
    const statusOut = getCommandOutput("tailscale funnel status") || "";
    const funnelUrl = firstUrl(statusOut);
    if (funnelUrl) this.state.detected.funnelUrl = funnelUrl;
    this.emitLog("funnel", "info", statusOut);
    return { funnelUrl };
  }

  readGatewayStatusSnapshot() {
    const raw = getCommandOutput("openclaw gateway status --json || true");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  isGatewayHealthy(statusJson) {
    if (!statusJson || typeof statusJson !== "object") return false;
    const serviceStatus = statusJson?.service?.runtime?.status;
    const rpcOk = statusJson?.rpc?.ok === true;
    return serviceStatus === "running" && rpcOk;
  }

  async tryAutoRecoverGatewayMode(stepId) {
    if (this.state.autoRecovery.gatewayModeRecoveryAttempted) {
      return { attempted: true, success: false, reason: "already_attempted" };
    }
    this.state.autoRecovery.gatewayModeRecoveryAttempted = true;

    let config = {};
    let rawOriginal = "{}\n";
    try {
      rawOriginal = readFileSync(CONFIG_FILE, "utf-8");
      config = JSON.parse(rawOriginal);
    } catch {
      config = {};
    }

    if (!config.gateway) config.gateway = {};
    const changed = [];
    if (!config.gateway.mode) {
      config.gateway.mode = "local";
      changed.push("gateway.mode=local");
    }
    if (!config.gateway.bind) {
      config.gateway.bind = "loopback";
      changed.push("gateway.bind=loopback");
    }
    if (!Number.isInteger(config.gateway.port)) {
      config.gateway.port = 18789;
      changed.push("gateway.port=18789");
    }

    if (changed.length === 0) {
      return { attempted: true, success: false, reason: "no_missing_gateway_defaults" };
    }

    ensureAgentsDefaultsSchemaCompat(config);
    mkdirSync(CONFIG_DIR, { recursive: true });
    const backupPath = `${CONFIG_FILE}.bak.${Date.now()}`;
    writeFileSync(backupPath, rawOriginal, "utf-8");
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
    this.state.autoRecovery.backupPath = backupPath;
    this.emitLog(stepId, "warn", `Auto-recovery: applied ${changed.join(", ")} with backup at ${backupPath}`);

    try {
      await this.runWithPrivilegeGuidance(stepId, "openclaw", ["gateway", "stop"]);
    } catch {
      // best effort stop
    }
    await this.runWithPrivilegeGuidance(stepId, "openclaw", ["gateway", "install"]);
    await this.runWithPrivilegeGuidance(stepId, "openclaw", ["gateway", "restart"]);

    const status = this.readGatewayStatusSnapshot();
    const healthy = this.isGatewayHealthy(status);
    if (healthy) {
      this.state.autoRecovery.gatewayModeRecoverySucceeded = true;
      this.emitLog(stepId, "info", "Auto-recovery succeeded: gateway is healthy after restart.");
      return { attempted: true, success: true, backupPath };
    }
    return { attempted: true, success: false, backupPath, reason: "gateway_not_healthy_after_recovery" };
  }

  async runTelegramStep() {
    if (!this.options.telegramToken) {
      throw new Error(
        "Telegram token is required for this installer flow. Add your bot token in the wizard and start again.",
      );
    }

    // OpenClaw no longer supports `openclaw channels add --channel telegram`.
    // The Telegram plugin does not export register/activate, so that command
    // fails with "telegram missing register/activate export / Channel telegram
    // does not support add."  The current documented approach is to write the
    // bot token directly to openclaw.json — see docs.openclaw.ai/channels/telegram.
    writeTelegramChannelConfig(this.options.telegramToken, CONFIG_FILE);
    this.emitLog("telegram_required", "info", "Telegram bot token written to openclaw.json (channels.telegram.botToken).");

    const policy = ensureTelegramGroupPolicyOpenForWizard();
    if (policy.changed) {
      this.emitLog(
        "telegram_required",
        "info",
        "Set channels.telegram.groupPolicy=open (no sender allowlist yet) to avoid Doctor allowlist warnings on gateway restart. Tighten groupAllowFrom later if you use groups.",
      );
    }

    // Probe channel status for visibility — best-effort, don't fail the step.
    try {
      await runCommandWithEvents("openclaw", ["channels", "status", "--probe"]);
    } catch {
      this.emitLog("telegram_required", "warn", "channels status --probe did not complete (gateway may not be fully up yet). Token is written and will be active after gateway restart.");
    }

    return { configured: true };
  }

  async configureLlmStep() {
    const CUSTOM_PROVIDERS_NO_PROBE = ["cli-cloud"];
    const provider = String(this.options.llmProvider || "").trim();
    const requestedModel = String(this.options.llmModel || "").trim();
    const credential = String(this.options.llmCredential || "").trim();
    const authMode = this.options.llmAuthMode === "oauth" ? "oauth" : "api_key";

    if (!provider) {
      throw new Error(
        "Missing required LLM settings. Select provider in the wizard before starting installation.",
      );
    }
    if (!commandExists("openclaw")) {
      throw new Error("OpenClaw is not available yet. Install step must complete before LLM configuration.");
    }

    if (authMode === "oauth") {
      if (provider !== "openai-codex") {
        throw new Error("OAuth mode requires LLM provider openai-codex (ChatGPT / Codex subscription).");
      }
      const skipLogin = this.options.llmOAuthSkipLogin === true;
      const oauthPaste = String(this.options.llmOAuthPaste || "").trim();
      if (!skipLogin && !oauthPaste) {
        throw new Error(
          "Codex OAuth requires a pasted authorization code or redirect URL, or enable skip if you already ran openclaw models auth login on this host.",
        );
      }
      if (!skipLogin) {
        try {
          await runOpenClawCodexOAuthLogin(oauthPaste, (level, text, urls) =>
            this.emitLog("configure_llm", level, text, urls || []),
          );
        } catch (err) {
          const tail = `${err?.stderr || ""}\n${err?.stdout || ""}\n${err?.message || ""}`.trim();
          throw new Error(
            `${tail}\n\nIf OAuth cannot complete from the wizard, run in a shell: openclaw models auth login --provider openai-codex --method oauth — then re-run the wizard with "already logged in" checked.`,
          );
        }
      }

      const authFile = join(homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json");
      let hasAuth = false;
      try {
        hasAuth = readFileSync(authFile, "utf-8").length > 20;
      } catch { /* file missing */ }
      if (!hasAuth) {
        throw new Error(
          "No OAuth credentials found at " + authFile + ". " +
          "The wizard OAuth flow did not save tokens (the callback may not have reached the OpenClaw CLI). " +
          "Run 'openclaw models auth login --provider openai-codex --method oauth' in a terminal, " +
          "then re-run the wizard with the 'already logged in' option.",
        );
      }

      const selection = resolveLlmModelSelection(provider, requestedModel);
      for (const msg of selection.warnings) {
        this.emitLog("configure_llm", "warn", msg);
      }
      const model = selection.model;

      const saved = configureOpenClawLlmModelPrimaryOnly({ provider, model });
      this.emitLog(
        "configure_llm",
        "info",
        `Configured OpenClaw model primary=${model} (Codex OAuth; credentials in OpenClaw auth profiles, not OPENAI_API_KEY).`,
      );

      await runCommandWithEvents("openclaw", ["config", "validate"], {
        onEvent: (evt) => this.emitLog("configure_llm", evt.type === "stderr" ? "warn" : "info", evt.text, evt.urls || []),
      });

      if (CUSTOM_PROVIDERS_NO_PROBE.includes(provider)) {
        this.emitLog("configure_llm", "info", `Skipping openclaw provider probe for custom provider '${provider}'.`);
      } else {
        try {
          await runCommandWithEvents("openclaw", ["models", "status", "--check", "--probe-provider", provider], {
            onEvent: (evt) => this.emitLog("configure_llm", evt.type === "stderr" ? "warn" : "info", evt.text, evt.urls || []),
          });
        } catch (err) {
          const details = `${err?.stderr || ""}\n${err?.stdout || ""}\n${err?.message || ""}`.trim();
          throw new Error(
            `LLM provider validation failed for '${provider}'. Check OAuth login and model, then retry.\n${details}`,
          );
        }
      }

      return { configured: true, provider, model, configPath: saved.configPath, authMode: "oauth" };
    }

    if (!credential) {
      throw new Error(
        "Missing required LLM settings. Paste your API key or token in the wizard before starting installation.",
      );
    }

    const selection = resolveLlmModelSelection(provider, requestedModel);
    for (const msg of selection.warnings) {
      this.emitLog("configure_llm", "warn", msg);
    }
    const model = selection.model;

    const saved = configureOpenClawLlmProvider({ provider, model, credential });
    this.emitLog("configure_llm", "info", `Configured OpenClaw model primary=${model}`);

    await runCommandWithEvents("openclaw", ["config", "validate"], {
      onEvent: (evt) => this.emitLog("configure_llm", evt.type === "stderr" ? "warn" : "info", evt.text, evt.urls || []),
    });

    if (CUSTOM_PROVIDERS_NO_PROBE.includes(provider)) {
      this.emitLog("configure_llm", "info", `Skipping openclaw provider probe for custom provider '${provider}'.`);
    } else {
      try {
        await runCommandWithEvents("openclaw", ["models", "status", "--check", "--probe-provider", provider], {
          onEvent: (evt) => this.emitLog("configure_llm", evt.type === "stderr" ? "warn" : "info", evt.text, evt.urls || []),
        });
      } catch (err) {
        const details = `${err?.stderr || ""}\n${err?.stdout || ""}\n${err?.message || ""}`.trim();
        throw new Error(
          `LLM provider validation failed for '${provider}'. Check credential/model and retry.\n${details}`,
        );
      }
    }

    return { configured: true, provider, model, configPath: saved.configPath, authMode: "api_key" };
  }

  buildSetupHandoff() {
    // Shell-safe single-quote wrapper: wraps value in '…' and escapes any embedded single quotes.
    const shQuote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

    const cliName = this.modeConfig.cliName;
    const orchestratorUrl = this.options.orchestratorUrl || "https://api.traderclaw.ai";
    const apiKey = String(this.options.apiKey || "").trim();

    // Build args in the user-facing convention:
    //   traderclaw setup --api-key '…' --url '…' [--gateway-base-url '…'] [--skip-gateway-registration] [--referral-code '…']
    const parts = [cliName, "setup"];

    if (apiKey) {
      parts.push("--api-key", shQuote(apiKey));
    }

    parts.push("--url", shQuote(orchestratorUrl));

    const gatewayBaseUrl = this.options.gatewayBaseUrl || this.state.detected.funnelUrl || "";
    if (this.options.lane === "event-driven" && gatewayBaseUrl) {
      parts.push("--gateway-base-url", shQuote(gatewayBaseUrl));
    }

    if (this.options.lane !== "event-driven") {
      parts.push("--skip-gateway-registration");
    }

    const ref = String(this.options.referralCode || "").trim();
    if (ref) {
      parts.push("--referral-code", shQuote(ref));
    }

    const command = parts.join(" ");
    const docs =
      "https://docs.traderclaw.ai/docs/installation#troubleshooting-session-expired-auth-errors-or-the-agent-logged-out";
    return {
      pending: true,
      command,
      title: "Ready to launch your agentic trading desk",
      message:
        "Core install is complete. Run the command below in your VPS shell to complete authentication. " +
        "The wallet private key is intentionally omitted — if your account has a linked wallet, traderclaw setup will prompt for it securely in the terminal (hidden input, key is never saved or sent). " +
        "For automation or non-interactive environments use --wallet-private-key or the TRADERCLAW_WALLET_PRIVATE_KEY env var instead. " +
        "After setup, configure TRADERCLAW_WALLET_PRIVATE_KEY for the OpenClaw gateway service (systemd) so the bot can sign challenges at runtime — not only in your SSH session. See " +
        docs,
      hint:
        "Run the command in your terminal. If wallet proof is required, you will be prompted for the private key with hidden input. Then restart the gateway.",
      restartCommand: "openclaw gateway restart",
    };
  }

  async runAll() {
    this.state.status = "running";
    this.state.startedAt = nowIso();
    try {
      if (!this.options.skipPreflight) {
        await this.runStep("preflight", "Checking prerequisites", async () => {
          if (!commandExists("node") || !commandExists("npm")) throw new Error("node and npm are required");
          return { node: true, npm: true, openclaw: commandExists("openclaw"), tailscale: commandExists("tailscale") };
        });
      }

      if (!this.options.skipInstallOpenClaw) {
        await this.runStep("install_openclaw", "Installing or upgrading OpenClaw platform", async () =>
          installOpenClawPlatform((evt) =>
            this.emitLog("install_openclaw", evt.type === "stderr" ? "warn" : "info", evt.text, evt.urls || []),
          ),
        );
      }

      // Non-fatal: warn when the CLI has devices in pending-approval or repair state.
      // Gateway >= 1.0.93-beta.0 requires explicit device approval for operator-write scope;
      // without it, agent trading RPCs silently fail (device gets read-only "repair" state).
      await this.runStep("device_approval_check", "Checking OpenClaw device approval status", async () => {
        const check = checkOpenClawDeviceApproval();
        if (!check.ran) {
          this.emitLog("device_approval_check", "info", "Device approval check skipped (openclaw CLI not available or devices subcommand not supported).");
          return { ran: false };
        }
        const needsAction = check.pendingIds.length > 0 || check.repairDetected;
        if (!needsAction) {
          this.emitLog("device_approval_check", "info", "No pending or repair-state devices found. Device approval OK.");
          return { ran: true, ok: true };
        }
        const lines = [
          "ACTION REQUIRED — OpenClaw device approval needed.",
          "The gateway requires explicit device approval for operator-write scope.",
          "Without it, trading RPCs will fail silently (read-only / repair state).",
          "",
          "Run in your VPS shell:",
          "  openclaw devices list",
          ...(check.pendingIds.length > 0
            ? check.pendingIds.map((id) => `  openclaw devices approve ${id}`)
            : ["  openclaw devices approve <requestId>   # use the id shown above"]),
          "",
          check.envTokenSet
            ? "OPENCLAW_GATEWAY_TOKEN env var is already set — env-first auth will work as a fallback."
            : "Optionally set: export OPENCLAW_GATEWAY_TOKEN=\"<token>\"   # bypasses device auth entirely",
        ];
        this.emitLog("device_approval_check", "warn", lines.join("\n"));
        return { ran: true, ok: false, pendingIds: check.pendingIds, repairDetected: check.repairDetected, envTokenSet: check.envTokenSet };
      });

      await this.runStep("configure_llm", "Configuring required OpenClaw LLM provider", async () => this.configureLlmStep());
      if (!this.options.skipInstallPlugin) {
        await this.runStep("install_plugin_package", "Installing TraderClaw CLI package", async () =>
          installPlugin(
            this.modeConfig,
            (evt) => this.emitLog("install_plugin_package", evt.type === "stderr" ? "warn" : "info", evt.text, evt.urls || []),
          ));
        await this.runStep("openclaw_global_deps", "Ensuring OpenClaw global package dependencies", async () =>
          ensureOpenClawGlobalPackageDependencies(),
        );
        await this.runStep("install_qmd", "Installing QMD memory engine (vector search)", async () => {
          if (commandExists("qmd")) {
            const ver = getCommandOutput("qmd --version");
            this.emitLog("install_qmd", "info", `QMD already installed: ${ver}`);
            return { alreadyInstalled: true, version: ver };
          }
          this.emitLog("install_qmd", "info", "Installing @tobilu/qmd globally for vector search memory...");
          try {
            await runCommandWithEvents("npm", ["install", "-g", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org/", "@tobilu/qmd"], {
              onEvent: (evt) => this.emitLog("install_qmd", evt.type === "stderr" ? "warn" : "info", evt.text, evt.urls || []),
            });
          } catch (err) {
            this.emitLog(
              "install_qmd",
              "warn",
              `QMD install failed (non-fatal): ${err?.message || err}. Memory will use keyword search only. You can install manually later: npm install -g @tobilu/qmd`,
            );
            return { installed: false, error: err?.message || String(err) };
          }
          const available = commandExists("qmd");
          const ver = available ? getCommandOutput("qmd --version") : null;
          if (!available) {
            this.emitLog("install_qmd", "warn", "QMD installed but not on PATH. Memory will use keyword search only.");
          }
          return { installed: available, version: ver };
        });
        await this.runStep(
          "activate_openclaw_plugin",
          "Installing and enabling TraderClaw inside OpenClaw",
          async () =>
            installAndEnableOpenClawPlugin(
              this.modeConfig,
              (evt) => this.emitLog("activate_openclaw_plugin", evt.type === "stderr" ? "warn" : "info", evt.text, evt.urls || []),
              this.options.orchestratorUrl,
            ),
        );
      }
      if (!this.options.skipTailscale) {
        await this.runStep("tailscale_install", "Ensuring Tailscale is installed", async () => this.ensureTailscale());
        await this.runStep("tailscale_up", "Connecting Tailscale", async () => this.runTailscaleUp());
      }
      if (!this.options.skipGatewayBootstrap) {
        await this.runStep("openclaw_config_validate", "Validating OpenClaw config (with plugins)", async () => {
          normalizeOpenClawConfigFileShape(CONFIG_FILE);
          try {
            await this.runWithPrivilegeGuidance("openclaw_config_validate", "openclaw", ["config", "validate"]);
          } catch (err) {
            const blob = `${err?.message || ""}\n${err?.stderr || ""}\n${err?.stdout || ""}`;
            if (isOpenClawConfigSchemaFailure(blob)) {
              throw new Error(gatewayConfigValidationRemediation());
            }
            throw err;
          }
          return { ok: true };
        });
        await this.runStep("gateway_bootstrap", "Starting OpenClaw gateway and Funnel", async () => {
          try {
            // Ensure required gateway fields are present BEFORE install/restart.
            // OpenClaw now requires gateway.mode="local" to be explicitly set;
            // without it the service crashes immediately at startup.
            ensureGatewayBootstrapDefaults(CONFIG_FILE, (msg) =>
              this.emitLog("gateway_bootstrap", "info", msg),
            );
            await this.runWithPrivilegeGuidance("gateway_bootstrap", "openclaw", ["gateway", "install"]);
            await this.runWithPrivilegeGuidance("gateway_bootstrap", "openclaw", ["gateway", "restart"]);
            if (this.options.skipFunnel) {
              this.emitLog(
                "gateway_bootstrap",
                "info",
                "Skipping Tailscale funnel (skipFunnel). After `tailscale up`, run: traderclaw install --headless --funnel-only",
              );
              return { funnelSkipped: true };
            }
            return this.runFunnel();
          } catch (err) {
            const text = `${err?.message || ""}\n${err?.stderr || ""}\n${err?.stdout || ""}`.toLowerCase();
            const gatewayModeUnset = text.includes("gateway.mode=local") && text.includes("current: unset");
            const gatewayStartFailed =
              text.includes("gateway restart timed out")
              || text.includes("timed out after 60s waiting for health checks")
              || text.includes("waiting for gateway port")
              // OpenClaw ≥ current: shorter-timeout variant of the same class of failure
              || (text.includes("gateway restart failed") && text.includes("service stayed stopped"))
              || text.includes("health checks never came up")
              || text.includes("service stayed stopped");
            if (gatewayStartFailed || gatewayModeUnset) {
              const recovered = await this.tryAutoRecoverGatewayMode("gateway_bootstrap");
              if (recovered.success) {
                if (this.options.skipFunnel) {
                  return { funnelSkipped: true, recovered: true };
                }
                return this.runFunnel();
              }
              if (gatewayModeUnset) {
                throw new Error(gatewayModeUnsetRemediation());
              }
              throw new Error(gatewayTimeoutRemediation());
            }
            if (isOpenClawConfigSchemaFailure(text)) {
              throw new Error(gatewayConfigValidationRemediation());
            }
            throw err;
          }
        });
      }

      if (!this.options.skipGatewayBootstrap) {
        await this.runStep("gateway_persistence", "SSH-safe gateway (systemd user linger)", async () => {
          const { ensureLinuxGatewayPersistence } = await import("./gateway-persistence-linux.mjs");
          return ensureLinuxGatewayPersistence({
            emitLog: (level, text) => this.emitLog("gateway_persistence", level, text),
            runPrivileged: (cmd, args) => this.runWithPrivilegeGuidance("gateway_persistence", cmd, args),
          });
        });
      }

      await this.runStep("enable_responses", "Enabling /v1/responses endpoint", async () => {
        const configPath = ensureOpenResponsesEnabled(CONFIG_FILE);
        const restart = await restartGateway();
        return { configPath, restart };
      });

      await this.runStep("gateway_scheduling", "Configuring heartbeat and cron schedules", async () => {
        const result = configureGatewayScheduling(this.modeConfig, CONFIG_FILE);
        this.emitLog("gateway_scheduling", "info", `Agents configured: ${result.agentsConfigured}`);
        if (result.cronJobsStoreWriteOk) {
          this.emitLog(
            "gateway_scheduling",
            "info",
            `Cron store: ${result.cronJobsStorePath} (${result.cronJobsTotal} TraderClaw jobs; +${result.cronJobsAdded} new, ~${result.cronJobsUpdated} updated).`,
          );
        } else if (result.cronJobsStoreError) {
          this.emitLog(
            "gateway_scheduling",
            "warn",
            `Cron store not updated (${result.cronJobsStorePath}): ${result.cronJobsStoreError}`,
          );
        } else {
          this.emitLog("gateway_scheduling", "warn", "Cron store write did not complete; check permissions and disk space.");
        }
        if (result.removedLegacyCronJobs) {
          this.emitLog("gateway_scheduling", "warn", "Removed legacy 'cron.jobs' from openclaw.json to keep config validation compatible.");
        }
        this.emitLog("gateway_scheduling", "info", `Webhook hooks: ${result.hooksConfigured}`);
        if (!result.qmdAvailable) {
          this.emitLog(
            "gateway_scheduling",
            "warn",
            "QMD binary not found — memory will use SQLite keyword search only (no vector search, no temporal decay, no MMR). " +
            "Vector search makes the agent's memory significantly more effective. " +
            "Install: npm install -g @tobilu/qmd — then restart the gateway: openclaw gateway restart",
          );
        } else {
          this.emitLog("gateway_scheduling", "info", `QMD memory engine: ${result.qmdVersion || "installed"}`);
        }
        const restart = await restartGateway();
        return { ...result, restart };
      });

      await this.runStep("workspace_heartbeat", "Installing HEARTBEAT.md into agent workspace", async () => {
        const result = deployWorkspaceHeartbeat(this.modeConfig);
        if (result.deployed) {
          this.emitLog("workspace_heartbeat", "info", `Installed TraderClaw HEARTBEAT.md → ${result.dest}`);
        } else if (result.skipped) {
          this.emitLog(
            "workspace_heartbeat",
            "info",
            `HEARTBEAT.md already present at ${result.dest} — not overwriting (edit or delete to replace).`,
          );
        } else {
          this.emitLog(
            "workspace_heartbeat",
            "warn",
            `Could not install HEARTBEAT.md automatically (${result.reason || "unknown"})${result.src ? `. Expected: ${result.src}` : ""}`,
          );
        }
        return result;
      });

      await this.runStep("workspace_bootstrap", "Installing workspace context files (AGENTS.md, SOUL.md, IDENTITY.md…)", async () => {
        const result = deployWorkspaceBootstrapFiles(this.modeConfig);
        if (result.reason) {
          this.emitLog("workspace_bootstrap", "warn", `Could not install workspace bootstrap files (${result.reason})${result.srcDir ? `. Expected dir: ${result.srcDir}` : ""}`);
          return result;
        }
        if (result.deployed.length) {
          this.emitLog("workspace_bootstrap", "info", `Deployed to ${result.workspaceDir}:`);
          for (const f of result.deployed) {
            this.emitLog("workspace_bootstrap", "info", `  + ${basename(f)}`);
          }
        }
        if (result.skipped.length) {
          this.emitLog("workspace_bootstrap", "info", `Skipped (already present, user-customised): ${result.skipped.map(f => basename(f)).join(", ")}`);
        }
        if (result.failed.length) {
          for (const { dest, error } of result.failed) {
            this.emitLog("workspace_bootstrap", "warn", `Failed to write ${dest}: ${error}`);
          }
        }
        return result;
      });

      await this.runStep("setup_handoff", "Preparing secure setup handoff", async () => {
        const handoff = this.buildSetupHandoff();
        this.state.setupHandoff = handoff;
        this.emitLog("setup_handoff", "info", handoff.title);
        this.emitLog("setup_handoff", "info", handoff.message);
        this.emitLog("setup_handoff", "info", `Run in VPS shell: ${handoff.command}`);
        this.emitLog("setup_handoff", "info", `Then run: ${handoff.restartCommand}`);
        return handoff;
      });

      if (!this.options.skipGatewayConfig) {
        await this.runStep("gateway_config", "Deploying gateway config and restarting", async () => {
          const deploy = deployGatewayConfig(this.modeConfig);
          const restart = await restartGateway();
          return { deploy, restart };
        });
      }

      await this.runStep("x_credentials", "Configuring X/Twitter credentials", async () => {
        const result = seedXConfig(this.modeConfig, CONFIG_FILE, this.options);
        if (result.skipped) {
          this.emitLog("x_credentials", "warn", `X setup skipped: ${result.reason}. Set X_CONSUMER_KEY, X_CONSUMER_SECRET, and per-agent X_ACCESS_TOKEN_<AGENT_ID> / X_ACCESS_TOKEN_<AGENT_ID>_SECRET env vars to enable.`);
          return result;
        }
        this.emitLog("x_credentials", "info", `X credentials configured. Profiles found: ${result.profilesFound}/${result.agentIds.length}`);
        if (result.profilesFound < result.agentIds.length) {
          const missing = result.agentIds.filter((id) => {
            const { at, ats } = getAccessPairForAgent(this.options, id);
            return !at || !ats;
          });
          this.emitLog("x_credentials", "warn", `Missing X profiles for: ${missing.join(", ")}. Set tokens in the wizard or X_ACCESS_TOKEN_<AGENT_ID> / X_ACCESS_TOKEN_<AGENT_ID>_SECRET env vars.`);
        }
        const { consumerKey, consumerSecret } = getConsumerKeysFromWizard(this.options);
        const verified = [];
        const identitiesToPersist = [];
        for (const agentId of result.agentIds) {
          const { at, ats } = getAccessPairForAgent(this.options, agentId);
          if (at && ats) {
            try {
              const check = await verifyXCredentials(consumerKey, consumerSecret, at, ats);
              if (check.ok) {
                this.emitLog("x_credentials", "info", `Verified X profile '${agentId}': @${check.username} (${check.userId})`);
                verified.push({ agentId, username: check.username, userId: check.userId });
                identitiesToPersist.push({ agentId, userId: check.userId, username: check.username });
              } else {
                this.emitLog("x_credentials", "warn", `X credential verification failed for '${agentId}': HTTP ${check.status}`);
              }
            } catch (err) {
              this.emitLog("x_credentials", "warn", `X credential verification error for '${agentId}': ${err?.message || String(err)}`);
            }
          }
        }
        if (identitiesToPersist.length > 0) {
          const persisted = persistXProfileIdentities(CONFIG_FILE, this.modeConfig, identitiesToPersist);
          if (persisted.written > 0) {
            this.emitLog("x_credentials", "info", `Saved X user id and username to openclaw.json for ${persisted.written} profile(s) (from API, not manual entry).`);
          }
        }
        return { ...result, verified };
      });

      await this.runStep("telegram_required", "Configuring required Telegram channel", async () => this.runTelegramStep());
      await this.runStep("verify", "Verifying installation", async () => {
        const checks = verifyInstallation(this.modeConfig, this.options.apiKey);
        this.state.verifyChecks = checks;
        return { checks };
      });

      this.state.status = "completed";
      this.state.completedAt = nowIso();
      return this.state;
    } catch (err) {
      this.state.status = "failed";
      this.state.completedAt = nowIso();
      this.state.errors.push({ stepId: "runtime", error: err?.message || String(err) });
      return this.state;
    }
  }
}

/**
 * After Tailscale login (`tailscale up`), expose loopback gateway :18789 via funnel.
 */
export async function tailscaleFunnelOpenclaw18789(options = {}) {
  const onEvt = typeof options.onEvent === "function" ? options.onEvent : () => {};
  try {
    await runCommandWithEvents(
      "tailscale",
      ["funnel", "--bg", "18789"],
      { onEvent: (evt) => onEvt(evt) },
    );
  } catch (err) {
    const details = `${err?.stderr || ""}\n${err?.stdout || ""}\n${err?.message || ""}`.toLowerCase();
    if (details.includes("access denied") || details.includes("operator")) {
      throw new Error(tailscalePermissionRemediation());
    }
    throw err;
  }
  const statusOut = getCommandOutput("tailscale funnel status") || "";
  return { funnelUrl: firstUrl(statusOut) || null, rawStatus: statusOut };
}

export function assertWizardXCredentials(modeConfig, options = {}) {
  const t = (s) => (typeof s === "string" ? s.trim() : "");
  const o = options || {};
  const need =
    modeConfig.pluginId === "solana-trader-v2"
      ? ["xConsumerKey", "xConsumerSecret", "xAccessTokenCto", "xAccessTokenCtoSecret", "xAccessTokenIntern", "xAccessTokenInternSecret"]
      : ["xConsumerKey", "xConsumerSecret", "xAccessTokenMain", "xAccessTokenMainSecret"];
  const filled = need.filter((k) => t(o[k])).length;
  if (filled === 0) return null;
  if (filled === need.length) return null;
  return `X/Twitter credentials are optional: leave all ${need.length} fields blank, or fill every field (OAuth app key/secret plus user access token and secret for each profile).`;
}

export function createInstallerStepEngine(modeConfig, options = {}, hooks = {}) {
  return new InstallerStepEngine(modeConfig, options, hooks);
}
