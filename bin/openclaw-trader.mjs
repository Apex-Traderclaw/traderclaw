#!/usr/bin/env node

import { createInterface } from "readline";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID, createPrivateKey, sign as cryptoSign } from "crypto";
import { execSync } from "child_process";
import { createServer } from "http";
import { sortModelsByPreference } from "./llm-model-preference.mjs";

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')).version;
const PLUGIN_ID = "solana-trader";
const CONFIG_DIR = join(homedir(), ".openclaw");
const CONFIG_FILE = join(CONFIG_DIR, "openclaw.json");
const WALLET_PRIVATE_KEY_ENV = "TRADERCLAW_WALLET_PRIVATE_KEY";

/** Linked from CLI errors and setup — keep in sync with SKILL / README. */
const TRADERCLAW_SESSION_TROUBLESHOOTING_URL =
  "https://docs.traderclaw.ai/docs/installation#troubleshooting-session-expired-auth-errors-or-the-agent-logged-out";

function printSessionTroubleshootingHint() {
  printWarn(`  Troubleshooting: ${TRADERCLAW_SESSION_TROUBLESHOOTING_URL}`);
  printWarn(
    "  Wallet proof is not signup — it proves you own the trading wallet already linked to your API key.",
  );
  printWarn(
    "  The OpenClaw gateway is a separate process: export in SSH alone does not set the key for the gateway. Use systemd EnvironmentFile (or equivalent) so TRADERCLAW_WALLET_PRIVATE_KEY is available to the gateway service.",
  );
}

const BANNER = `
 ████████╗██████╗  █████╗ ██████╗ ███████╗██████╗  ██████╗██╗      █████╗ ██╗    ██╗
 ╚══██╔══╝██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗██╔════╝██║     ██╔══██╗██║    ██║
    ██║   ██████╔╝███████║██║  ██║█████╗  ██████╔╝██║     ██║     ███████║██║ █╗ ██║
    ██║   ██╔══██╗██╔══██║██║  ██║██╔══╝  ██╔══██╗██║     ██║     ██╔══██║██║███╗██║
    ██║   ██║  ██║██║  ██║██████╔╝███████╗██║  ██║╚██████╗███████╗██║  ██║╚███╔███╔╝
    ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
                    Solana Memecoin Trading Agent (V1)
`;

function print(msg) {
  process.stdout.write(msg + "\n");
}

function printError(msg) {
  process.stderr.write(`\x1b[31mError: ${msg}\x1b[0m\n`);
}

function printSuccess(msg) {
  print(`\x1b[32m${msg}\x1b[0m`);
}

function printWarn(msg) {
  print(`\x1b[33m${msg}\x1b[0m`);
}

function printInfo(msg) {
  print(`\x1b[36m${msg}\x1b[0m`);
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

function maskKey(key) {
  if (!key || key.length <= 8) return "****";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

function getRuntimeWalletPrivateKey(explicitValue = "") {
  const fromArg = typeof explicitValue === "string" ? explicitValue.trim() : "";
  if (fromArg) return fromArg;
  const fromEnv = typeof process.env[WALLET_PRIVATE_KEY_ENV] === "string" ? process.env[WALLET_PRIVATE_KEY_ENV].trim() : "";
  return fromEnv || "";
}

function removeLegacyWalletPrivateKey(pluginConfig) {
  if (!pluginConfig || typeof pluginConfig !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(pluginConfig, "walletPrivateKey")) return false;
  delete pluginConfig.walletPrivateKey;
  return true;
}

function prompt(question, defaultValue) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

async function confirm(question) {
  const answer = await prompt(`${question} (y/n)`, "n");
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

async function httpRequest(url, opts = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeout ?? 10000);

  try {
    const headers = { "Content-Type": "application/json" };
    if (opts.accessToken) {
      headers["Authorization"] = `Bearer ${opts.accessToken}`;
    } else if (opts.apiKey) {
      headers["Authorization"] = `Bearer ${opts.apiKey}`;
    }

    const fetchOpts = {
      method: opts.method || "GET",
      headers,
      signal: controller.signal,
    };

    if (opts.body) {
      fetchOpts.body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, fetchOpts);
    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Request timed out after ${opts.timeout ?? 10000}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function readConfig() {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function getPluginConfig(config) {
  const plugins = config.plugins;
  if (!plugins) return null;
  const entries = plugins.entries;
  if (!entries) return null;
  const plugin = entries[PLUGIN_ID];
  if (!plugin) return null;
  return plugin.config || null;
}

function setPluginConfig(config, pluginConfig) {
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.entries) config.plugins.entries = {};
  config.plugins.entries[PLUGIN_ID] = {
    enabled: true,
    config: pluginConfig,
  };
}

function getGatewayConfig(config) {
  if (!config || typeof config !== "object") return {};
  if (!config.gateway || typeof config.gateway !== "object") return {};
  return config.gateway;
}

function detectTailscaleDnsName() {
  try {
    const raw = execSync("tailscale status --json", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const parsed = JSON.parse(raw);
    const dns = parsed?.Self?.DNSName;
    if (typeof dns !== "string" || dns.length === 0) return undefined;
    return dns.endsWith(".") ? dns.slice(0, -1) : dns;
  } catch {
    return undefined;
  }
}

function buildGatewayDefaults(config) {
  const gateway = getGatewayConfig(config);
  const bind = typeof gateway.bind === "string" ? gateway.bind : "loopback";
  const port = Number.isInteger(gateway.port) ? gateway.port : 18789;
  const tailscaleMode = gateway?.tailscale && typeof gateway.tailscale === "object" && typeof gateway.tailscale.mode === "string"
    ? gateway.tailscale.mode
    : "off";
  const gatewayToken = gateway?.auth && typeof gateway.auth === "object" && gateway.auth.mode === "token" && typeof gateway.auth.token === "string"
    ? gateway.auth.token
    : undefined;

  let gatewayBaseUrl;
  if (bind === "tailnet" || tailscaleMode === "serve" || tailscaleMode === "funnel") {
    const dnsName = detectTailscaleDnsName();
    if (dnsName) {
      gatewayBaseUrl = `https://${dnsName}`;
    }
  } else if (bind === "lan" || bind === "custom") {
    gatewayBaseUrl = `http://:${port}`;
  }

  return {
    bind,
    port,
    tailscaleMode,
    gatewayBaseUrl,
    gatewayToken,
  };
}

function getNestedBool(payload, key) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (typeof payload[key] === "boolean") return payload[key];
  if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) && typeof payload.data[key] === "boolean") {
    return payload.data[key];
  }
  return undefined;
}

function extractWalletId(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (typeof payload.id === "string" || typeof payload.id === "number") return String(payload.id);
  if (typeof payload.walletId === "string" || typeof payload.walletId === "number") return String(payload.walletId);
  if (payload.wallet && typeof payload.wallet === "object" && !Array.isArray(payload.wallet)) {
    if (typeof payload.wallet.id === "string" || typeof payload.wallet.id === "number") return String(payload.wallet.id);
    if (typeof payload.wallet.walletId === "string" || typeof payload.wallet.walletId === "number") return String(payload.wallet.walletId);
  }
  if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    if (typeof payload.data.id === "string" || typeof payload.data.id === "number") return String(payload.data.id);
    if (typeof payload.data.walletId === "string" || typeof payload.data.walletId === "number") return String(payload.data.walletId);
  }
  return null;
}

function extractWalletKeys(payload) {
  const scopes = [];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    scopes.push(payload);
    if (payload.wallet && typeof payload.wallet === "object" && !Array.isArray(payload.wallet)) {
      scopes.push(payload.wallet);
    }
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
      scopes.push(payload.data);
    }
  }

  const pick = (keys) => {
    for (const scope of scopes) {
      for (const key of keys) {
        const val = scope[key];
        if (typeof val === "string" && val.length > 0) return val;
      }
    }
    return undefined;
  };

  return {
    publicKey: pick(["walletPublicKey", "publicKey", "address"]),
    privateKey: pick(["walletPrivateKey", "privateKey", "secretKey"]),
  };
}

const BS58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function b58Decode(str) {
  let num = BigInt(0);
  for (const c of str) {
    const idx = BS58_CHARS.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base58 character: ${c}`);
    num = num * 58n + BigInt(idx);
  }
  const hex = num.toString(16);
  const paddedHex = hex.length % 2 ? "0" + hex : hex;
  const bytes = new Uint8Array(paddedHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(paddedHex.substring(i * 2, i * 2 + 2), 16);
  }
  let leadingZeros = 0;
  for (const c of str) {
    if (c === "1") leadingZeros++;
    else break;
  }
  if (leadingZeros > 0) {
    const combined = new Uint8Array(leadingZeros + bytes.length);
    combined.set(bytes, leadingZeros);
    return combined;
  }
  return bytes;
}

function b58Encode(bytes) {
  let num = BigInt(0);
  for (const b of bytes) {
    num = num * 256n + BigInt(b);
  }
  let result = "";
  while (num > 0n) {
    result = BS58_CHARS[Number(num % 58n)] + result;
    num = num / 58n;
  }
  for (const b of bytes) {
    if (b === 0) result = "1" + result;
    else break;
  }
  return result || "1";
}

function signChallengeLocally(challengeText, privateKeyBase58) {
  const keyBytes = b58Decode(privateKeyBase58);
  const privKeyRaw = keyBytes.slice(0, 32);
  const pkcs8Prefix = Buffer.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8Der = Buffer.concat([pkcs8Prefix, Buffer.from(privKeyRaw)]);
  const keyObj = createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
  const sig = cryptoSign(null, Buffer.from(challengeText, "utf-8"), keyObj);
  return b58Encode(new Uint8Array(sig));
}

async function doSignup(orchestratorUrl, externalUserId) {
  printInfo(`  Signing up as: ${externalUserId}`);
  const res = await httpRequest(`${orchestratorUrl}/api/auth/signup`, {
    method: "POST",
    body: { externalUserId },
  });

  if (!res.ok) {
    throw new Error(`Signup failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
  }

  return res.data;
}

