#!/usr/bin/env node

import { createInterface } from "readline";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const VERSION = "1.0.0";
const PLUGIN_ID = "solana-trader";
const LEGACY_PLUGIN_IDS = ["traderclaw-v1", "solana-traderclaw-v1", "solana-traderclaw"];
const CONFIG_DIR = join(homedir(), ".openclaw");
const CONFIG_FILE = join(CONFIG_DIR, "openclaw.json");

const BANNER = `
 ██████╗ ██████╗ ███████╗███╗   ██╗ ██████╗██╗      █████╗ ██╗    ██╗
██╔═══██╗██╔══██╗██╔════╝████╗  ██║██╔════╝██║     ██╔══██╗██║    ██║
██║   ██║██████╔╝█████╗  ██╔██╗ ██║██║     ██║     ███████║██║ █╗ ██║
██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║     ██║     ██╔══██╗██║███╗██║
╚██████╔╝██║     ███████╗██║ ╚████║╚██████╗███████╗██║  ██║╚███╔███╔╝
 ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
                    Solana Memecoin Trading Agent
`;

function print(msg: string) {
  process.stdout.write(msg + "\n");
}

function printError(msg: string) {
  process.stderr.write(`\x1b[31mError: ${msg}\x1b[0m\n`);
}

function printSuccess(msg: string) {
  print(`\x1b[32m${msg}\x1b[0m`);
}

function printWarn(msg: string) {
  print(`\x1b[33m${msg}\x1b[0m`);
}

