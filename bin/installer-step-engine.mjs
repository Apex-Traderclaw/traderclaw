import { execSync, spawn } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { choosePreferredProviderModel } from "./llm-model-preference.mjs";
import { getLinuxGatewayPersistenceSnapshot } from "./gateway-persistence-linux.mjs";

const CONFIG_DIR = join(homedir(), ".openclaw");
const CONFIG_FILE = join(CONFIG_DIR, "openclaw.json");

/** Directory containing this package when running from a git checkout or global npm install. */
const PLUGIN_PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function resolvePluginInstallSpec(modeConfig) {
  const manifest = join(PLUGIN_PACKAGE_ROOT, "openclaw.plugin.json");
  const pkgJson = join(PLUGIN_PACKAGE_ROOT, "package.json");
  if (existsSync(manifest) && existsSync(pkgJson)) {
    return PLUGIN_PACKAGE_ROOT;
  }
  return modeConfig.pluginPackage;
}

/** Older `plugins.entries` keys / npm-era ids to merge orchestrator URL for. */
const LEGACY_TRADER_PLUGIN_IDS = ["traderclaw-v1", "solana-traderclaw-v1", "solana-trader"];

function stripAnsi(text) {
  if (typeof text !== "string") return text;
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * OpenClaw defaults Telegram to groupPolicy "allowlist" with empty groupAllowFrom, so Doctor warns on
 * every gateway restart and group messages are dropped. Wizard onboarding targets DMs first; set
 * explicit "open" unless the user already configured sender allowlists.
 */
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

function getCommandOutput(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], shell: true }).trim();
  } catch {
    return null;
  }
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
    "Gateway bootstrap timed out waiting for health checks.",
    "Run these commands in terminal, then click Start Installation again:",
    "1) openclaw gateway status --json || true",
    "2) openclaw gateway probe || true",
    "3) openclaw gateway stop || true",
    "4) openclaw gateway install",
    "5) openclaw gateway restart",
    "6) openclaw gateway status --json",
    "7) tailscale funnel --bg 18789",
    "8) tailscale funnel status",
    "If gateway still fails on a low-memory VM, add swap or use a larger staging size (>=2GB RAM recommended).",
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

