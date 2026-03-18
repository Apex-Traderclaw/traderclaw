import { execSync, spawn } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".openclaw");
const CONFIG_FILE = join(CONFIG_DIR, "openclaw.json");

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
        const stderrPreview = (stderr || "").trim().split("\n").slice(-6).join("\n");
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
  try {
    await runCommandWithEvents("npm", ["install", "-g", modeConfig.pluginPackage], { onEvent });
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
    await runCommandWithEvents("npm", ["install", "-g", "--force", modeConfig.pluginPackage], { onEvent });
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
  seedPluginConfig(modeConfig, orchestratorUrl || "https://api.traderclaw.ai");
  let recoveredExistingDir = null;
  try {
    await runCommandWithEvents("openclaw", ["plugins", "install", modeConfig.pluginPackage], { onEvent });
  } catch (err) {
    if (!isPluginAlreadyExistsError(err, modeConfig.pluginId)) {
      throw err;
    }
    recoveredExistingDir = backupExistingPluginDir(modeConfig.pluginId, onEvent);
    if (!recoveredExistingDir) {
      throw err;
    }
    await runCommandWithEvents("openclaw", ["plugins", "install", modeConfig.pluginPackage], { onEvent });
  }
  await runCommandWithEvents("openclaw", ["plugins", "enable", modeConfig.pluginId], { onEvent });
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
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    config = {};
  }

  if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
  if (!config.plugins.entries || typeof config.plugins.entries !== "object") config.plugins.entries = {};

  const existing = config.plugins.entries[modeConfig.pluginId];
  const existingConfig = existing && typeof existing === "object" && existing.config && typeof existing.config === "object"
    ? existing.config
    : {};

  config.plugins.entries[modeConfig.pluginId] = {
    enabled: existing && typeof existing.enabled === "boolean" ? existing.enabled : true,
    config: {
      ...existingConfig,
      orchestratorUrl: typeof existingConfig.orchestratorUrl === "string" && existingConfig.orchestratorUrl.trim()
        ? existingConfig.orchestratorUrl.trim()
        : (orchestratorUrl || "https://api.traderclaw.ai"),
    },
  };

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return configPath;
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

  const v1Agents = [
    { id: "main", default: true, heartbeat: { every: "5m", target: "last" } }
  ];
  const v2Agents = [
    { id: "cto", default: true, heartbeat: { every: "5m", target: "last" } },
    { id: "execution-specialist", heartbeat: { every: "3m", target: "last" } },
    { id: "alpha-signal-analyst", heartbeat: { every: "5m", target: "last" } },
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

  return {
    configPath,
    agentsConfigured: targetAgents.length,
    cronJobsAdded: 0,
    cronJobsUpdated: 0,
    cronJobsTotal: targetJobs.length,
    cronJobsManagedExternally: true,
    removedLegacyCronJobs,
    hooksConfigured: config.hooks.mappings.length,
    isV2
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
  const src = join(npmRoot, modeConfig.pluginPackage, "config", modeConfig.gatewayConfig);
  if (!existsSync(src)) return { deployed: false, dest: destFile };
  writeFileSync(destFile, readFileSync(src));
  return { deployed: true, source: src, dest: destFile };
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
  if (provider === "anthropic") return "anthropic/claude-opus-4-6";
  if (provider === "openai") return "openai/gpt-5.4";
  if (provider === "openai-codex") return "openai-codex/gpt-5.4";
  return `${provider}/default`;
}

function modelDateScore(modelId) {
  const match = String(modelId || "").match(/-(\d{8})$/);
  if (!match) return 0;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function choosePreferredProviderModel(provider, models = []) {
  const items = Array.isArray(models) ? models.filter(Boolean) : [];
  if (items.length === 0) return "";

  const knownBad = new Set([
    // Frequently present in catalogs but can 404 for message requests.
    "anthropic/claude-3-5-haiku-20241022",
  ]);

  const ranked = items
    .map((modelId) => {
      let score = 0;
      const id = String(modelId);
      const lower = id.toLowerCase();

      if (knownBad.has(id)) score -= 1000000;
      if (lower.includes("latest")) score += 100000;

      if (provider === "anthropic") {
        if (lower.includes("claude-sonnet")) score += 50000;
        else if (lower.includes("claude-opus")) score += 40000;
        else if (lower.includes("claude-haiku")) score += 20000;
      }

      score += modelDateScore(id);
      return { id, score };
    })
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));

  return ranked[0]?.id || items[0];
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
    if (chosen && chosen !== availableModels[0]) {
      warnings.push(
        `Auto-selected '${chosen}' from provider catalog (more stable default than '${availableModels[0]}').`,
      );
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
    this.hooks.onLog({ at: nowIso(), stepId, level, text, urls });
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
      const detail = err?.message || String(err);
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
    return {
      pending: true,
      command,
      title: "Ready to launch your agentic trading desk",
      message:
        "Core install is complete. Final setup is intentionally handed off to your VPS shell so sensitive wallet prompts stay private.",
      hint:
        "Run the command in terminal, answer setup prompts, then restart gateway.",
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

      await this.runStep("enable_responses", "Enabling /v1/responses endpoint", async () => {
        const configPath = ensureOpenResponsesEnabled(CONFIG_FILE);
        const restart = await restartGateway();
        return { configPath, restart };
      });

      await this.runStep("gateway_scheduling", "Configuring heartbeat and cron schedules", async () => {
        const result = configureGatewayScheduling(this.modeConfig, CONFIG_FILE);
        this.emitLog("gateway_scheduling", "info", `Agents configured: ${result.agentsConfigured}`);
        this.emitLog("gateway_scheduling", "info", `Cron jobs target: ${result.cronJobsTotal} (managed by OpenClaw cron store/CLI).`);
        if (result.removedLegacyCronJobs) {
          this.emitLog("gateway_scheduling", "warn", "Removed legacy 'cron.jobs' from openclaw.json to keep config validation compatible.");
        }
        this.emitLog("gateway_scheduling", "info", `Webhook hooks: ${result.hooksConfigured}`);
        const restart = await restartGateway();
        return { ...result, restart };
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

export function createInstallerStepEngine(modeConfig, options = {}, hooks = {}) {
  return new InstallerStepEngine(modeConfig, options, hooks);
}