function printInfo(msg: string) {
  print(`\x1b[36m${msg}\x1b[0m`);
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} (y/n)`, "n");
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

async function httpRequest(url: string, opts: { method?: string; body?: unknown; apiKey?: string; timeout?: number } = {}): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeout ?? 10000);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.apiKey) {
      headers["Authorization"] = `Bearer ${opts.apiKey}`;
    }

    const fetchOpts: RequestInit = {
      method: opts.method || "GET",
      headers,
      signal: controller.signal,
    };

    if (opts.body) {
      fetchOpts.body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, fetchOpts);
    const text = await res.text();

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    return { ok: res.ok, status: res.status, data };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${opts.timeout ?? 10000}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function readConfig(): Record<string, unknown> {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return normalizePluginConfigShape(JSON.parse(raw));
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, unknown>) {
  normalizePluginConfigShape(config);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePluginConfigShape(config: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(config)) return config;
  if (!isRecord(config.plugins)) config.plugins = {};
  const plugins = config.plugins as Record<string, unknown>;
  if (!isRecord(plugins.entries)) plugins.entries = {};
  const entries = plugins.entries as Record<string, unknown>;

  let enabledSeen = false;
  let enabledValue = false;
  let mergedConfig: Record<string, unknown> = {};
  let found = false;

  for (const sourceId of [...LEGACY_PLUGIN_IDS, PLUGIN_ID]) {
    const entry = entries[sourceId];
    if (!isRecord(entry)) continue;
    found = true;
    if (typeof entry.enabled === "boolean") {
      enabledSeen = true;
      enabledValue = enabledValue || entry.enabled;
    }
    if (isRecord(entry.config)) {
      mergedConfig = { ...mergedConfig, ...(entry.config as Record<string, unknown>) };
    }
  }

  if (found) {
    const canonical = isRecord(entries[PLUGIN_ID]) ? entries[PLUGIN_ID] as Record<string, unknown> : {};
    entries[PLUGIN_ID] = {
      ...canonical,
      enabled: typeof canonical.enabled === "boolean" ? canonical.enabled : (enabledSeen ? enabledValue : true),
      config: mergedConfig,
    };
  }

  for (const legacyId of LEGACY_PLUGIN_IDS) {
    delete entries[legacyId];
  }

  if (Array.isArray(plugins.allow)) {
    const seen = new Set<string>();
    plugins.allow = plugins.allow.filter((id): id is string => {
      if (typeof id !== "string") return false;
      const trimmed = id.trim();
      if (!trimmed || LEGACY_PLUGIN_IDS.includes(trimmed) || seen.has(trimmed)) return false;
      seen.add(trimmed);
      return true;
    });
  }

  return config;
}

function getPluginConfig(config: Record<string, unknown>): Record<string, unknown> | null {
  normalizePluginConfigShape(config);
  const plugins = config.plugins as Record<string, unknown> | undefined;
  if (!plugins) return null;
  const entries = plugins.entries as Record<string, unknown> | undefined;
  if (!entries) return null;
  const plugin = entries[PLUGIN_ID] as Record<string, unknown> | undefined;
  if (!plugin) return null;
  return (plugin.config as Record<string, unknown>) || null;
}

function setPluginConfig(config: Record<string, unknown>, pluginConfig: Record<string, unknown>) {
  normalizePluginConfigShape(config);
  if (!config.plugins) config.plugins = {};
  const plugins = config.plugins as Record<string, unknown>;
  if (!plugins.entries) plugins.entries = {};
  const entries = plugins.entries as Record<string, unknown>;
  entries[PLUGIN_ID] = {
    enabled: true,
    config: pluginConfig,
  };
}

async function cmdSetup(args: string[]) {
  print(BANNER);
  printInfo("Welcome to OpenClaw Solana Trader setup.\n");

  let apiKey = "";
  let orchestratorUrl = "";

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--api-key" || args[i] === "-k") && args[i + 1]) {
      apiKey = args[++i];
    }
    if ((args[i] === "--url" || args[i] === "-u") && args[i + 1]) {
      orchestratorUrl = args[++i];
    }
  }

  if (!apiKey) {
    print("You need an API key to connect to the OpenClaw orchestrator.");
    print("Get one at: https://traderclaw.ai/register\n");
    apiKey = await prompt("Enter your API key");
  }

  if (!apiKey) {
    printError("API key is required. Get one at https://traderclaw.ai/register");
    process.exit(1);
  }

  if (!orchestratorUrl) {
    orchestratorUrl = await prompt("Orchestrator URL", "https://api.traderclaw.ai");
  }

  orchestratorUrl = orchestratorUrl.replace(/\/+$/, "");

  print("\nValidating connection...\n");

  let healthOk = false;
  try {
    const health = await httpRequest(`${orchestratorUrl}/healthz`, { apiKey });
    if (health.ok) {
      const h = health.data as Record<string, unknown>;
      printSuccess(`  Orchestrator reachable`);
      printInfo(`  Service: ${h.service || "unknown"}`);
      printInfo(`  Execution mode: ${h.executionMode || "unknown"}`);
      printInfo(`  Upstream configured: ${h.upstreamConfigured ? "yes" : "no"}`);
      healthOk = true;
    } else {
      if (health.status === 401 || health.status === 403) {
        printError("Invalid API key. Check your key and try again.");
        process.exit(1);
      }
      printError(`Orchestrator returned HTTP ${health.status}`);
      process.exit(1);
    }
  } catch (err) {
    printError(`Cannot reach orchestrator at ${orchestratorUrl}`);
    printError(err instanceof Error ? err.message : String(err));
    print("\nTips:");
    print("  - Check the URL is correct");
    print("  - Make sure the orchestrator is running");
    print(`  - Try: curl ${orchestratorUrl}/healthz`);
    process.exit(1);
  }

  let systemOk = false;
  try {
    const status = await httpRequest(`${orchestratorUrl}/api/system/status`, { apiKey });
    if (status.ok) {
      const s = status.data as Record<string, unknown>;
      printSuccess(`  System status OK`);
      if (s.walletCount !== undefined) printInfo(`  Wallets: ${s.walletCount}`);
      if (s.wsConnections !== undefined) printInfo(`  WebSocket connections: ${s.wsConnections}`);
      systemOk = true;
    } else {
      printWarn("  System status check returned non-OK (non-critical)");
    }
  } catch {
    printWarn("  System status check failed (non-critical)");
  }

  print("\nSetting up wallet...\n");

  let walletId: string | null = null;
  let walletLabel = "";

  try {
    const walletsRes = await httpRequest(`${orchestratorUrl}/api/wallets`, { apiKey });
    if (walletsRes.ok && Array.isArray(walletsRes.data) && (walletsRes.data as unknown[]).length > 0) {
      const wallets = walletsRes.data as Array<Record<string, unknown>>;
      printInfo(`  Found ${wallets.length} existing wallet(s):`);
      wallets.forEach((w, i) => {
        print(`    ${i + 1}. ${w.label || "Unnamed"} (ID: ${w.id}, Status: ${w.status})`);
      });

      const choice = await prompt("\nUse existing wallet? Enter number or 'new' to create one", "1");

      if (choice.toLowerCase() === "new") {
        walletLabel = await prompt("Wallet label", "Trading Wallet");
        const createRes = await httpRequest(`${orchestratorUrl}/api/wallet/create`, {
          method: "POST",
          body: { label: walletLabel, strategyProfile: "aggressive" },
          apiKey,
        });
        if (createRes.ok) {
          const created = createRes.data as Record<string, unknown>;
          walletId = String(created.id);
          printSuccess(`  Wallet created (ID: ${walletId})`);
        } else {
          printError("Failed to create wallet");
          printError(JSON.stringify(createRes.data));
          process.exit(1);
        }
      } else {
        const idx = parseInt(choice, 10) - 1;
        if (idx >= 0 && idx < wallets.length) {
          walletId = String(wallets[idx].id);
          walletLabel = wallets[idx].label as string || "Unnamed";
          printSuccess(`  Using wallet: ${walletLabel} (ID: ${walletId})`);
        } else {
          walletId = String(wallets[0].id);
          walletLabel = wallets[0].label as string || "Unnamed";
          printSuccess(`  Using wallet: ${walletLabel} (ID: ${walletId})`);
        }
      }
    } else {
      printInfo("  No existing wallets found. Creating one...");
      walletLabel = await prompt("Wallet label", "Trading Wallet");
      const createRes = await httpRequest(`${orchestratorUrl}/api/wallet/create`, {
        method: "POST",
        body: { label: walletLabel, strategyProfile: "aggressive" },
        apiKey,
      });
      if (createRes.ok) {
        const created = createRes.data as Record<string, unknown>;
        walletId = String(created.id);
        printSuccess(`  Wallet created (ID: ${walletId})`);
      } else {
        printError("Failed to create wallet");
        printError(JSON.stringify(createRes.data));
        process.exit(1);
      }
    }
  } catch (err) {
    printError("Failed to set up wallet");
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  print("\nWriting configuration...\n");

  const existingConfig = readConfig();
  const pluginConfig: Record<string, unknown> = {
    orchestratorUrl,
    walletId,
    apiKey,
    apiTimeout: 120000,
  };
  setPluginConfig(existingConfig, pluginConfig);
  writeConfig(existingConfig);

  printSuccess(`  Config written to ${CONFIG_FILE}`);

  print("\n" + "=".repeat(60));
  printSuccess("\n  Setup complete!\n");
  print("=".repeat(60));
  print(`
  Orchestrator:  ${orchestratorUrl}
  Wallet:        ${walletLabel} (ID: ${walletId})
  API Key:       ${maskKey(apiKey)}
  Config:        ${CONFIG_FILE}