async function doChallenge(orchestratorUrl, apiKey, walletPublicKey) {
  const body = { apiKey, clientLabel: "openclaw-trader-cli" };
  if (walletPublicKey) body.walletPublicKey = walletPublicKey;

  const res = await httpRequest(`${orchestratorUrl}/api/session/challenge`, {
    method: "POST",
    body,
  });

  if (!res.ok) {
    throw new Error(`Challenge request failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
  }

  return res.data;
}

async function doSessionStart(orchestratorUrl, apiKey, challengeId, walletPublicKey, walletSignature) {
  const body = { apiKey, challengeId, clientLabel: "openclaw-trader-cli" };
  if (walletPublicKey) body.walletPublicKey = walletPublicKey;
  if (walletSignature) body.walletSignature = walletSignature;

  const res = await httpRequest(`${orchestratorUrl}/api/session/start`, {
    method: "POST",
    body,
  });

  if (!res.ok) {
    throw new Error(`Session start failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
  }

  return res.data;
}

async function doRefresh(orchestratorUrl, refreshToken) {
  const res = await httpRequest(`${orchestratorUrl}/api/session/refresh`, {
    method: "POST",
    body: { refreshToken },
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return null;
    }
    throw new Error(`Token refresh failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
  }

  return res.data;
}

async function doLogout(orchestratorUrl, refreshToken) {
  const res = await httpRequest(`${orchestratorUrl}/api/session/logout`, {
    method: "POST",
    body: { refreshToken },
  });
  return res.ok;
}

async function establishSession(orchestratorUrl, pluginConfig, walletPrivateKeyInput = "") {
  if (pluginConfig.refreshToken) {
    printInfo("  Refreshing existing session...");
    const tokens = await doRefresh(orchestratorUrl, pluginConfig.refreshToken);
    if (tokens) {
      printSuccess("  Session refreshed successfully");
      pluginConfig.refreshToken = tokens.refreshToken;
      return tokens;
    }
    printWarn("  Refresh token expired. Re-authenticating...");
  }

  if (!pluginConfig.apiKey) {
    throw new Error("No apiKey configured. Run 'traderclaw setup' first.");
  }

  printInfo("  Starting challenge flow...");
  const challenge = await doChallenge(orchestratorUrl, pluginConfig.apiKey, pluginConfig.walletPublicKey);

  let walletPubKey = undefined;
  let walletSig = undefined;

  if (challenge.walletProofRequired) {
    printWarn("  Wallet proof required — this account already has a wallet.");
    const walletPrivateKey = getRuntimeWalletPrivateKey(walletPrivateKeyInput);
    if (!walletPrivateKey) {
      printError(`  Wallet private key not available. Cannot prove wallet ownership.`);
      printError(`  Provide it via --wallet-private-key or env ${WALLET_PRIVATE_KEY_ENV} for local signing.`);
      printSessionTroubleshootingHint();
      throw new Error("Wallet proof required but no private key configured.");
    }
    walletPubKey = challenge.walletPublicKey || pluginConfig.walletPublicKey;
    printInfo("  Signing challenge locally...");
    try {
      walletSig = signChallengeLocally(challenge.challenge, walletPrivateKey);
      printSuccess("  Challenge signed successfully");
    } catch (err) {
      printError(`  Failed to sign challenge: ${err.message}`);
      throw new Error("Challenge signing failed. Verify your walletPrivateKey is correct.");
    }
  }

  const tokens = await doSessionStart(
    orchestratorUrl,
    pluginConfig.apiKey,
    challenge.challengeId,
    walletPubKey,
    walletSig,
  );

  if (challenge.walletPublicKey) {
    pluginConfig.walletPublicKey = challenge.walletPublicKey;
  }

  pluginConfig.refreshToken = tokens.refreshToken;
  printSuccess("  Session established");
  printInfo(`  Tier: ${tokens.session?.tier || "unknown"}`);
  printInfo(`  Scopes: ${(tokens.session?.scopes || []).join(", ")}`);

  return tokens;
}

async function cmdSetup(args) {
  print(BANNER);
  printInfo("Welcome to TraderClaw V1 setup (session auth).\n");

  let apiKey = "";
  let orchestratorUrl = "";
  let externalUserId = "";
  let walletPrivateKey = "";
  let gatewayBaseUrl = "";
  let gatewayToken = "";
  let skipGatewayRegistration = false;
  let showApiKey = false;
  let showWalletPrivateKey = false;
  let doSignupFlow = false;
  let signedUpThisSession = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--api-key" || args[i] === "-k") && args[i + 1]) {
      apiKey = args[++i];
    }
    if ((args[i] === "--url" || args[i] === "-u") && args[i + 1]) {
      orchestratorUrl = args[++i];
    }
    if ((args[i] === "--user-id") && args[i + 1]) {
      externalUserId = args[++i];
    }
    if (args[i] === "--wallet-private-key" && args[i + 1]) {
      walletPrivateKey = args[++i];
    }
    if ((args[i] === "--gateway-base-url" || args[i] === "-g") && args[i + 1]) {
      gatewayBaseUrl = args[++i];
    }
    if ((args[i] === "--gateway-token" || args[i] === "-t") && args[i + 1]) {
      gatewayToken = args[++i];
    }
    if (args[i] === "--skip-gateway-registration") {
      skipGatewayRegistration = true;
    }
    if (args[i] === "--show-api-key") {
      showApiKey = true;
    }
    if (args[i] === "--show-wallet-private-key") {
      showWalletPrivateKey = true;
    }
    if (args[i] === "--signup") {
      doSignupFlow = true;
    }
  }
  const runtimeWalletPrivateKey = getRuntimeWalletPrivateKey(walletPrivateKey);

  if (!orchestratorUrl) {
    orchestratorUrl = await prompt("Orchestrator URL", "https://api.traderclaw.ai");
  }
  orchestratorUrl = orchestratorUrl.replace(/\/+$/, "");

  if (!apiKey) {
    const hasKey = await confirm("Do you already have a TraderClaw API key?");
    if (hasKey) {
      apiKey = await prompt("Enter your TraderClaw API key");
    } else {
      doSignupFlow = true;
    }
  }

  if (doSignupFlow) {
    print("\n  Signing up for a new account...\n");
    if (!externalUserId) {
      externalUserId = await prompt("External User ID (or press enter for auto-generated)", `agent_${randomUUID().slice(0, 8)}`);
    }

    try {
      const signupResult = await doSignup(orchestratorUrl, externalUserId);
      apiKey = signupResult.apiKey;
      signedUpThisSession = true;
      printSuccess(`  Signup successful!`);
      printInfo(`  Tier: ${signupResult.tier}`);
      printInfo(`  Scopes: ${signupResult.scopes.join(", ")}`);
    } catch (err) {
      printError(`Signup failed: ${err.message}`);
      process.exit(1);
    }
  }

  if (signedUpThisSession && apiKey) {
    print("\n" + "=".repeat(60));
    printWarn("  IMPORTANT: Save your TraderClaw API key");
    print("=".repeat(60));
    printInfo(`  Preview (masked): ${maskKey(apiKey)}`);
    printWarn("  Your FULL TraderClaw API key is on the next line. Copy it to a password manager before continuing.");
    printWarn(`  TraderClaw API Key: ${apiKey}`);
    printWarn("  You will need this key on new machines, for recovery, and for some CLI flows.");
    printWarn("  After setup, it is also saved in your local OpenClaw plugin config.");
    if (showApiKey) {
      printInfo("  (--show-api-key: full key is already shown above.)");
    }
    const ack = await prompt("Type API_KEY_STORED to confirm you saved this key", "");
    if (ack !== "API_KEY_STORED") {
      printError("Confirmation not provided. Aborting setup so you do not lose access to your API key.");
      process.exit(1);
    }
    printSuccess("  API key backup confirmation received.");
  }

  if (!apiKey) {
    printError("API key is required. Use --signup to create an account or provide a key.");
    process.exit(1);
  }

  print("\nEstablishing session...\n");

  const pluginConfig = {
    orchestratorUrl,
    walletId: null,
    apiKey,
    apiTimeout: 120000,
    refreshToken: undefined,
    walletPublicKey: undefined,
    agentId: "main",
  };

  let lastSeenWalletPrivateKey = runtimeWalletPrivateKey || "";
  let sessionTokens;
  try {
    sessionTokens = await establishSession(orchestratorUrl, pluginConfig, runtimeWalletPrivateKey);
  } catch (err) {
    printError(`Session establishment failed: ${err.message}`);
    if (String(err.message || "").includes("Wallet proof")) {
      printSessionTroubleshootingHint();
    }
    printWarn("Saving config without session. You can retry with: traderclaw login");

    const existingConfig = readConfig();
    setPluginConfig(existingConfig, pluginConfig);
    writeConfig(existingConfig);
    printInfo(`  Config saved to ${CONFIG_FILE}`);
    process.exit(1);
  }

  print("\nChecking system health...\n");

  const accessToken = sessionTokens.accessToken;

  try {
    const health = await httpRequest(`${orchestratorUrl}/healthz`, { accessToken });
    if (health.ok) {
      const h = health.data;
      printSuccess("  Orchestrator reachable");
      printInfo(`  Service: ${h.service || "unknown"}`);
      printInfo(`  Execution mode: ${h.executionMode || "unknown"}`);
      printInfo(`  Upstream configured: ${h.upstreamConfigured ? "yes" : "no"}`);
    } else {
      printWarn(`  Orchestrator health check returned HTTP ${health.status}`);
    }
  } catch (err) {
    printWarn(`  Health check failed: ${err.message}`);
  }

  print("\nSetting up wallet...\n");

  let walletId = null;
  let walletLabel = "";
  let createdNewWallet = false;

  try {
    const walletsRes = await httpRequest(`${orchestratorUrl}/api/wallets`, { accessToken });
    if (walletsRes.ok && Array.isArray(walletsRes.data) && walletsRes.data.length > 0) {
      const wallets = walletsRes.data;
      printInfo(`  Found ${wallets.length} existing wallet(s):`);
      wallets.forEach((w, i) => {
        print(`    ${i + 1}. ${w.label || "Unnamed"} (ID: ${w.id}, Status: ${w.status})`);
      });

      const choice = await prompt("\nUse existing wallet? Enter number or 'new' to create one", "1");

      if (choice.toLowerCase() === "new") {
        walletLabel = await prompt("Wallet label", "Trading Wallet");
        const createRes = await httpRequest(`${orchestratorUrl}/api/wallet/create`, {
          method: "POST",
          body: { label: walletLabel, strategyProfile: "aggressive", includePrivateKey: true },
          accessToken,
        });
        if (createRes.ok) {
          createdNewWallet = true;
          walletId = extractWalletId(createRes.data);
          if (!walletId) {
            throw new Error(`Wallet create response missing wallet ID: ${JSON.stringify(createRes.data)}`);
          }
          const keys = extractWalletKeys(createRes.data);
          if (keys.publicKey) pluginConfig.walletPublicKey = keys.publicKey;
          if (keys.privateKey) lastSeenWalletPrivateKey = keys.privateKey;
          printSuccess(`  Wallet created (ID: ${walletId})`);
        } else {
          printError("Failed to create wallet");
          printError(JSON.stringify(createRes.data));
          process.exit(1);
        }
      } else {
        const idx = parseInt(choice, 10) - 1;
        if (idx >= 0 && idx < wallets.length) {
          walletId = extractWalletId(wallets[idx]) || String(wallets[idx].id);
          walletLabel = wallets[idx].label || "Unnamed";
          const keys = extractWalletKeys(wallets[idx]);
          if (keys.publicKey) pluginConfig.walletPublicKey = keys.publicKey;
          if (keys.privateKey) lastSeenWalletPrivateKey = keys.privateKey;
          printSuccess(`  Using wallet: ${walletLabel} (ID: ${walletId})`);
        } else {
          walletId = extractWalletId(wallets[0]) || String(wallets[0].id);
          walletLabel = wallets[0].label || "Unnamed";
          const keys = extractWalletKeys(wallets[0]);
          if (keys.publicKey) pluginConfig.walletPublicKey = keys.publicKey;
          if (keys.privateKey) lastSeenWalletPrivateKey = keys.privateKey;
          printSuccess(`  Using wallet: ${walletLabel} (ID: ${walletId})`);
        }
      }
    } else {
      printInfo("  No existing wallets found. Creating one...");
      walletLabel = await prompt("Wallet label", "Trading Wallet");
      const createRes = await httpRequest(`${orchestratorUrl}/api/wallet/create`, {
        method: "POST",
        body: { label: walletLabel, strategyProfile: "aggressive", includePrivateKey: true },
        accessToken,
      });
      if (createRes.ok) {
        createdNewWallet = true;
        walletId = extractWalletId(createRes.data);
        if (!walletId) {
          throw new Error(`Wallet create response missing wallet ID: ${JSON.stringify(createRes.data)}`);
        }
        const keys = extractWalletKeys(createRes.data);
        if (keys.publicKey) pluginConfig.walletPublicKey = keys.publicKey;
        if (keys.privateKey) lastSeenWalletPrivateKey = keys.privateKey;
        printSuccess(`  Wallet created (ID: ${walletId})`);
      } else {
        printError("Failed to create wallet");
        printError(JSON.stringify(createRes.data));
        process.exit(1);
      }
    }
  } catch (err) {
    printError("Failed to set up wallet");
    printError(err.message || String(err));
    process.exit(1);
  }

  pluginConfig.walletId = walletId;

  if (createdNewWallet) {
    print("\n" + "=".repeat(60));
    printWarn("  IMPORTANT: New wallet credentials");
    print("=".repeat(60));
    print(`  Wallet Public Key:  ${pluginConfig.walletPublicKey || "not returned by API"}`);
    if (lastSeenWalletPrivateKey) {
      printWarn(`  Wallet Private Key: ${lastSeenWalletPrivateKey}`);
      printWarn("  Save this private key now in a secure password manager.");
      printWarn("  You may not be able to retrieve this private key again.");
      printWarn(`  For wallet proof signing, provide it at runtime via --wallet-private-key or ${WALLET_PRIVATE_KEY_ENV}.`);
      printWarn("  It is NOT saved to openclaw.json.");
    } else {
      printWarn("  Wallet private key was not returned by the API.");
      printWarn("  If this is expected custody behavior, backup via your wallet provider.");
    }

    if (lastSeenWalletPrivateKey) {
      const ack = await prompt("Type BACKED_UP to continue", "");
      if (ack !== "BACKED_UP") {
        printError("Backup confirmation not provided. Aborting setup to prevent key loss.");
        process.exit(1);
      }
      printSuccess("  Backup confirmation received.");
    }
  }

  // Re-authenticate WITH wallet proof so the saved refreshToken is accepted by
  // the server after the account has a wallet.  Without this, the gateway gets a
  // token issued pre-wallet that the server may reject on refresh.
  if (lastSeenWalletPrivateKey && pluginConfig.walletPublicKey) {
    print("\nStrengthening session with wallet proof...\n");
    try {
      pluginConfig.refreshToken = undefined;
      sessionTokens = await establishSession(orchestratorUrl, pluginConfig, lastSeenWalletPrivateKey);
      printSuccess("  Session re-established with wallet proof.");
    } catch (err) {
      printWarn(`  Wallet-proof re-auth skipped: ${err.message}`);
      printWarn(`  The gateway may need ${WALLET_PRIVATE_KEY_ENV} in its service environment.`);
    }
  }

  print("\nWriting configuration...\n");

  const existingConfig = readConfig();
  removeLegacyWalletPrivateKey(pluginConfig);
  setPluginConfig(existingConfig, pluginConfig);
  writeConfig(existingConfig);

  printSuccess(`  Config written to ${CONFIG_FILE}`);

  if (!skipGatewayRegistration) {
    print("\nGateway forwarding setup (required for event-driven wakeups)...\n");

    const defaults = buildGatewayDefaults(existingConfig);

    if (!gatewayBaseUrl) gatewayBaseUrl = defaults.gatewayBaseUrl || "";
    if (!gatewayToken) gatewayToken = defaults.gatewayToken || "";

    if (gatewayBaseUrl) {
      printInfo(`  Suggested gatewayBaseUrl: ${gatewayBaseUrl}`);
    } else if (defaults.bind === "loopback" && defaults.tailscaleMode === "off") {
      printWarn("  Gateway appears local-only (loopback + tailscale off).");
      printWarn("  For orchestrator callbacks, expose it first, e.g.:");
      printWarn("    openclaw gateway restart --bind tailnet --tailscale serve");
    }

    if (!gatewayBaseUrl) {
      gatewayBaseUrl = await prompt("Gateway base URL (public HTTPS URL reachable by orchestrator)");
    }
    if (!gatewayToken) {
      gatewayToken = await prompt("Gateway bearer token (press Enter to use API key)", apiKey);
    } else {
      printInfo(`  Using gateway token from local config: ${maskKey(gatewayToken)}`);
    }

    gatewayBaseUrl = (gatewayBaseUrl || "").replace(/\/+$/, "");
    gatewayToken = (gatewayToken || "").trim();

    if (/localhost|127\.0\.0\.1/i.test(gatewayBaseUrl)) {
      print("");
      printWarn("  ╔══════════════════════════════════════════════════════════╗");
      printWarn("  ║  WARNING: localhost gateway URL detected                ║");
      printWarn("  ╠══════════════════════════════════════════════════════════╣");
      printWarn("  ║  The orchestrator runs on a remote server and cannot    ║");
      printWarn("  ║  reach localhost on your machine. Event forwarding      ║");
      printWarn("  ║  (alpha signals, Bitquery events) will FAIL.           ║");
      printWarn("  ║                                                        ║");
      printWarn("  ║  Use a publicly reachable URL instead:                 ║");
      printWarn("  ║    - Tailscale:  https://gateway.yourname.ts.net      ║");
      printWarn("  ║    - Ngrok:      https://abc123.ngrok.io              ║");
      printWarn("  ║    - VPS/Cloud:  https://gateway.yourdomain.com       ║");
      printWarn("  ╚══════════════════════════════════════════════════════════╝");
      print("");
    }

    if (!gatewayBaseUrl || !gatewayToken) {
      printError("  gatewayBaseUrl and gatewayToken are required for registration.");
      printWarn("  Setup is stopping because gateway credentials are mandatory for event-driven startup.");
      printWarn("  Fix exposure/token and rerun: traderclaw setup");
      process.exit(1);
    }

    const putRes = await httpRequest(`${orchestratorUrl}/api/agents/gateway-credentials`, {
      method: "PUT",
      body: { gatewayBaseUrl, gatewayToken },
      accessToken,
    });
    if (!putRes.ok) {
      printError(`  Credential registration failed (HTTP ${putRes.status}): ${JSON.stringify(putRes.data)}`);
      printWarn("  Setup is stopping because gateway credentials are mandatory for event-driven startup.");
      printWarn("  Fix exposure/token and rerun: traderclaw setup");
      process.exit(1);
    }

    const getRes = await httpRequest(`${orchestratorUrl}/api/agents/gateway-credentials`, { accessToken });
    if (!getRes.ok) {
      printError(`  Credential verification failed (HTTP ${getRes.status}): ${JSON.stringify(getRes.data)}`);
      printWarn("  Setup is stopping because gateway credentials are mandatory for event-driven startup.");
      printWarn("  Fix exposure/token and rerun: traderclaw setup");
      process.exit(1);
    }

    const credentialList = Array.isArray(getRes.data?.credentials) ? getRes.data.credentials : [];
    const normalizedGatewayBaseUrl = (gatewayBaseUrl || "").replace(/\/+$/, "");
    let matchingCredentials = credentialList.filter((entry) => {
      const entryUrl = typeof entry?.gatewayBaseUrl === "string" ? entry.gatewayBaseUrl.replace(/\/+$/, "") : "";
      return entryUrl && entryUrl === normalizedGatewayBaseUrl;
    });
    if (matchingCredentials.length === 0) {
      matchingCredentials = credentialList;
    }

    const hasActiveCredential = matchingCredentials.some((entry) => entry && entry.active === true);
    const legacyActive = getNestedBool(getRes.data, "active");
    const active = hasActiveCredential || legacyActive === true;

    if (!active) {
      printError(
        `  Credential verification did not find an active credential (matched=${matchingCredentials.length}, total=${credentialList.length}, legacyActive=${String(legacyActive)}).`,
      );
      printWarn("  The orchestrator could not confirm reachability of your gateway URL.");
      printWarn("  Ensure the URL is publicly reachable and rerun: traderclaw setup");
      process.exit(1);
    }

    printSuccess("  Gateway credentials registered and active.");
    printInfo(`  Registered gatewayBaseUrl: ${gatewayBaseUrl}`);

    pluginConfig.gatewayBaseUrl = gatewayBaseUrl;
    pluginConfig.gatewayToken = gatewayToken;
    setPluginConfig(existingConfig, pluginConfig);
    writeConfig(existingConfig);
  } else {
    printWarn("  Gateway registration was skipped (--skip-gateway-registration).");
    printWarn("  The startup sequence will block before trading until credentials are active.");
  }

  print("\n" + "=".repeat(60));
  printSuccess("\n  Setup complete!\n");
  print("=".repeat(60));
  print(`
  Orchestrator:  ${orchestratorUrl}
  Wallet:        ${walletLabel} (ID: ${walletId})
  Wallet PubKey: ${pluginConfig.walletPublicKey || "not set"}
  Wallet PrivKey:${lastSeenWalletPrivateKey ? (createdNewWallet || showWalletPrivateKey ? " " + lastSeenWalletPrivateKey : " " + maskKey(lastSeenWalletPrivateKey)) : " not saved"}
  Gateway URL:   ${gatewayBaseUrl || "not set"}
  Gateway Token: ${gatewayToken ? maskKey(gatewayToken) : "not set"}
  API Key:       ${showApiKey ? apiKey : maskKey(apiKey)}
  Session:       Active (tier: ${sessionTokens.session?.tier || "?"})
  Config:        ${CONFIG_FILE}
`);
  print(`  Runtime wallet proof key source: --wallet-private-key or env ${WALLET_PRIVATE_KEY_ENV} (never openclaw.json)`);
  printWarn(
    `  For the OpenClaw gateway (Telegram/agent tools), the same env must be set on the gateway service — not only in this shell. See: ${TRADERCLAW_SESSION_TROUBLESHOOTING_URL}`,
  );
  print("Next steps:");
  print("  1. Install the plugin:     openclaw plugins install solana-traderclaw-v1 (or: npm install -g solana-traderclaw-v1)");
  print("  2. Restart the gateway:    openclaw gateway --restart");
  print("  3. Start trading:          Ask OpenClaw to scan for opportunities");
  print("");
  print("Session commands:");
  print("  traderclaw status     Check connection health (auto-refreshes session)");
  print("  traderclaw login      Re-authenticate (challenge flow)");
  print("  traderclaw logout     Revoke current session");
  print("  traderclaw config     View current configuration");
  print("");
}

async function cmdLogin(args) {
  const config = readConfig();
  const pluginConfig = getPluginConfig(config);

  if (!pluginConfig) {
    printError("No plugin configuration found. Run 'traderclaw setup' first.");
    process.exit(1);
  }

  const orchestratorUrl = pluginConfig.orchestratorUrl;

  if (!orchestratorUrl) {
    printError("orchestratorUrl not set. Run 'traderclaw setup' first.");
    process.exit(1);
  }

  if (!pluginConfig.apiKey) {
    printError("apiKey not set. Run 'traderclaw signup' or 'traderclaw setup --signup' for a new account, or 'traderclaw setup' to enter an existing key.");
    process.exit(1);
  }

  print("\nTraderClaw V1 - Login\n");
  print("=".repeat(45));

  let walletPrivateKeyArg = "";
  let forceReauth = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--wallet-private-key" && args[i + 1]) {
      walletPrivateKeyArg = args[++i];
    }
    if (args[i] === "--force-reauth") {
      forceReauth = true;
    }
  }

  if (forceReauth) {
    pluginConfig.refreshToken = undefined;
    printInfo("  --force-reauth: starting full challenge (refresh token cleared).");
  }

  const removedLegacyKey = removeLegacyWalletPrivateKey(pluginConfig);

  try {
    await establishSession(orchestratorUrl, pluginConfig, walletPrivateKeyArg);
    setPluginConfig(config, pluginConfig);
    writeConfig(config);
    printSuccess("\n  Session established and saved.");
    if (removedLegacyKey) {
      printWarn("  Removed deprecated walletPrivateKey from openclaw.json.");
    }
    printInfo(`  For wallet proof after refresh expires, pass --wallet-private-key or set ${WALLET_PRIVATE_KEY_ENV} (gateway service needs the env too — see docs).`);
    print("  Restart the gateway for changes to take effect: openclaw gateway --restart");
    print("  Full re-challenge (e.g. after logout): traderclaw login --force-reauth\n");
  } catch (err) {
    printError(`Login failed: ${err.message}`);
    if (String(err.message || "").includes("Wallet proof") || String(err.message || "").includes("private key")) {
      printSessionTroubleshootingHint();
    }
    process.exit(1);
  }
}

async function cmdLogout() {
  const config = readConfig();
  const pluginConfig = getPluginConfig(config);

  if (!pluginConfig) {
    printError("No plugin configuration found.");
    process.exit(1);
  }

  const orchestratorUrl = pluginConfig.orchestratorUrl;

  print("\nTraderClaw V1 - Logout\n");

  if (pluginConfig.refreshToken) {
    try {
      const ok = await doLogout(orchestratorUrl, pluginConfig.refreshToken);
      if (ok) {
        printSuccess("  Session revoked on server.");
      } else {
        printWarn("  Server logout returned non-OK (session may already be expired).");
      }
    } catch (err) {
      printWarn(`  Server logout failed: ${err.message}`);
    }
  }

  pluginConfig.refreshToken = undefined;
  const removedLegacyKey = removeLegacyWalletPrivateKey(pluginConfig);
  setPluginConfig(config, pluginConfig);
  writeConfig(config);

  printSuccess("  Local session cleared.");
  if (removedLegacyKey) {
    printWarn("  Removed deprecated walletPrivateKey from openclaw.json.");
  }
  print("  Run 'traderclaw login' to re-authenticate (your API key must still be in config).");
  print("  New account or lost API key: run 'traderclaw signup' or 'traderclaw setup --signup' on this machine — not via the agent.");
  print("  Wallet challenges are signed locally; the private key never leaves this system.\n");
}

async function cmdStatus() {
  const config = readConfig();
  const pluginConfig = getPluginConfig(config);

  if (!pluginConfig) {
    printError("No plugin configuration found. Run 'traderclaw setup' first.");
    process.exit(1);
  }

  const orchestratorUrl = pluginConfig.orchestratorUrl;
  const walletId = pluginConfig.walletId;

  if (!orchestratorUrl) {
    printError("orchestratorUrl not set in config. Run 'traderclaw setup' to fix.");
    process.exit(1);
  }

  print("\nTraderClaw V1 - Status\n");
  print("=".repeat(45));

  let accessToken = null;

  if (pluginConfig.refreshToken) {
    try {
      const tokens = await doRefresh(orchestratorUrl, pluginConfig.refreshToken);
      if (tokens) {
        accessToken = tokens.accessToken;
        pluginConfig.refreshToken = tokens.refreshToken;
        removeLegacyWalletPrivateKey(pluginConfig);
        setPluginConfig(config, pluginConfig);
        writeConfig(config);
        printSuccess("  Session:          ACTIVE");
        printInfo(`  Tier:             ${tokens.session?.tier || "?"}`);
        printInfo(`  Scopes:           ${(tokens.session?.scopes || []).join(", ")}`);
      } else {
        printWarn("  Session:          EXPIRED (run 'traderclaw login')");
      }
    } catch (err) {
      printWarn(`  Session:          ERROR (${err.message})`);
    }
  } else if (pluginConfig.apiKey) {
    printWarn("  Session:          NOT ESTABLISHED (run 'traderclaw login' to authenticate)");
  } else {
    printError("  Session:          NO CREDENTIALS (run 'traderclaw setup')");
  }

  const authOpts = accessToken ? { accessToken, timeout: 5000 } : { timeout: 5000 };

  try {
    const health = await httpRequest(`${orchestratorUrl}/healthz`, authOpts);
    if (health.ok) {
      const h = health.data;
      printSuccess("  Orchestrator:     CONNECTED");
      printInfo(`  Execution mode:   ${h.executionMode || "unknown"}`);
      printInfo(`  Upstream:         ${h.upstreamConfigured ? "configured" : "not configured"}`);
    } else {
      printError(`  Orchestrator:     ERROR (HTTP ${health.status})`);
    }
  } catch (err) {
    printError("  Orchestrator:     UNREACHABLE");
    printError(`  ${err.message || String(err)}`);
  }

  try {
    const statusRes = await httpRequest(`${orchestratorUrl}/api/system/status`, authOpts);
    if (statusRes.ok) {
      const s = statusRes.data;
      printSuccess("  System status:    OK");
      if (s.wsConnections !== undefined) printInfo(`  WS connections:   ${s.wsConnections}`);
    }
  } catch {
    printWarn("  System status:    unavailable");
  }

  try {
    const credsRes = await httpRequest(`${orchestratorUrl}/api/agents/gateway-credentials`, authOpts);
    if (credsRes.ok && credsRes.data && Array.isArray(credsRes.data.credentials)) {
      const activeCreds = credsRes.data.credentials.filter((entry) => entry && entry.active);
      printInfo(`  Gateway creds:    ${activeCreds.length > 0 ? "active" : "missing/inactive"} (${activeCreds.length})`);
      if (activeCreds.length > 0) {
        const primary = activeCreds.find((entry) => (entry.agentId || "main") === (pluginConfig.agentId || "main")) || activeCreds[0];
        printInfo(`  Gateway agent:    ${primary.agentId || "default"}`);
        printInfo(`  Gateway lastUsed: ${primary.lastUsedAt || "never"}`);
      }
    } else {
      printWarn("  Gateway creds:    unavailable");
    }
  } catch {
    printWarn("  Gateway creds:    unavailable");
  }

  print("");

  if (walletId) {
    try {
      const capitalRes = await httpRequest(`${orchestratorUrl}/api/capital/status?walletId=${walletId}`, authOpts);
      if (capitalRes.ok) {
        const c = capitalRes.data;
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
      const ksRes = await httpRequest(`${orchestratorUrl}/api/killswitch/status?walletId=${walletId}`, authOpts);
      if (ksRes.ok) {
        const ks = ksRes.data;
        if (ks.enabled) {
          printWarn(`  Kill switch:      ENABLED (${ks.mode})`);
        } else {
          printInfo("  Kill switch:      disabled");
        }
      }
    } catch {
      /* skip */
    }

    try {
      const stratRes = await httpRequest(`${orchestratorUrl}/api/strategy/state?walletId=${walletId}`, authOpts);
      if (stratRes.ok) {
        const st = stratRes.data;
        printInfo(`  Strategy version: ${st.strategyVersion || "?"}`);
        printInfo(`  Mode:             ${st.mode || "HARDENED"}`);
      }
    } catch {
      /* skip */
    }
  }

  print("\n" + "=".repeat(45));
  print("");
}

async function cmdConfig(subArgs) {
  const subCmd = subArgs[0] || "show";

  if (subCmd === "show") {
    const config = readConfig();
    const pluginConfig = getPluginConfig(config);

    if (!pluginConfig) {
      printError("No plugin configuration found. Run 'traderclaw setup' first.");
      process.exit(1);
    }

    print("\nTraderClaw V1 - Configuration\n");
    print("=".repeat(45));
    print(`  Config file:      ${CONFIG_FILE}`);
    print(`  Orchestrator URL: ${pluginConfig.orchestratorUrl || "not set"}`);
    print(`  Gateway URL:      ${pluginConfig.gatewayBaseUrl || "not set"}`);
    print(`  Gateway Token:    ${pluginConfig.gatewayToken ? maskKey(pluginConfig.gatewayToken) : "not set"}`);
    print(`  Wallet ID:        ${pluginConfig.walletId ?? "not set"}`);
    print(`  API Key:          ${pluginConfig.apiKey ? maskKey(pluginConfig.apiKey) : "not set"}`);
    print(`  Refresh Token:    ${pluginConfig.refreshToken ? maskKey(pluginConfig.refreshToken) : "not set"}`);
    print(`  Wallet Pub Key:   ${pluginConfig.walletPublicKey || "not set"}`);
    print(`  Wallet Priv Key:  runtime-only via --wallet-private-key or ${WALLET_PRIVATE_KEY_ENV}`);
    print(`  Agent ID:         ${pluginConfig.agentId || "not set"}`);
    print(`  API Timeout:      ${pluginConfig.apiTimeout || 120000}ms`);
    print("=".repeat(45));
    print("");
    return;
  }

  if (subCmd === "set") {
    const key = subArgs[1];
    const value = subArgs[2];

    if (!key || !value) {
      printError("Usage: traderclaw config set <key> <value>");
      print("  Available keys: orchestratorUrl, walletId, apiKey, apiTimeout, refreshToken, walletPublicKey, gatewayBaseUrl, gatewayToken, agentId");
      process.exit(1);
    }

    if (key === "walletPrivateKey") {
      printError(
        `walletPrivateKey is no longer stored in openclaw.json. Use --wallet-private-key or env ${WALLET_PRIVATE_KEY_ENV} at runtime instead.`,
      );
      process.exit(1);
    }

    const allowedKeys = ["orchestratorUrl", "walletId", "apiKey", "apiTimeout", "refreshToken", "walletPublicKey", "gatewayBaseUrl", "gatewayToken", "agentId"];
    if (!allowedKeys.includes(key)) {
      printError(`Unknown config key: ${key}`);
      print(`  Available keys: ${allowedKeys.join(", ")}`);
      process.exit(1);
    }

    const config = readConfig();
    const pluginConfig = getPluginConfig(config) || {};

    let parsedValue = value;
    if (key === "walletId") {
      const num = parseInt(value, 10);
      parsedValue = isNaN(num) ? value : num;
    }
    if (key === "apiTimeout") {
      parsedValue = parseInt(value, 10);
      if (isNaN(parsedValue)) {
        printError("apiTimeout must be a number (milliseconds)");
        process.exit(1);
      }
    }

    removeLegacyWalletPrivateKey(pluginConfig);
    pluginConfig[key] = parsedValue;
    setPluginConfig(config, pluginConfig);
    writeConfig(config);

    const sensitiveKeys = ["apiKey", "refreshToken"];
    printSuccess(`Set ${key} = ${sensitiveKeys.includes(key) ? maskKey(value) : value}`);
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
    if (config.plugins && config.plugins.entries) {
      delete config.plugins.entries[PLUGIN_ID];
    }
    writeConfig(config);
    printSuccess("Plugin configuration removed.");
    return;
  }

  printError(`Unknown config subcommand: ${subCmd}`);
  print("  Available: show, set, reset");
  process.exit(1);
}

function parseInstallWizardArgs(args) {
  const out = {
    port: 17890,
    lane: "event-driven",
    apiKey: "",
    llmProvider: "",
    llmModel: "",
    llmCredential: "",
    orchestratorUrl: "https://api.traderclaw.ai",
    gatewayBaseUrl: "",
    gatewayToken: "",
    enableTelegram: false,
    telegramToken: "",
  };

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const next = args[i + 1];
    if (key === "--port" && next) out.port = Number.parseInt(args[++i], 10) || 17890;
    if (key === "--lane" && next) out.lane = next === "quick-local" ? "quick-local" : "event-driven";
    if ((key === "--api-key" || key === "-k") && next) out.apiKey = args[++i];
    if (key === "--llm-provider" && next) out.llmProvider = args[++i];
    if (key === "--llm-model" && next) out.llmModel = args[++i];
    if ((key === "--llm-api-key" || key === "--llm-token") && next) out.llmCredential = args[++i];
    if ((key === "--url" || key === "-u") && next) out.orchestratorUrl = args[++i];
    if ((key === "--gateway-base-url" || key === "-g") && next) out.gatewayBaseUrl = args[++i];
    if ((key === "--gateway-token" || key === "-t") && next) out.gatewayToken = args[++i];
    if (key === "--with-telegram") out.enableTelegram = true;
    if (key === "--telegram-token" && next) out.telegramToken = args[++i];
  }
  return out;
}

function parsePrecheckArgs(args) {
  const out = {
    mode: "dry-run",
    outputPath: "",
    orchestratorUrl: "https://api.traderclaw.ai",
    expectedNodeMajor: 22,
  };

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const next = args[i + 1];
    if (key === "--allow-install") out.mode = "allow-install";
    if (key === "--dry-run") out.mode = "dry-run";
    if (key === "--output" && next) out.outputPath = args[++i];
    if (key.startsWith("--output=")) out.outputPath = key.slice("--output=".length);
    if (key === "--url" && next) out.orchestratorUrl = args[++i];
    if (key === "--expected-node-major" && next) {
      const parsed = Number.parseInt(args[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) out.expectedNodeMajor = parsed;
    }
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function appendOutput(outputPath, line) {
  if (!outputPath) return;
  appendFileSync(outputPath, `${line}\n`, "utf-8");
}

function makePrecheckLogger(outputPath) {
  const counters = { pass: 0, fail: 0, warn: 0 };
  const log = (level, message) => {
    const line = `${nowIso()} [${level}] ${message}`;
    print(line);
    appendOutput(outputPath, line);
    if (level === "PASS") counters.pass += 1;
    if (level === "FAIL") counters.fail += 1;
    if (level === "WARN") counters.warn += 1;
  };
  return {
    counters,
    info: (m) => log("INFO", m),
    pass: (m) => log("PASS", m),
    fail: (m) => log("FAIL", m),
    warn: (m) => log("WARN", m),
  };
}

function nodeMajorVersion() {
  const v = getCommandOutput("node -v");
  if (!v) return 0;
  const parsed = Number.parseInt(v.replace(/^v/i, "").split(".")[0], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function cmdPrecheck(args) {
  const opts = parsePrecheckArgs(args);
  if (opts.outputPath) {
    writeFileSync(opts.outputPath, "", "utf-8");
  }
  const log = makePrecheckLogger(opts.outputPath);

  log.info("Starting TraderClaw precheck");
  log.info(`Mode: ${opts.mode}`);
  log.info(`Orchestrator URL: ${opts.orchestratorUrl}`);

  if (!commandExists("node")) {
    log.fail("node exists in PATH");
  } else {
    const major = nodeMajorVersion();
    if (major >= opts.expectedNodeMajor) {
      log.pass(`node major >= ${opts.expectedNodeMajor} (found v${major})`);
    } else {
      log.fail(`node major >= ${opts.expectedNodeMajor} (found v${major})`);
    }
  }

  if (commandExists("npm")) log.pass("npm exists in PATH");
  else log.fail("npm exists in PATH");

  if (commandExists("openclaw")) {
    log.pass("openclaw exists in PATH");
  } else if (opts.mode === "allow-install") {
    log.info("Installing openclaw (allow-install mode)");
    try {
      execSync("npm install -g openclaw", { stdio: "ignore" });
      if (commandExists("openclaw")) log.pass("openclaw installed successfully");
      else log.fail("openclaw install completed but command is still missing");
    } catch {
      log.fail("openclaw install failed");
    }
  } else {
    log.warn("openclaw missing (dry-run mode, not installing)");
  }

  if (commandExists("tailscale")) {
    log.pass("tailscale exists in PATH");
  } else if (opts.mode === "allow-install") {
    log.info("Installing tailscale (allow-install mode)");
    try {
      execSync("bash -lc \"if command -v sudo >/dev/null 2>&1; then sudo bash -lc 'curl -fsSL https://tailscale.com/install.sh | sh'; else curl -fsSL https://tailscale.com/install.sh | sh; fi\"", { stdio: "inherit" });
      if (commandExists("tailscale")) log.pass("tailscale installed successfully");
      else log.fail("tailscale install completed but command is still missing");
    } catch {
      log.fail("tailscale install failed");
      log.warn("If this is a sudo/permission issue, run: sudo bash -lc 'curl -fsSL https://tailscale.com/install.sh | sh'");
    }
  } else {
    log.warn("tailscale missing (dry-run mode, not installing)");
  }

  try {
    const orchestrator = await httpRequest(`${opts.orchestratorUrl.replace(/\/+$/, "")}/healthz`, { timeout: 10000 });
    if (orchestrator.ok) log.pass(`orchestrator health endpoint reachable (${opts.orchestratorUrl.replace(/\/+$/, "")}/healthz)`);
    else log.warn(`orchestrator health endpoint returned HTTP ${orchestrator.status} (${opts.orchestratorUrl.replace(/\/+$/, "")}/healthz)`);
  } catch {
    log.warn(`orchestrator health endpoint not reachable (${opts.orchestratorUrl.replace(/\/+$/, "")}/healthz)`);
  }

  if (commandExists("openclaw")) {
    try {
      execSync("openclaw gateway status", { stdio: "ignore" });
      log.pass("openclaw gateway status command succeeded");
    } catch {
      log.warn("openclaw gateway status returned non-zero");
    }
  } else {
    log.warn("skipping gateway status check (openclaw missing)");
  }

  log.info("Manual staging run commands:");
  log.info("  1) traderclaw install --wizard");
  log.info("  2) In wizard, set LLM provider + credential and Telegram token");
  log.info("  3) Approve tailscale login in provided URL");
  log.info("  4) Confirm /v1/responses returns non-404 on funnel host");
  log.info("  5) Verify Telegram channel setup + probe");
  log.info("  6) Startup prompt check: solana_system_status, solana_alpha_subscribe, solana_positions");
  log.info(`Precheck summary: pass=${log.counters.pass} fail=${log.counters.fail} warn=${log.counters.warn}`);

  if (log.counters.fail > 0) process.exitCode = 1;
}

function openBrowser(url) {
  try {
    execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1_000_000) {
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function loadWizardLlmCatalog() {
  const supportedProviders = new Set([
    "anthropic",
    "openai",
    "openai-codex",
    "openrouter",
    "groq",
    "mistral",
    "google",
    "google-vertex",
  ]);
  const fallback = {
    source: "fallback",
    providers: [
      {
        id: "anthropic",
        models: [{ id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6 (recommended default)" }],
      },
      {
        id: "openai",
        models: [{ id: "openai/gpt-5.4", name: "GPT-5.4" }],
      },
    ],
  };

  if (!commandExists("openclaw")) {
    return { ...fallback, warning: "openclaw_not_found" };
  }

  try {
    const raw = execSync("openclaw models list --all --json", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(raw);
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    const providerMap = new Map();
    for (const entry of models) {
      if (!entry || typeof entry.key !== "string") continue;
      const modelId = String(entry.key);
      const slash = modelId.indexOf("/");
      if (slash <= 0 || slash === modelId.length - 1) continue;
      const provider = modelId.slice(0, slash);
      const existing = providerMap.get(provider) || [];
      existing.push({
        id: modelId,
        name: typeof entry.name === "string" && entry.name.trim() ? entry.name : modelId,
      });
      providerMap.set(provider, existing);
    }

    const providers = [...providerMap.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((id) => {
        const rawModels = providerMap.get(id) || [];
        const sortedIds = sortModelsByPreference(
          id,
          rawModels.map((m) => m.id),
        );
        const byId = new Map(rawModels.map((m) => [m.id, m]));
        const models = sortedIds.map((mid) => byId.get(mid)).filter(Boolean);
        return { id, models };
      })
      .filter((entry) => supportedProviders.has(entry.id))
      .filter((entry) => entry.models.length > 0);

    if (providers.length === 0) {
      return { ...fallback, warning: "openclaw_model_catalog_empty" };
    }

    return {
      source: "openclaw",
      providers,
      generatedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ...fallback,
      warning: `openclaw_models_list_failed: ${err?.message || String(err)}`,
    };
  }
}

function wizardHtml(defaults) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>TraderClaw Installer Wizard</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background:#0b1020; color:#e8eef9; margin:0; }
      .wrap { max-width: 980px; margin: 24px auto; padding: 0 16px; }
      .card { background:#121a31; border:1px solid #22315a; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
      .grid { display:grid; grid-template-columns:1fr 1fr; gap: 12px; }
      label { display:block; font-size: 12px; color:#9cb0de; margin-bottom: 4px; }
      input, select { width:100%; padding:10px; border-radius:8px; border:1px solid #334a87; background:#0d1530; color:#e8eef9; }
      button { border:0; border-radius:8px; padding:10px 14px; background:#4d7cff; color:#fff; cursor:pointer; font-weight:600; }
      button:disabled { opacity:0.6; cursor:not-allowed; }
      .muted { color:#9cb0de; font-size:13px; }
      .ok { color:#78f0a9; }
      .warn { color:#ffd166; }
      .err { color:#ff6b6b; }
      code { background:#0d1530; padding:2px 6px; border-radius:6px; }
      pre { background:#0d1530; border:1px solid #22315a; border-radius:8px; padding:12px; max-height:300px; overflow:auto; }
      table { width:100%; border-collapse: collapse; }
      td, th { border-bottom:1px solid #22315a; padding:8px; font-size:13px; text-align:left; }
      .cta { background:#0d2a1d; border:1px solid #1f7a47; border-radius:10px; padding:12px; margin-bottom:10px; }
      .cta h4 { margin:0 0 6px 0; color:#8ef5bc; font-size:14px; }
      .cta .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .cta a, .cta code { color:#b9ffda; word-break:break-all; }
      .cta button { background:#2f9a5f; padding:8px 10px; font-size:12px; }
      .cta .important { color:#ffe08a; font-weight:700; margin:8px 0 6px 0; }
      .checkout { background:#10263f; border:1px solid #2e5785; border-radius:12px; padding:18px; }
      .checkout h2 { margin:0 0 8px 0; color:#9ee6ff; font-size:24px; }
      .checkout p { margin:0 0 12px 0; }
      .checkout-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px; }
      .checkout-row code { flex:1 1 560px; font-size:13px; padding:10px; }
      .checkout-row button { background:#2d7dff; padding:10px 12px; font-size:13px; }
      .checkout-finish { margin-top:14px; background:#2f9a5f; font-size:14px; padding:10px 14px; }
      .hidden { display:none; }
      .loading-hint { display:flex; align-items:center; gap:8px; margin-top:8px; color:#9cb0de; font-size:13px; }
      .loading-hint.hidden { display:none; }
      .spinner { width:14px; height:14px; border:2px solid #334a87; border-top-color:#8daeff; border-radius:50%; animation:spin 0.8s linear infinite; flex:0 0 auto; }
      .muted a { color:#9fd3ff; }
      .muted a:hover { color:#c5e5ff; }
      @keyframes spin { to { transform:rotate(360deg); } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card" id="introCard">
        <h2>TraderClaw Linux Installer Wizard</h2>
        <p class="muted">install core services first, then finish wallet setup in your VPS shell.</p>
      </div>
      <div class="card" id="llmCard">
        <h3>Required: OpenClaw LLM Provider</h3>
        <p class="muted">Pick your LLM provider and paste your credential. Beginner mode supports common API-key providers.</p>
        <div class="grid">
          <div>
            <label>LLM provider (required)</label>
            <select id="llmProvider"></select>
          </div>
          <div>
            <label>LLM model (advanced, optional)</label>
            <select id="llmModel"></select>
          </div>
        </div>
        <div style="margin-top:8px;">
          <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:#9cb0de;">
            <input id="llmModelManual" type="checkbox" style="width:auto; padding:0; margin:0;" />
            Choose model manually (advanced)
          </label>
        </div>
        <div style="margin-top:12px;">
          <label>LLM API key or token (required)</label>
          <input id="llmCredential" type="password" placeholder="Paste the credential for the selected provider/model" />
          <p class="muted">This credential is written to OpenClaw model provider config so your agent can run. If you skip manual model selection, the installer will choose a safe provider default.</p>
          <p class="muted" id="llmLoadState" aria-live="polite">Loading LLM provider catalog...</p>
          <div id="llmLoadingHint" class="loading-hint" role="status" aria-live="polite">
            <span class="spinner" aria-hidden="true"></span>
            <span id="llmLoadingHintText">Fetching provider list...</span>
          </div>
        </div>
      </div>
      <div class="card" id="startCard">
        <div class="grid">
          <div>
            <label>Telegram bot token (required)</label>
            <input id="telegramToken" value="${defaults.telegramToken}" placeholder="Paste your bot token from BotFather" autofocus />
            <p class="muted">Required for guided onboarding and immediate bot readiness. Need one? <a href="https://core.telegram.org/bots#how-do-i-create-a-bot" target="_blank" rel="noopener noreferrer">Create a Telegram bot token (official docs)</a>.</p>
          </div>
          <div>
            <label>TraderClaw API key (optional for existing users)</label>
            <input id="apiKey" value="${defaults.apiKey}" placeholder="Leave blank if you are new — setup will create your account" />
            <p class="muted">Already have a TraderClaw account? Paste your API key here. New users: leave empty.</p>
          </div>
        </div>
        <button id="start" disabled>Start Installation</button>
      </div>
      <div class="card" id="statusCard">
        <h3>Status: <span id="status">idle</span></h3>
        <p class="muted">Watch progress below. Key links and next actions appear here automatically.</p>
        <div id="ctaBox" class="hidden">
          <div id="tailscaleCta" class="cta hidden">
            <h4>Approve Tailscale</h4>
            <p class="important">Important: open the link, complete sign-in, then return to this same wizard page.</p>
            <p class="muted">After you approve Tailscale in the browser, this installer continues from here automatically.</p>
            <div class="row">
              <a id="tailscaleLink" href="#" target="_blank" rel="noopener noreferrer"></a>
            </div>
          </div>
          <div id="funnelAdminCta" class="cta hidden">
            <h4>Enable Tailscale Funnel</h4>
            <p class="important">Important: open this link in your browser, enable Funnel for this node if prompted, then return to this same wizard page.</p>
            <p class="muted">The installer continues automatically after Tailscale Funnel is allowed for your tailnet.</p>
            <div class="row">
              <a id="funnelAdminLink" href="#" target="_blank" rel="noopener noreferrer"></a>
            </div>
          </div>
          <div id="funnelCta" class="cta hidden">
            <h4>Gateway public URL (Funnel)</h4>
            <p class="important">Your gateway may be reachable at the URL below once Funnel is enabled. Keep this page open while installation finishes.</p>
            <p class="muted">If the URL does not load yet, finish the Tailscale Funnel step above first.</p>
            <div class="row">
              <a id="funnelLink" href="#" target="_blank" rel="noopener noreferrer"></a>
            </div>
          </div>
          <div id="setupCta" class="cta hidden">
            <h4>Final setup will appear when install completes</h4>
            <p class="muted">When complete, a final checkout screen will show your commands and finish action.</p>
          </div>
        </div>
        <div id="ready" class="ok"></div>
        <pre id="manual" class="err"></pre>
        <table>
          <thead><tr><th>Step</th><th>Status</th><th>Detail</th></tr></thead>
          <tbody id="steps"></tbody>
        </table>
      </div>
      <div class="card" id="logsCard">
        <h3>Live Logs</h3>
        <pre id="logs"></pre>
      </div>
      <div class="card checkout hidden" id="completionScreen">
        <h2>You Made It - Wizard Complete</h2>
        <p class="muted">TraderClaw core installation is done. Run these 2 commands in your VPS shell to finish setup and go live.</p>
        <p class="muted">Before trading, continue with the remaining checklist in the install guide: <a href="https://docs.traderclaw.ai/" target="_blank" rel="noopener noreferrer">https://docs.traderclaw.ai/</a></p>
        <p class="ok" id="setupSuccessText"></p>
        <div class="checkout-row">
          <code id="setupCommand"></code>
          <button id="copySetupCommand" type="button">Copy setup command</button>
        </div>
        <div class="checkout-row">
          <code id="restartCommand"></code>
          <button id="copyRestartCommand" type="button">Copy restart command</button>
        </div>
        <button id="finishWizard" type="button" class="checkout-finish">Finish & Return to Shell</button>
      </div>
    </div>
    <script>
      const stateEl = document.getElementById("status");
      const readyEl = document.getElementById("ready");
      const manualEl = document.getElementById("manual");
      const stepsEl = document.getElementById("steps");
      const logsEl = document.getElementById("logs");
      const ctaBoxEl = document.getElementById("ctaBox");
      const tailscaleCtaEl = document.getElementById("tailscaleCta");
      const tailscaleLinkEl = document.getElementById("tailscaleLink");
      const funnelAdminCtaEl = document.getElementById("funnelAdminCta");
      const funnelAdminLinkEl = document.getElementById("funnelAdminLink");
      const funnelCtaEl = document.getElementById("funnelCta");
      const funnelLinkEl = document.getElementById("funnelLink");
      const setupCtaEl = document.getElementById("setupCta");
      const setupSuccessTextEl = document.getElementById("setupSuccessText");
      const setupCommandEl = document.getElementById("setupCommand");
      const restartCommandEl = document.getElementById("restartCommand");
      const copySetupBtn = document.getElementById("copySetupCommand");
      const copyRestartBtn = document.getElementById("copyRestartCommand");
      const finishWizardBtn = document.getElementById("finishWizard");
      const llmProviderEl = document.getElementById("llmProvider");
      const llmModelEl = document.getElementById("llmModel");
      const llmModelManualEl = document.getElementById("llmModelManual");
      const llmCredentialEl = document.getElementById("llmCredential");
      const telegramTokenEl = document.getElementById("telegramToken");
      const llmLoadStateEl = document.getElementById("llmLoadState");
      const llmLoadingHintEl = document.getElementById("llmLoadingHint");
      const llmLoadingHintTextEl = document.getElementById("llmLoadingHintText");
      const startBtn = document.getElementById("start");
      const llmCardEl = document.getElementById("llmCard");
      const startCardEl = document.getElementById("startCard");
      const statusCardEl = document.getElementById("statusCard");
      const logsCardEl = document.getElementById("logsCard");
      const completionScreenEl = document.getElementById("completionScreen");
      let llmCatalog = { providers: [] };
      let llmCatalogReady = false;
      let llmCatalogLoading = false;
      let llmLoadTicker = null;
      let llmLoadStartedAt = 0;
      let announcedTailscaleUrl = "";
      let announcedFunnelAdminUrl = "";
      let pollTimer = null;
      let pollIntervalMs = 1200;

      function hasRequiredInputs() {
        return (
          llmCatalogReady
          && Boolean(llmProviderEl.value.trim())
          && Boolean(llmCredentialEl.value.trim())
          && Boolean(telegramTokenEl.value.trim())
        );
      }

      function updateStartButtonState() {
        startBtn.disabled = !hasRequiredInputs();
      }

      function stopLlmLoadTicker() {
        if (llmLoadTicker) {
          clearInterval(llmLoadTicker);
          llmLoadTicker = null;
        }
      }

      function setLlmCatalogLoading(loading) {
        llmCatalogLoading = loading;
        llmProviderEl.disabled = loading;
        llmModelManualEl.disabled = loading;
        llmModelEl.disabled = loading || !llmModelManualEl.checked;
        if (loading) {
          llmLoadStartedAt = Date.now();
          llmLoadingHintEl.classList.remove("hidden");
          startBtn.textContent = "Loading providers...";
          const updateHint = () => {
            const elapsedSeconds = Math.max(1, Math.floor((Date.now() - llmLoadStartedAt) / 1000));
            if (elapsedSeconds >= 8) {
              llmLoadingHintTextEl.textContent = "Still loading provider catalog (" + elapsedSeconds + "s). First run can take up to ~20s.";
              return;
            }
            llmLoadingHintTextEl.textContent = "Fetching provider list (" + elapsedSeconds + "s)...";
          };
          updateHint();
          stopLlmLoadTicker();
          llmLoadTicker = setInterval(updateHint, 1000);
          updateStartButtonState();
          return;
        }
        stopLlmLoadTicker();
        llmLoadingHintEl.classList.add("hidden");
        startBtn.textContent = "Start Installation";
        llmLoadStartedAt = 0;
        llmModelEl.disabled = !llmModelManualEl.checked;
        updateStartButtonState();
      }

      function setLlmCatalogReady(ready, message, isError = false) {
        llmCatalogReady = ready;
        llmLoadStateEl.textContent = message;
        llmLoadStateEl.className = isError ? "err" : "muted";
        updateStartButtonState();
      }

      function setSelectOptions(selectEl, items, value) {
        selectEl.innerHTML = "";
        items.forEach((item) => {
          const option = document.createElement("option");
          option.value = item.value;
          option.textContent = item.label;
          selectEl.appendChild(option);
        });
        if (value) selectEl.value = value;
      }

      function refreshModelOptions(preferredModel) {
        const provider = llmProviderEl.value;
        const providerEntry = (llmCatalog.providers || []).find((entry) => entry.id === provider);
        const modelItems = (providerEntry ? providerEntry.models : []).map((item) => ({ value: item.id, label: item.name + " (" + item.id + ")" }));
        if (modelItems.length === 0) {
          setSelectOptions(llmModelEl, [{ value: "", label: "No models available for provider" }], "");
          updateStartButtonState();
          return;
        }
        setSelectOptions(llmModelEl, modelItems, preferredModel || modelItems[0].value);
        llmModelEl.disabled = !llmModelManualEl.checked;
        updateStartButtonState();
      }

      async function loadLlmCatalog() {
        setLlmCatalogLoading(true);
        setSelectOptions(llmProviderEl, [{ value: "", label: "Loading providers..." }], "");
        setSelectOptions(llmModelEl, [{ value: "", label: "Loading models..." }], "");
        setLlmCatalogReady(false, "Loading LLM provider catalog... this can take a few seconds.");
        try {
          const res = await fetch("/api/llm/options");
          const data = await res.json();
          llmCatalog = data || { providers: [] };
          const providers = (llmCatalog.providers || []).map((entry) => ({ value: entry.id, label: entry.id }));
          if (providers.length === 0) {
            setSelectOptions(llmProviderEl, [{ value: "", label: "No providers available" }], "");
            refreshModelOptions("");
            setLlmCatalogReady(false, "No LLM providers were found from OpenClaw. Please check OpenClaw model setup.", true);
            return;
          }
          setSelectOptions(llmProviderEl, providers, "${defaults.llmProvider}");
          refreshModelOptions("${defaults.llmModel}");
          setLlmCatalogReady(true, "LLM providers loaded. Select provider and paste credential to continue. Model selection is optional.");
        } catch (err) {
          setLlmCatalogReady(false, "Failed to load LLM providers. Check OpenClaw and reload this page.", true);
          manualEl.textContent = "Failed to load LLM provider catalog: " + (err && err.message ? err.message : String(err));
        } finally {
          setLlmCatalogLoading(false);
        }
      }

      function showUrlCta(containerEl, linkEl, value) {
        if (!value) {
          containerEl.classList.add("hidden");
          linkEl.textContent = "";
          linkEl.removeAttribute("href");
          return;
        }
        ctaBoxEl.classList.remove("hidden");
        containerEl.classList.remove("hidden");
        linkEl.href = value;
        linkEl.textContent = value;
      }

      function setCheckoutMode(enabled) {
        if (enabled) {
          llmCardEl.classList.add("hidden");
          startCardEl.classList.add("hidden");
          statusCardEl.classList.add("hidden");
          logsCardEl.classList.add("hidden");
          completionScreenEl.classList.remove("hidden");
          return;
        }
        llmCardEl.classList.remove("hidden");
        startCardEl.classList.remove("hidden");
        statusCardEl.classList.remove("hidden");
        logsCardEl.classList.remove("hidden");
        completionScreenEl.classList.add("hidden");
      }

      async function startInstall() {
        if (!llmCatalogReady) {
          stateEl.textContent = "blocked";
          readyEl.textContent = "";
          manualEl.textContent = llmCatalogLoading
            ? "LLM provider catalog is still loading. Wait until the loading indicator finishes."
            : "LLM provider catalog is not ready yet. Reload the page and try again.";
          return;
        }
        stateEl.textContent = "starting";
        manualEl.textContent = "";
        readyEl.textContent = "Starting installation...";

        const payload = {
          llmProvider: llmProviderEl.value.trim(),
          llmModel: llmModelManualEl.checked ? llmModelEl.value.trim() : "",
          llmCredential: llmCredentialEl.value.trim(),
          apiKey: document.getElementById("apiKey").value.trim(),
          telegramToken: document.getElementById("telegramToken").value.trim()
        };
        if (!payload.llmProvider || !payload.llmCredential) {
          stateEl.textContent = "blocked";
          readyEl.textContent = "";
          manualEl.textContent = "LLM provider and credential are required before starting installation.";
          return;
        }
        if (!payload.telegramToken) {
          stateEl.textContent = "blocked";
          readyEl.textContent = "";
          manualEl.textContent = "Telegram bot token is required before starting installation.";
          return;
        }

        try {
          const res = await fetch("/api/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json().catch(() => ({}));

          if (!res.ok) {
            stateEl.textContent = "failed";
            manualEl.textContent = data.error ? "Failed to start: " + data.error : "Failed to start installation.";
            readyEl.textContent = "";
            return;
          }

          readyEl.textContent = "Installation started. Live progress will appear below.";
          announcedTailscaleUrl = "";
          announcedFunnelAdminUrl = "";
          await refresh();
        } catch (err) {
          stateEl.textContent = "failed";
          manualEl.textContent = "Failed to start installation: " + (err && err.message ? err.message : String(err));
          readyEl.textContent = "";
        }
      }

      function setPollInterval(ms) {
        if (ms === pollIntervalMs && pollTimer) return;
        pollIntervalMs = ms;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(refresh, pollIntervalMs);
      }

      async function refresh() {
        const res = await fetch("/api/state");
        const data = await res.json();
        stateEl.textContent = data.status || "idle";

        const steps = data.stepResults || [];
        const stepDone = (id) => steps.some((r) => r.stepId === id && r.status === "completed");
        const tailscaleUpDone = stepDone("tailscale_up");
        const gatewayBootstrapDone = stepDone("gateway_bootstrap");

        const tailscaleApprovalUrl = data.detected && data.detected.tailscaleApprovalUrl ? data.detected.tailscaleApprovalUrl : "";
        const funnelUrl = data.detected && data.detected.funnelUrl ? data.detected.funnelUrl : "";
        const funnelAdminUrl = data.detected && data.detected.funnelAdminUrl ? data.detected.funnelAdminUrl : "";

        const showTailscaleCta = tailscaleApprovalUrl && !tailscaleUpDone;
        showUrlCta(tailscaleCtaEl, tailscaleLinkEl, showTailscaleCta ? tailscaleApprovalUrl : "");

        const showFunnelAdmin = funnelAdminUrl && !gatewayBootstrapDone;
        showUrlCta(funnelAdminCtaEl, funnelAdminLinkEl, showFunnelAdmin ? funnelAdminUrl : "");

        const showFunnelPublic = funnelUrl && !gatewayBootstrapDone;
        showUrlCta(funnelCtaEl, funnelLinkEl, showFunnelPublic ? funnelUrl : "");

        if (showTailscaleCta && tailscaleApprovalUrl !== announcedTailscaleUrl) {
          announcedTailscaleUrl = tailscaleApprovalUrl;
          try {
            window.alert("Action required: approve Tailscale in your browser. The approval link is now shown above status.");
          } catch {
            // Some environments can suppress alerts; CTA remains visible.
          }
        }
        if (showFunnelAdmin && funnelAdminUrl !== announcedFunnelAdminUrl) {
          announcedFunnelAdminUrl = funnelAdminUrl;
          try {
            window.alert("Action required: enable Tailscale Funnel in your browser. The link is shown above the status table.");
          } catch {
            // ignore
          }
        }

        const setupHandoff = data.setupHandoff;
        if (data.status === "completed" && setupHandoff && setupHandoff.command) {
          setPollInterval(1200);
          setCheckoutMode(true);
          ctaBoxEl.classList.remove("hidden");
          setupCtaEl.classList.remove("hidden");
          setupSuccessTextEl.textContent = "Pro move. You finished the wizard installation.";
          setupCommandEl.textContent = setupHandoff.command;
          restartCommandEl.textContent = setupHandoff.restartCommand || "openclaw gateway restart";
          readyEl.textContent =
            setupHandoff.title + "\\n" +
            setupHandoff.message + "\\n" +
            "Run in VPS shell: " + setupHandoff.command + "\\n" +
            "Then run: " + (setupHandoff.restartCommand || "openclaw gateway restart");
        } else {
          setCheckoutMode(false);
          setupCtaEl.classList.add("hidden");
          const anyCta =
            showTailscaleCta
            || showFunnelAdmin
            || showFunnelPublic;
          if (anyCta) {
            ctaBoxEl.classList.remove("hidden");
          } else {
            ctaBoxEl.classList.add("hidden");
          }

          if (data.status === "running") {
            setPollInterval(500);
            if (showTailscaleCta) {
              readyEl.textContent =
                "Action required: open the Tailscale approval link and complete sign-in, then return to this page.";
            } else if (showFunnelAdmin) {
              readyEl.textContent =
                "Action required: open the Tailscale Funnel link above and complete any prompts, then return here.";
            } else if (showFunnelPublic) {
              readyEl.textContent =
                "Public gateway URL is shown above — installation continues. Please keep this page open.";
            } else if (tailscaleUpDone && !gatewayBootstrapDone) {
              readyEl.textContent =
                "Tailscale is connected — installation is continuing. Please keep this page open and be patient.";
            } else {
              readyEl.textContent = "Installation running — please wait…";
            }
          } else {
            setPollInterval(1200);
            if (data.status !== "completed") {
              readyEl.textContent = "";
            }
          }
        }

        const errors = data.errors || [];
        manualEl.textContent = errors.length > 0
          ? errors.map((e) => "Step " + (e.stepId || "unknown") + ":\\n" + (e.error || "")).join("\\n\\n")
          : "";
        stepsEl.innerHTML = "";
        steps.forEach((row) => {
          const tr = document.createElement("tr");
          tr.innerHTML = "<td>" + row.stepId + "</td><td>" + row.status + "</td><td>" + (row.error || row.detail || "") + "</td>";
          stepsEl.appendChild(tr);
        });
        logsEl.textContent = (data.logs || []).map((l) => "[" + l.at + "] " + l.stepId + " " + l.level + " " + l.text).join("\\n");
      }

      async function finishWizardServer() {
        finishWizardBtn.disabled = true;
        finishWizardBtn.textContent = "Closing wizard...";
        try {
          const res = await fetch("/api/finish", { method: "POST" });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            finishWizardBtn.disabled = false;
            finishWizardBtn.textContent = "Finish & Return to Shell";
            manualEl.textContent = data.error ? "Unable to close wizard: " + data.error : "Unable to close wizard right now.";
            return;
          }
          finishWizardBtn.textContent = "Finished - shell is ready";
          readyEl.textContent = "Wizard completed. Server is shutting down and your shell prompt should already be back.";
          manualEl.textContent = "";
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          const likelyClosed = /failed to fetch|networkerror|network request failed/i.test(msg);
          if (likelyClosed) {
            // Server can close immediately after acknowledging /api/finish, which may race the browser fetch.
            finishWizardBtn.textContent = "Finished - shell is ready";
            readyEl.textContent = "Wizard finish was requested. Your shell prompt should be back.";
            manualEl.textContent = "";
            return;
          }
          finishWizardBtn.disabled = false;
          finishWizardBtn.textContent = "Finish & Return to Shell";
          manualEl.textContent = "Unable to close wizard: " + msg;
        }
      }

      document.getElementById("start").addEventListener("click", startInstall);
      async function copyWithFeedback(buttonEl, value) {
        if (!value) return;
        try {
          await navigator.clipboard.writeText(value);
          buttonEl.textContent = "Copied";
        } catch {
          buttonEl.textContent = "Copy failed";
        }
        setTimeout(() => { buttonEl.textContent = "Copy command"; }, 1200);
      }

      copySetupBtn.addEventListener("click", async () => {
        await copyWithFeedback(copySetupBtn, setupCommandEl.textContent || "");
      });
      copyRestartBtn.addEventListener("click", async () => {
        await copyWithFeedback(copyRestartBtn, restartCommandEl.textContent || "");
      });
      finishWizardBtn.addEventListener("click", finishWizardServer);
      llmProviderEl.addEventListener("change", () => refreshModelOptions(""));
      llmModelManualEl.addEventListener("change", () => {
        llmModelEl.disabled = !llmModelManualEl.checked;
        updateStartButtonState();
      });
      llmCredentialEl.addEventListener("input", updateStartButtonState);
      telegramTokenEl.addEventListener("input", updateStartButtonState);
      loadLlmCatalog();
      setPollInterval(1200);
      refresh();
    </script>
  </body>
</html>`;
}

async function cmdInstall(args) {
  const wizard = args.includes("--wizard");
  if (!wizard) {
    printError("Only wizard mode is currently supported. Use: traderclaw install --wizard");
    process.exit(1);
  }

  const defaults = parseInstallWizardArgs(args);
  const { createInstallerStepEngine } = await import("./installer-step-engine.mjs");
  const modeConfig = {
    pluginPackage: "solana-traderclaw-v1",
    pluginId: "solana-trader",
    cliName: "traderclaw",
    gatewayConfig: "gateway-v1.json5",
    agents: ["cto", "onchain-analyst", "alpha-signal-analyst", "risk-officer", "strategy-researcher"],
  };

  const runtime = {
    status: "idle",
    logs: [],
    stepResults: [],
    detected: { funnelUrl: null, tailscaleApprovalUrl: null, funnelAdminUrl: null },
    errors: [],
    setupHandoff: null,
  };
  let running = false;
  let shuttingDown = false;

  const server = createServer(async (req, res) => {
    const respondJson = (code, payload) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    const extractTailscaleApprovalUrl = (evt) => {
      const urls = Array.isArray(evt?.urls) ? evt.urls : [];
      for (const url of urls) {
        if (typeof url === "string" && url.startsWith("https://login.tailscale.com/")) return url;
      }
      const text = typeof evt?.text === "string" ? evt.text : "";
      const match = text.match(/https:\/\/login\.tailscale\.com\/[^\s"')]+/);
      return match ? match[0] : "";
    };

    const extractFunnelAdminUrlFromText = (text) => {
      const t = typeof text === "string" ? text : "";
      const m = t.match(/https:\/\/login\.tailscale\.com\/f\/funnel[^\s"'`)]+/);
      return m ? m[0] : "";
    };

    const extractPublicGatewayUrlFromText = (text) => {
      const t = typeof text === "string" ? text : "";
      const matches = t.match(/https?:\/\/[^\s"'`)]+/g) || [];
      for (const u of matches) {
        if (u.includes("login.tailscale.com")) continue;
        if (u.includes("ts.net") || u.includes("trycloudflare.com")) return u;
      }
      return "";
    };

    if (req.method === "GET" && req.url === "/") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(wizardHtml(defaults));
      return;
    }

    if (req.method === "GET" && req.url === "/api/state") {
      respondJson(200, runtime);
      return;
    }

    if (req.method === "GET" && req.url === "/api/llm/options") {
      respondJson(200, loadWizardLlmCatalog());
      return;
    }

    if (req.method === "POST" && req.url === "/api/finish") {
      if (running || runtime.status !== "completed") {
        respondJson(409, { ok: false, error: "wizard_not_completed" });
        return;
      }
      if (shuttingDown) {
        respondJson(202, { ok: true, shuttingDown: true });
        return;
      }
      shuttingDown = true;
      respondJson(202, { ok: true, shuttingDown: true });
      setTimeout(() => {
        const setupCommand = runtime.setupHandoff?.command || "";
        const restartCommand = runtime.setupHandoff?.restartCommand || "openclaw gateway restart";
        if (setupCommand) {
          printSuccess("Run these commands now in this same terminal:");
          print(`  1) ${setupCommand}`);
          print(`  2) ${restartCommand}`);
        } else {
          printWarn("Wizard finished, but no setup handoff command was available.");
          print(`  Next step: traderclaw setup --url ${defaults.orchestratorUrl}`);
          print(`  Then run: ${restartCommand}`);
        }
        printInfo("Wizard finish requested from browser. Closing server and returning shell prompt.");
        server.close(() => process.exit(0));
      }, 650);
      return;
    }

    if (req.method === "POST" && req.url === "/api/start") {
      if (running) {
        respondJson(409, { ok: false, error: "wizard_run_already_in_progress" });
        return;
      }

      const body = await parseJsonBody(req).catch(() => ({}));
      running = true;
      runtime.status = "running";
      runtime.logs = [];
      runtime.stepResults = [];
      runtime.errors = [];
      runtime.detected = { funnelUrl: null, tailscaleApprovalUrl: null, funnelAdminUrl: null };
      runtime.setupHandoff = null;
      respondJson(202, { ok: true });

      const engine = createInstallerStepEngine(
        modeConfig,
        {
          mode: "light",
          lane: defaults.lane,
          llmProvider: body.llmProvider || defaults.llmProvider,
          llmModel: body.llmModel || defaults.llmModel,
          llmCredential: body.llmCredential || defaults.llmCredential,
          apiKey: body.apiKey || defaults.apiKey,
          orchestratorUrl: defaults.orchestratorUrl,
          gatewayBaseUrl: defaults.gatewayBaseUrl,
          gatewayToken: defaults.gatewayToken,
          enableTelegram: true,
          telegramToken: body.telegramToken || defaults.telegramToken,
          autoInstallDeps: true,
        },
        {
          onStepEvent: (evt) => {
            const existing = runtime.stepResults.find((s) => s.stepId === evt.stepId);
            if (!existing) runtime.stepResults.push({ stepId: evt.stepId, status: evt.status, detail: evt.detail || "" });
            else {
              existing.status = evt.status;
              existing.detail = evt.detail || existing.detail;
            }
          },
          onLog: (evt) => {
            runtime.logs.push(evt);
            const stepId = evt.stepId || "";
            const text = typeof evt.text === "string" ? evt.text : "";
            if (!runtime.detected.tailscaleApprovalUrl && stepId === "tailscale_up") {
              const approvalUrl = extractTailscaleApprovalUrl(evt);
              if (approvalUrl) runtime.detected.tailscaleApprovalUrl = approvalUrl;
            }
            if (stepId === "funnel" || stepId === "gateway_bootstrap") {
              const urls = Array.isArray(evt.urls) ? evt.urls : [];
              for (const u of urls) {
                if (typeof u === "string" && u.includes("login.tailscale.com/f/funnel")) {
                  runtime.detected.funnelAdminUrl = u;
                }
              }
              const adminFromText = extractFunnelAdminUrlFromText(text);
              if (adminFromText) runtime.detected.funnelAdminUrl = adminFromText;
              const pub = extractPublicGatewayUrlFromText(text);
              if (pub) runtime.detected.funnelUrl = pub;
            }
          },
        },
      );

      const result = await engine.runAll();
      runtime.status = result.status;
      runtime.stepResults = result.stepResults || runtime.stepResults;
      const mergedDetected = result.detected && typeof result.detected === "object" ? result.detected : {};
      runtime.detected = {
        tailscaleApprovalUrl: mergedDetected.tailscaleApprovalUrl ?? runtime.detected.tailscaleApprovalUrl,
        funnelUrl: mergedDetected.funnelUrl ?? runtime.detected.funnelUrl,
        funnelAdminUrl: runtime.detected.funnelAdminUrl ?? mergedDetected.funnelAdminUrl ?? null,
      };
      runtime.errors = result.errors || [];
      runtime.setupHandoff = result.setupHandoff || null;
      running = false;
      return;
    }

    respondJson(404, { ok: false, error: "not_found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(defaults.port, "127.0.0.1", resolve);
  });

  const url = `http://127.0.0.1:${defaults.port}`;
  printSuccess(`Installer wizard is running at ${url}`);
  if (!openBrowser(url)) {
    printInfo(`Open this URL in your browser: ${url}`);
  }
  printInfo("Press Ctrl+C to stop the wizard server.");
}

function printHelp() {
  print(`
TraderClaw V1 CLI v${VERSION}

Usage: traderclaw <command> [options]

Commands:
  setup              Set up the plugin (signup or API key, session, wallet)
  signup             Create a new account (alias for: setup --signup; run locally, not via the agent)
  precheck           Run environment checks (dry-run or allow-install)
  install            Launch installer flows (--wizard for localhost GUI)
  login              Re-authenticate (uses refresh token when valid; full challenge only if needed)
  logout             Revoke current session and clear tokens
  status             Check connection health and wallet status
  config             View and manage configuration

Setup options:
  --api-key, -k      API key (skip interactive prompt)
  --url, -u          Orchestrator URL (skip interactive prompt)
  --user-id          External user ID for signup
  --wallet-private-key  Optional base58 private key for wallet proof flow (runtime only, never saved)
  --gateway-base-url, -g  Gateway public HTTPS URL for orchestrator callbacks
  --gateway-token, -t     Gateway bearer token (defaults to API key)
  --skip-gateway-registration  Skip gateway URL registration with orchestrator
  --show-api-key     Extra hint after signup (full key is always shown once; confirm with API_KEY_STORED)
  --show-wallet-private-key  Reveal full wallet private key in setup output
  --signup           Force signup flow (create new account)

Login options:
  --wallet-private-key <k>  Base58 key for wallet proof when the server requires it (runtime only)
  --force-reauth       Clear refresh token and run full API challenge (use after logout or to rotate session)

Config subcommands:
  config show        Show current configuration
  config set <k> <v> Update a configuration value
  config reset       Remove plugin configuration

Examples:
  traderclaw signup
  traderclaw setup
  traderclaw login --wallet-private-key <base58_key>
  TRADERCLAW_WALLET_PRIVATE_KEY=<base58_key> traderclaw login
  traderclaw precheck --dry-run --output precheck.log
  traderclaw precheck --allow-install
  traderclaw install --wizard
  traderclaw install --wizard --lane quick-local
  traderclaw setup --signup --user-id my_agent_001
  traderclaw setup --api-key oc_xxx --url https://api.traderclaw.ai
  traderclaw setup --gateway-base-url https://gateway.myhost.ts.net
  traderclaw login
  traderclaw login --force-reauth --wallet-private-key <base58_key>
  traderclaw logout
  traderclaw status
  traderclaw config show
  traderclaw config set apiTimeout 60000
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
    print(`traderclaw v${VERSION}`);
    process.exit(0);
  }

  switch (command) {
    case "setup":
      await cmdSetup(args.slice(1));
      break;
    case "signup":
      await cmdSetup(["--signup", ...args.slice(1)]);
      break;
    case "precheck":
      await cmdPrecheck(args.slice(1));
      break;
    case "install":
      await cmdInstall(args.slice(1));
      break;
    case "login":
      await cmdLogin(args.slice(1));
      break;
    case "logout":
      await cmdLogout();
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
  printError(err.message || String(err));
  process.exit(1);
});