function runCommandWithEvents(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "pipe",
      shell: true,
      ...opts,
    });

    let stdout = "";
    let stderr = "";
    const onEvent = typeof opts.onEvent === "function" ? opts.onEvent : null;
    const emit = (event) => onEvent && onEvent(event);

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
      const urls = [...new Set([...extractUrls(stdout), ...extractUrls(stderr)])];
      if (code === 0) resolve({ stdout, stderr, code, urls });
      else {
        const raw = (stderr || "").trim();
        const tailLines = raw.split("\n").filter((l) => l.length > 0).slice(-40).join("\n");
        const stderrPreview = tailLines.length > 8000 ? tailLines.slice(-8000) : tailLines;
        const err = new Error(stderrPreview ? `command failed with exit code ${code}: ${stderrPreview}` : `command failed with exit code ${code}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        err.urls = urls;
        reject(err);
      }
    });
    child.on("error", reject);
  });
}

async function installOpenClawPlatform() {
  if (commandExists("openclaw")) {
    return { alreadyInstalled: true, version: getCommandOutput("openclaw --version") };
  }
  await runCommandWithEvents("npm", ["install", "-g", "openclaw"]);
  return { alreadyInstalled: false, installed: true, available: commandExists("openclaw") };
}

function isNpmGlobalBinConflict(err, cliName) {
  const text = `${err?.message || ""}\n${err?.stderr || ""}\n${err?.stdout || ""}`.toLowerCase();
  return (
    text.includes("eexist")
    && text.includes("/usr/bin/")
    && text.includes(String(cliName || "").toLowerCase())
  );
}

async function installPlugin(modeConfig, onEvent) {
  const spec = resolvePluginInstallSpec(modeConfig);
  if (spec !== modeConfig.pluginPackage && typeof onEvent === "function") {
    onEvent({
      type: "stdout",
      text: `Installing TraderClaw CLI from local package path (not on npm registry): ${spec}\n`,
      urls: [],
    });
  }
  try {
    await runCommandWithEvents("npm", ["install", "-g", spec], { onEvent });
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
    await runCommandWithEvents("npm", ["install", "-g", "--force", spec], { onEvent });
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

  const pluginInstallSpec = resolvePluginInstallSpec(modeConfig);
  let recoveredExistingDir = null;
  try {
    await runCommandWithEvents("openclaw", ["plugins", "install", pluginInstallSpec], { onEvent });
  } catch (err) {
    if (!isPluginAlreadyExistsError(err, modeConfig.pluginId)) {
      throw err;
    }
    recoveredExistingDir = backupExistingPluginDir(modeConfig.pluginId, onEvent);
    if (!recoveredExistingDir) {
      throw err;
    }
    await runCommandWithEvents("openclaw", ["plugins", "install", pluginInstallSpec], { onEvent });
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
  for (const legacyId of LEGACY_TRADER_PLUGIN_IDS) {
    if (entries[legacyId]) mergeOrchestratorForId(legacyId);
  }

  // Do not set plugins.allow here: OpenClaw validates allow[] against the plugin registry, and
  // the id is not registered until after `openclaw plugins install`. Pre-seeding allow caused:
  // "plugins.allow: plugin not found: <id>".

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
  return {
    id: def.id,
    name: nameFromId.length <= 60 ? nameFromId : nameFromId.slice(0, 59) + "…",
    enabled: def.enabled !== false,
    schedule: { kind: "cron", expr: def.schedule },
    sessionTarget: "isolated",
    wakeMode: "now",
    agentId: def.agentId,
    payload: {
      kind: "agentTurn",
      message: def.message,
      lightContext: true,
    },
    // OpenClaw: "none" = no channel post; announce + last = summary to user's last chat (see OpenClaw cron delivery docs)
    delivery: { mode: "announce", channel: "last", bestEffort: true },
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
  const allowSet = new Set(
    Array.isArray(config.plugins.allow) ? config.plugins.allow.filter((id) => typeof id === "string" && id.trim()) : [],
  );
  allowSet.add(modeConfig.pluginId);
  config.plugins.allow = [...allowSet];
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
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
    "Read HEARTBEAT.md (workspace context). Follow it strictly — execute the full trading cycle and report results to the user. Do NOT reply HEARTBEAT_OK. Always produce a visible summary of what you checked and did.";

  /** Default periodic wake interval for TraderClaw installs (was 5m; stretched to reduce load). */
  const defaultHeartbeatEvery = "30m";

  const v1Agents = [
    { id: "main", default: true, heartbeat: { every: defaultHeartbeatEvery, target: "last", prompt: heartbeatPrompt } }
  ];
  const v2Agents = [
    { id: "cto", default: true, heartbeat: { every: defaultHeartbeatEvery, target: "last", prompt: heartbeatPrompt } },
    { id: "execution-specialist", heartbeat: { every: defaultHeartbeatEvery, target: "last", prompt: heartbeatPrompt } },
    { id: "alpha-signal-analyst", heartbeat: { every: defaultHeartbeatEvery, target: "last", prompt: heartbeatPrompt } },
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

  const v1Jobs = [
    { id: "strategy-evolution", schedule: "0 */4 * * *", agentId: mainAgent, message: "CRON_JOB: strategy_evolution — Review trade journal, compute weight adjustments, update strategy. Only update if sufficient closed trades have accumulated.", enabled: true },
    { id: "source-reputation", schedule: "0 */3 * * *", agentId: mainAgent, message: "CRON_JOB: source_reputation_recalc — Analyze which alpha signal sources led to wins vs losses. Update reputation tracking in memory.", enabled: true },
    { id: "risk-audit", schedule: "0 */2 * * *", agentId: mainAgent, message: "CRON_JOB: portfolio_risk_audit — Portfolio stress tests, exposure checks, correlation analysis, drawdown monitoring.", enabled: true },
    { id: "meta-rotation", schedule: "30 */3 * * *", agentId: mainAgent, message: "CRON_JOB: meta_rotation_analysis — Analyze narrative clusters across recent scans and trades. Identify hot vs cooling metas. Write observations to memory.", enabled: true },
    { id: "dead-money-sweep", schedule: "0 */2 * * *", agentId: mainAgent, message: "CRON_JOB: dead_money_sweep — Check all open LOCAL_MANAGED positions for dead money. Exit stale positions. Tag as dead_money.", enabled: true },
    { id: "subscription-cleanup", schedule: "0 * * * *", agentId: mainAgent, message: "CRON_JOB: subscription_cleanup — Check active Bitquery subscriptions. Unsubscribe from streams no longer needed (sold tokens, closed positions).", enabled: true },
    { id: "daily-report", schedule: "0 4 * * *", agentId: mainAgent, message: "CRON_JOB: daily_performance_report — Calculate daily PnL, aggregate win/loss stats, source reputation summary, write comprehensive memory entry.", enabled: true },
    { id: "whale-watch", schedule: "0 */2 * * *", agentId: mainAgent, message: "CRON_JOB: whale_activity_scan — Scan for large wallet movements, deployer activity, and accumulation patterns across watched tokens.", enabled: true }
  ];

  const v2ExtraJobs = [
    { id: "whale-watch", schedule: "0 */2 * * *", agentId: "smart-money-tracker", message: "CRON_JOB: whale_activity_scan — Scan for large wallet movements, deployer activity, accumulation patterns. Detect smart money consensus and fresh wallet surges.", enabled: true },
    { id: "sentiment-trend", schedule: "0 */4 * * *", agentId: "social-analyst", message: "CRON_JOB: sentiment_trend_analysis — Analyze Twitter/X trending tokens, influencer clustering, mention velocity, narrative exhaustion signals. Write to memory.", enabled: true },
    { id: "execution-health", schedule: "0 */6 * * *", agentId: "execution-specialist", message: "CRON_JOB: execution_health_review — Review recent trade executions for slippage patterns, timing efficiency, failed transactions. Report execution quality metrics.", enabled: true },
    { id: "source-reputation", schedule: "0 */3 * * *", agentId: "alpha-signal-analyst", message: "CRON_JOB: source_reputation_recalc — Analyze which alpha signal sources led to wins vs losses. Update reputation tracking in memory.", enabled: true },
    { id: "risk-audit", schedule: "0 */2 * * *", agentId: "risk-officer", message: "CRON_JOB: portfolio_risk_audit — Portfolio stress tests, exposure checks, correlation analysis, drawdown monitoring. Produce risk report for CTO.", enabled: true },
    { id: "strategy-evolution", schedule: "0 */4 * * *", agentId: "strategy-researcher", message: "CRON_JOB: strategy_evolution — Review trade journal, compute weight adjustments, update strategy. Only update if sufficient closed trades have accumulated.", enabled: true },
    { id: "meta-rotation", schedule: "30 */3 * * *", agentId: "onchain-analyst", message: "CRON_JOB: meta_rotation_analysis — Analyze narrative clusters across recent scans and trades. Identify hot vs cooling metas. Write observations to memory.", enabled: true }
  ];

  const targetJobs = isV2
    ? [...v1Jobs.filter(j => j.id === "dead-money-sweep" || j.id === "subscription-cleanup" || j.id === "daily-report"), ...v2ExtraJobs]
    : v1Jobs;

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

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

  const cronStorePath = resolveCronJobsStorePath(config);
  const cronMerge = mergeTraderCronJobsIntoStore(cronStorePath, targetJobs);

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

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return configPath;
}

async function restartGateway() {
  if (!commandExists("openclaw")) return { ran: false };
  try {
    await runCommandWithEvents("openclaw", ["gateway", "restart"]);
    return { ran: true, success: true };
  } catch {
    return { ran: true, success: false };
  }
}

function deployGatewayConfig(modeConfig) {
  const gatewayDir = join(CONFIG_DIR, "gateway");
  mkdirSync(gatewayDir, { recursive: true });
  const destFile = join(gatewayDir, modeConfig.gatewayConfig);
  const npmRoot = getCommandOutput("npm root -g");
  if (!npmRoot) return { deployed: false, dest: destFile };
  const spec = resolvePluginInstallSpec(modeConfig);
  const src = join(npmRoot, spec, "config", modeConfig.gatewayConfig);
  if (!existsSync(src)) return { deployed: false, dest: destFile };
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
 * Copy skills/solana-trader/HEARTBEAT.md from the globally installed npm package into the workspace root.
 * Skips overwrite if a non-empty file already exists (user may have customized it).
 */
export function deployWorkspaceHeartbeat(modeConfig) {
  const npmRoot = getCommandOutput("npm root -g");
  if (!npmRoot) return { deployed: false, reason: "npm_root_g_failed" };
  const spec = resolvePluginInstallSpec(modeConfig);
  const src = join(npmRoot, spec, "skills", "solana-trader", "HEARTBEAT.md");
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

  const agentIds = modeConfig.pluginId === "solana-trader-v2"
    ? ["cto", "intern"]
    : ["main"];
  let profilesFound = 0;

  for (const agentId of agentIds) {
    const { at, ats } = getAccessPairForAgent(wizardOpts, agentId);
    if (at && ats) {
      entry.config.x.profiles[agentId] = { accessToken: at, accessTokenSecret: ats };
      profilesFound++;
    }
  }

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

function listProviderModels(provider) {
  const cmd = `openclaw models list --all --provider ${shellQuote(provider)} --json`;
  const raw = getCommandOutput(cmd);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    return models
      .map((entry) => (entry && typeof entry.key === "string" ? entry.key : ""))
      .filter((id) => id.startsWith(`${provider}/`));
  } catch {
    return [];
  }
}

function fallbackModelForProvider(provider) {
  // When `openclaw models list` fails, use current API ids (verify vs provider docs periodically).
  if (provider === "anthropic") return "anthropic/claude-sonnet-4-6";
  if (provider === "openai") return "openai/gpt-5.4";
  if (provider === "openai-codex") return "openai-codex/gpt-5.4";
  if (provider === "google" || provider === "google-vertex") return "google/gemini-2.5-flash";
  return `${provider}/default`;
}

function providerEnvKey(provider) {
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "openai" || provider === "openai-codex") return "OPENAI_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  if (provider === "groq") return "GROQ_API_KEY";
  if (provider === "mistral") return "MISTRAL_API_KEY";
  if (provider === "google" || provider === "google-vertex") return "GEMINI_API_KEY";
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

  warnings.push(`No discoverable model list found for provider '${provider}'. Falling back to '${fallbackModelForProvider(provider)}'.`);
  return { model: fallbackModelForProvider(provider), source: "fallback_guess", availableModels, warnings };
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

  // Clean stale/broken provider objects from previous buggy writes.
  if (config.models && config.models.providers && config.models.providers[provider]) {
    delete config.models.providers[provider];
    if (Object.keys(config.models.providers).length === 0) {
      delete config.models.providers;
    }
    if (Object.keys(config.models).length === 0) {
      delete config.models;
    }
  }

  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  // OpenClaw 2026+ Zod schema requires agents.defaults.heartbeat whenever defaults exists
  // (see OpenClaw AgentDefaultsSchema). Omitting it makes openclaw plugins install fail at
  // writeConfigFile → validateConfigObjectRaw with a stack-only error in the UI.
  if (!config.agents.defaults.heartbeat || typeof config.agents.defaults.heartbeat !== "object") {
    config.agents.defaults.heartbeat = {};
  }
  if (!config.agents.defaults.model || typeof config.agents.defaults.model !== "object") {
    config.agents.defaults.model = {};
  }
  config.agents.defaults.model.primary = model;

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return { configPath, provider, model };
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
      llmProvider: options.llmProvider || "",
      llmModel: options.llmModel || "",
      llmCredential: options.llmCredential || "",
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
    await runCommandWithEvents("openclaw", ["plugins", "enable", "telegram"]);
    await runCommandWithEvents("openclaw", ["channels", "add", "--channel", "telegram", "--token", this.options.telegramToken]);
    await runCommandWithEvents("openclaw", ["channels", "status", "--probe"]);
    const policy = ensureTelegramGroupPolicyOpenForWizard();
    if (policy.changed) {
      this.emitLog(
        "telegram_required",
        "info",
        "Set channels.telegram.groupPolicy=open (no sender allowlist yet) to avoid Doctor allowlist warnings on gateway restart. Tighten groupAllowFrom later if you use groups.",
      );
    }
    return { configured: true };
  }

  async configureLlmStep() {
    const provider = String(this.options.llmProvider || "").trim();
    const requestedModel = String(this.options.llmModel || "").trim();
    const credential = String(this.options.llmCredential || "").trim();
    if (!provider || !credential) {
      throw new Error(
        "Missing required LLM settings. Select provider and provide credential in the wizard before starting installation.",
      );
    }
    if (!commandExists("openclaw")) {
      throw new Error("OpenClaw is not available yet. Install step must complete before LLM configuration.");
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

    return { configured: true, provider, model, configPath: saved.configPath };
  }

  buildSetupHandoff() {
    const args = ["setup", "--url", this.options.orchestratorUrl || "https://api.traderclaw.ai"];
    if (this.options.lane !== "event-driven") {
      args.push("--skip-gateway-registration");
    }
    const gatewayBaseUrl = this.options.gatewayBaseUrl || this.state.detected.funnelUrl || "";
    if (this.options.lane === "event-driven" && gatewayBaseUrl) {
      args.push("--gateway-base-url", gatewayBaseUrl);
    }

    const command = [this.modeConfig.cliName, ...args].join(" ");
    const docs =
      "https://docs.traderclaw.ai/docs/installation#troubleshooting-session-expired-auth-errors-or-the-agent-logged-out";
    return {
      pending: true,
      command,
      title: "Ready to launch your agentic trading desk",
      message:
        "Core install is complete. Final setup is intentionally handed off to your VPS shell so sensitive wallet prompts stay private. " +
        "After setup, if the bot reports wallet proof / session errors: configure TRADERCLAW_WALLET_PRIVATE_KEY for the OpenClaw gateway service (systemd), not only in SSH — see " +
        docs,
      hint:
        "Run the command in terminal, answer setup prompts, then restart gateway. If Telegram startup checks all fail, open the troubleshooting link in the message above.",
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
        await this.runStep("install_openclaw", "Installing OpenClaw platform", async () => installOpenClawPlatform());
      }
      await this.runStep("configure_llm", "Configuring required OpenClaw LLM provider", async () => this.configureLlmStep());
      if (!this.options.skipInstallPlugin) {
        await this.runStep("install_plugin_package", "Installing TraderClaw CLI package", async () =>
          installPlugin(
            this.modeConfig,
            (evt) => this.emitLog("install_plugin_package", evt.type === "stderr" ? "warn" : "info", evt.text, evt.urls || []),
          ));
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
        await this.runStep("gateway_bootstrap", "Starting OpenClaw gateway and Funnel", async () => {
          try {
            await this.runWithPrivilegeGuidance("gateway_bootstrap", "openclaw", ["gateway", "install"]);
            await this.runWithPrivilegeGuidance("gateway_bootstrap", "openclaw", ["gateway", "restart"]);
            return this.runFunnel();
          } catch (err) {
            const text = `${err?.message || ""}\n${err?.stderr || ""}\n${err?.stdout || ""}`.toLowerCase();
            const gatewayModeUnset = text.includes("gateway.mode=local") && text.includes("current: unset");
            if (
              text.includes("gateway restart timed out")
              || text.includes("timed out after 60s waiting for health checks")
              || text.includes("waiting for gateway port")
              || gatewayModeUnset
            ) {
              const recovered = await this.tryAutoRecoverGatewayMode("gateway_bootstrap");
              if (recovered.success) {
                return this.runFunnel();
              }
              if (gatewayModeUnset) {
                throw new Error(gatewayModeUnsetRemediation());
              }
              throw new Error(gatewayTimeoutRemediation());
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
        for (const agentId of result.agentIds) {
          const { at, ats } = getAccessPairForAgent(this.options, agentId);
          if (at && ats) {
            try {
              const check = await verifyXCredentials(consumerKey, consumerSecret, at, ats);
              if (check.ok) {
                this.emitLog("x_credentials", "info", `Verified X profile '${agentId}': @${check.username} (${check.userId})`);
                verified.push({ agentId, username: check.username, userId: check.userId });
              } else {
                this.emitLog("x_credentials", "warn", `X credential verification failed for '${agentId}': HTTP ${check.status}`);
              }
            } catch (err) {
              this.emitLog("x_credentials", "warn", `X credential verification error for '${agentId}': ${err?.message || String(err)}`);
            }
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

export function assertWizardXCredentials(modeConfig, options = {}) {
  const t = (s) => (typeof s === "string" ? s.trim() : "");
  const o = options || {};
  if (modeConfig.pluginId === "solana-trader-v2") {
    const need = ["xConsumerKey", "xConsumerSecret", "xAccessTokenCto", "xAccessTokenCtoSecret", "xAccessTokenIntern", "xAccessTokenInternSecret"];
    for (const k of need) {
      if (!t(o[k])) return `Missing required X/Twitter field: ${k}`;
    }
    return null;
  }
  const need = ["xConsumerKey", "xConsumerSecret", "xAccessTokenMain", "xAccessTokenMainSecret"];
  for (const k of need) {
    if (!t(o[k])) return `Missing required X/Twitter field: ${k}`;
  }
  return null;
}

export function createInstallerStepEngine(modeConfig, options = {}, hooks = {}) {
  return new InstallerStepEngine(modeConfig, options, hooks);
}