`);
  print("Next steps:");
  print("  1. Install the plugin:     openclaw plugins install solana-traderclaw (or: npm install -g solana-traderclaw)");
  print("  2. Restart the gateway:    openclaw gateway --restart");
  print("  3. Start trading:          Ask OpenClaw to scan for opportunities");
  print("");
  print("Quick commands:");
  print("  openclaw-trader status     Check connection health");
  print("  openclaw-trader config     View current configuration");
  print("");
}

async function cmdStatus() {
  const config = readConfig();
  const pluginConfig = getPluginConfig(config);

  if (!pluginConfig) {
    printError("No plugin configuration found. Run 'openclaw-trader setup' first.");
    process.exit(1);
  }

  const orchestratorUrl = pluginConfig.orchestratorUrl as string;
  const walletId = pluginConfig.walletId as string;
  const apiKey = pluginConfig.apiKey as string | undefined;

  if (!orchestratorUrl) {
    printError("orchestratorUrl not set in config. Run 'openclaw-trader setup' to fix.");
    process.exit(1);
  }

  print("\nOpenClaw Solana Trader - Status\n");
  print("=".repeat(45));

  try {
    const health = await httpRequest(`${orchestratorUrl}/healthz`, { apiKey, timeout: 5000 });
    if (health.ok) {
      const h = health.data as Record<string, unknown>;
      printSuccess("  Orchestrator:     CONNECTED");
      printInfo(`  Execution mode:   ${h.executionMode || "unknown"}`);
      printInfo(`  Upstream:         ${h.upstreamConfigured ? "configured" : "not configured"}`);
    } else {
      printError(`  Orchestrator:     ERROR (HTTP ${health.status})`);
    }
  } catch (err) {
    printError("  Orchestrator:     UNREACHABLE");
    printError(`  ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const statusRes = await httpRequest(`${orchestratorUrl}/api/system/status`, { apiKey, timeout: 5000 });
    if (statusRes.ok) {
      const s = statusRes.data as Record<string, unknown>;
      printSuccess("  System status:    OK");
      if (s.wsConnections !== undefined) printInfo(`  WS connections:   ${s.wsConnections}`);
    }
  } catch {
    printWarn("  System status:    unavailable");
  }

  print("");

  try {
    const capitalRes = await httpRequest(`${orchestratorUrl}/api/capital/status?walletId=${walletId}`, { apiKey, timeout: 5000 });
    if (capitalRes.ok) {
      const c = capitalRes.data as Record<string, unknown>;
      printSuccess("  Wallet:           ACTIVE");
      printInfo(`  Wallet ID:        ${walletId}`);
      printInfo(`  Balance:          ${c.balanceSol ?? "?"} SOL`);
      printInfo(`  Open positions:   ${c.openPositionCount ?? "?"}`);
      printInfo(`  Unrealized PnL:   ${c.totalUnrealizedPnl ?? "?"} SOL`);
      printInfo(`  Daily loss:       ${c.dailyLossSol ?? 0} SOL`);
    } else {
      printError("  Wallet:           ERROR");
    }
  } catch {
    printWarn("  Wallet:           unavailable");
  }

  try {
    const ksRes = await httpRequest(`${orchestratorUrl}/api/killswitch/status?walletId=${walletId}`, { apiKey, timeout: 5000 });
    if (ksRes.ok) {
      const ks = ksRes.data as Record<string, unknown>;
      if (ks.enabled) {
        printWarn(`  Kill switch:      ENABLED (${ks.mode})`);
      } else {
        printInfo(`  Kill switch:      disabled`);
      }
    }
  } catch {
    /* skip */
  }

  try {
    const stratRes = await httpRequest(`${orchestratorUrl}/api/strategy/state?walletId=${walletId}`, { apiKey, timeout: 5000 });
    if (stratRes.ok) {
      const st = stratRes.data as Record<string, unknown>;
      printInfo(`  Strategy version: ${st.strategyVersion || "?"}`);
      printInfo(`  Mode:             ${st.mode || "HARDENED"}`);
    }
  } catch {
    /* skip */
  }

  print("\n" + "=".repeat(45));
  print("");
}

