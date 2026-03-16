import { execSync, spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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

async function installPlugin(modeConfig) {
  await runCommandWithEvents("npm", ["install", "-g", modeConfig.pluginPackage]);
  return { installed: true, available: commandExists(modeConfig.cliName) };
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

async function runSetupWizard(modeConfig, options = {}) {
  if (!commandExists(modeConfig.cliName)) return { ran: false, reason: "cli_not_found" };
  const args = ["setup", "--url", options.orchestratorUrl || "https://api.traderclaw.ai"];
  if (options.apiKey) args.push("--api-key", options.apiKey);
  else args.push("--signup");

  if (options.gatewayBaseUrl && options.gatewayToken) {
    args.push("--gateway-base-url", options.gatewayBaseUrl, "--gateway-token", options.gatewayToken);
  } else if (options.skipGatewayRegistration) {
    args.push("--skip-gateway-registration");
  }

  try {
    await runCommandWithEvents(modeConfig.cliName, args, {
      onEvent: options.onEvent,
    });
    return { ran: true, success: true };
  } catch {
    return { ran: true, success: false };
  }
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

function verifyInstallation(modeConfig, apiKey) {
  const gatewayFile = join(CONFIG_DIR, "gateway", modeConfig.gatewayConfig);
  return [
    { label: "OpenClaw platform", ok: commandExists("openclaw"), note: "not in PATH" },
    { label: `Trading CLI (${modeConfig.cliName})`, ok: commandExists(modeConfig.cliName), note: "not in PATH" },
    { label: "Configuration file", ok: existsSync(CONFIG_FILE), note: "not created" },
    { label: "Gateway configuration", ok: existsSync(gatewayFile), note: "not found" },
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

  async runTelegramStep() {
    if (!this.options.enableTelegram) return { skipped: true, reason: "telegram_not_requested" };
    if (!this.options.telegramToken) return { skipped: true, reason: "telegram_token_missing" };
    await runCommandWithEvents("openclaw", ["plugins", "enable", "telegram"]);
    await runCommandWithEvents("openclaw", ["channels", "add", "--channel", "telegram", "--token", this.options.telegramToken]);
    await runCommandWithEvents("openclaw", ["channels", "status", "--probe"]);
    return { configured: true };
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
      if (!this.options.skipInstallPlugin) {
        await this.runStep("install_plugin", "Installing TraderClaw plugin package", async () => installPlugin(this.modeConfig));
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
            if (
              text.includes("gateway restart timed out")
              || text.includes("timed out after 60s waiting for health checks")
              || text.includes("waiting for gateway port")
            ) {
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

      await this.runStep("setup", "Running traderclaw setup", async () => {
        const gatewayBaseUrl = this.options.gatewayBaseUrl || this.state.detected.funnelUrl || "";
        return runSetupWizard(this.modeConfig, {
          apiKey: this.options.apiKey,
          orchestratorUrl: this.options.orchestratorUrl,
          gatewayBaseUrl: this.options.lane === "event-driven" ? gatewayBaseUrl : "",
          gatewayToken: this.options.lane === "event-driven" ? this.options.gatewayToken : "",
          skipGatewayRegistration: this.options.lane !== "event-driven",
          onEvent: (evt) => this.emitLog("setup", evt.type === "stderr" ? "warn" : "info", evt.text, evt.urls || []),
        });
      });

      if (!this.options.skipGatewayConfig) {
        await this.runStep("gateway_config", "Deploying gateway config and restarting", async () => {
          const deploy = deployGatewayConfig(this.modeConfig);
          const restart = await restartGateway();
          return { deploy, restart };
        });
      }

      await this.runStep("telegram_optional", "Optional Telegram setup", async () => this.runTelegramStep());
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