async function cmdConfig(subArgs: string[]) {
  const subCmd = subArgs[0] || "show";

  if (subCmd === "show") {
    const config = readConfig();
    const pluginConfig = getPluginConfig(config);

    if (!pluginConfig) {
      printError("No plugin configuration found. Run 'openclaw-trader setup' first.");
      process.exit(1);
    }

    print("\nOpenClaw Solana Trader - Configuration\n");
    print("=".repeat(45));
    print(`  Config file:      ${CONFIG_FILE}`);
    print(`  Orchestrator URL: ${pluginConfig.orchestratorUrl || "not set"}`);
    print(`  Wallet ID:        ${pluginConfig.walletId ?? "not set"}`);
    print(`  API Key:          ${pluginConfig.apiKey ? maskKey(pluginConfig.apiKey as string) : "not set"}`);
    print(`  API Timeout:      ${pluginConfig.apiTimeout || 120000}ms`);
    print("=".repeat(45));
    print("");
    return;
  }

  if (subCmd === "set") {
    const key = subArgs[1];
    const value = subArgs[2];

    if (!key || !value) {
      printError("Usage: openclaw-trader config set <key> <value>");
      print("  Available keys: orchestratorUrl, walletId, apiKey, apiTimeout");
      process.exit(1);
    }

    const allowedKeys = ["orchestratorUrl", "walletId", "apiKey", "apiTimeout"];
    if (!allowedKeys.includes(key)) {
      printError(`Unknown config key: ${key}`);
      print(`  Available keys: ${allowedKeys.join(", ")}`);
      process.exit(1);
    }

    const config = readConfig();
    const pluginConfig = getPluginConfig(config) || {};

    let parsedValue: unknown = value;
    if (key === "walletId") {
      parsedValue = value;
    }
    if (key === "apiTimeout") {
      parsedValue = parseInt(value, 10);
      if (isNaN(parsedValue as number)) {
        printError("apiTimeout must be a number (milliseconds)");
        process.exit(1);
      }
    }

    pluginConfig[key] = parsedValue;
    setPluginConfig(config, pluginConfig);
    writeConfig(config);

    printSuccess(`Set ${key} = ${key === "apiKey" ? maskKey(value) : value}`);
    print("Restart the gateway for changes to take effect: openclaw gateway --restart");
    return;
  }

  if (subCmd === "reset") {
    const confirmed = await confirm("This will remove all OpenClaw Solana Trader configuration. Continue?");
    if (!confirmed) {
      print("Cancelled.");
      return;
    }

    const config = readConfig();
    const plugins = config.plugins as Record<string, unknown> | undefined;
    if (plugins) {
      const entries = plugins.entries as Record<string, unknown> | undefined;
      if (entries) {
        delete entries[PLUGIN_ID];
      }
    }
    writeConfig(config);
    printSuccess("Plugin configuration removed.");
    return;
  }

  printError(`Unknown config subcommand: ${subCmd}`);
  print("  Available: show, set, reset");
  process.exit(1);
}

function printHelp() {
  print(`
OpenClaw Solana Trader CLI v${VERSION}

Usage: openclaw-trader <command> [options]

Commands:
  setup              Set up the plugin (API key, orchestrator, wallet)
  status             Check connection health and wallet status
  config             View and manage configuration

Setup options:
  --api-key, -k      API key (skip interactive prompt)
  --url, -u          Orchestrator URL (skip interactive prompt)

Config subcommands:
  config show        Show current configuration
  config set <k> <v> Update a configuration value
  config reset       Remove plugin configuration

Examples:
  openclaw-trader setup
  openclaw-trader setup --api-key sk_live_abc123 --url https://api.traderclaw.ai
  openclaw-trader status
  openclaw-trader config show
  openclaw-trader config set apiTimeout 60000
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    print(`openclaw-trader v${VERSION}`);
    process.exit(0);
  }

  switch (command) {
    case "setup":
      await cmdSetup(args.slice(1));
      break;
    case "status":
      await cmdStatus();
      break;
    case "config":
      await cmdConfig(args.slice(1));
      break;
    default:
      printError(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
