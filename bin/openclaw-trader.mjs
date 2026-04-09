#!/usr/bin/env node

import { createInterface } from "readline";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { homedir } from "os";
import { randomUUID, createPrivateKey, sign as cryptoSign } from "crypto";
import { execFile, execSync } from "child_process";
import { promisify } from "util";
import { createServer } from "http";
import { resolvePluginPackageRoot } from "./resolve-plugin-root.mjs";

const execFileAsync = promisify(execFile);

/**
 * Ordered list of providers for display in the wizard dropdown.
 * The most commonly used providers appear first.
 */
const WIZARD_PROVIDER_PRIORITY = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "xai",
  "deepseek",
  "groq",
  "mistral",
  "perplexity",
  "together",
  "openai-codex",
  "google-vertex",
  "amazon-bedrock",
  "vercel-ai-gateway",
  "nvidia",
  "moonshot",
  "qwen",
  "cerebras",
  "minimax",
];
let wizardLlmCatalogPromise = null;

const PLUGIN_ROOT = resolvePluginPackageRoot(import.meta.url);
const PLUGIN_PACKAGE_JSON = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf-8"));
const PLUGIN_VERSION =
  typeof PLUGIN_PACKAGE_JSON.version === "string" ? PLUGIN_PACKAGE_JSON.version.trim() : "0.0.0";
/** npm folder name for skills path (always the plugin package). */
const NPM_PACKAGE_NAME =
  typeof PLUGIN_PACKAGE_JSON.name === "string" ? PLUGIN_PACKAGE_JSON.name : "solana-traderclaw";

/** When installed via `npm i -g traderclaw-cli`, bin/ lives under traderclaw-cli — show that version for --version. */
let CLI_VERSION = null;
try {
  const cliPkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const cliPkg = JSON.parse(readFileSync(cliPkgPath, "utf-8"));
  if (cliPkg.name === "traderclaw-cli" && typeof cliPkg.version === "string") {
    CLI_VERSION = cliPkg.version.trim();
  }
} catch {
  /* git checkout: only plugin package.json next to bin */
}

/** User-facing CLI version (wrapper package when present, else plugin). */
const VERSION = CLI_VERSION || PLUGIN_VERSION;
const PLUGIN_ID = "solana-trader";
const LEGACY_PLUGIN_IDS = ["traderclaw-v1", "solana-traderclaw-v1", "solana-traderclaw"];
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
 * non-JSON prefix/suffix text (e.g. progress lines OpenClaw prints to stdout before the JSON).
 * Returns the parsed value or null.
 */
function extractJson(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const cleaned = stripAnsi(raw);

  // Fast path: whole string is valid JSON
  try { return JSON.parse(cleaned); } catch {}

  // Scan for the first `{` (object) or `[` (array) and try to parse from there.
  // We try both start positions and pick the one that comes first in the string.
  const objIdx = cleaned.indexOf("{");
  const arrIdx = cleaned.indexOf("[");

  const candidates = [];
  if (objIdx >= 0) candidates.push(objIdx);
  if (arrIdx >= 0) candidates.push(arrIdx);
  candidates.sort((a, b) => a - b);

  for (const start of candidates) {
    const slice = cleaned.slice(start);
    try { return JSON.parse(slice); } catch {}

    // If the tail has trailing garbage, trim from the right matching bracket.
    const endChar = cleaned[start] === "{" ? "}" : "]";
    const end = cleaned.lastIndexOf(endChar);
    if (end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
    }
  }

  return null;
}

/** Env vars passed to every openclaw CLI invocation to suppress colour output. */
const NO_COLOR_ENV = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };

function getCommandOutput(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], shell: true, maxBuffer: 50 * 1024 * 1024, env: NO_COLOR_ENV }).trim();
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
  normalizePluginConfigShape(config);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePluginConfigShape(config) {
  if (!isRecord(config)) return config;
  if (!isRecord(config.plugins)) config.plugins = {};
  const plugins = config.plugins;
  if (!isRecord(plugins.entries)) plugins.entries = {};
  const entries = plugins.entries;

  let enabledSeen = false;
  let enabledValue = false;
  let mergedConfig = {};
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
      mergedConfig = { ...mergedConfig, ...entry.config };
    }
  }

  if (found) {
    const canonical = isRecord(entries[PLUGIN_ID]) ? entries[PLUGIN_ID] : {};
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
    const seen = new Set();
    plugins.allow = plugins.allow.filter((id) => {
      if (typeof id !== "string") return false;
      const trimmed = id.trim();
      if (!trimmed || LEGACY_PLUGIN_IDS.includes(trimmed) || seen.has(trimmed)) return false;
      seen.add(trimmed);
      return true;
    });
  }

  return config;
}

function getPluginConfig(config) {
  normalizePluginConfigShape(config);
  const plugins = config.plugins;
  if (!plugins) return null;
  const entries = plugins.entries;
  if (!entries) return null;
  const plugin = entries[PLUGIN_ID];
  if (!plugin) return null;
  return plugin.config || null;
}

function setPluginConfig(config, pluginConfig) {
  normalizePluginConfigShape(config);
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

async function doSignup(orchestratorUrl, externalUserId, referralCode = "") {
  printInfo(`  Signing up as: ${externalUserId}`);
  const body = { externalUserId };
  const ref = String(referralCode || "").trim();
  if (ref) body.referralCode = ref;
  const res = await httpRequest(`${orchestratorUrl}/api/auth/signup`, {
    method: "POST",
    body,
  });

  if (!res.ok) {
    const payload = res.data && typeof res.data === "object" ? res.data : {};
    const apiMsg = typeof payload.message === "string" ? payload.message : JSON.stringify(res.data);
    const err = new Error(`Signup failed (HTTP ${res.status}): ${apiMsg}`);
    if (typeof payload.code === "string") err.code = payload.code;
    throw err;
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

async function doRecoverSecret(orchestratorUrl, apiKey, recoverySecret) {
  const res = await httpRequest(`${orchestratorUrl}/api/session/recover-secret`, {
    method: "POST",
    body: { apiKey, recoverySecret, clientLabel: "openclaw-trader-cli" },
  });
  if (!res.ok) {
    throw new Error(`recover-secret failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
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

  if (pluginConfig.recoverySecret) {
    printInfo("  Attempting session recovery via consumable secret...");
    try {
      const tokens = await doRecoverSecret(orchestratorUrl, pluginConfig.apiKey, pluginConfig.recoverySecret);
      pluginConfig.refreshToken = tokens.refreshToken;
      if (tokens.recoverySecret) {
        pluginConfig.recoverySecret = tokens.recoverySecret;
      }
      printSuccess("  Session recovered via consumable secret");
      printInfo(`  Tier: ${tokens.session?.tier || "unknown"}`);
      return tokens;
    } catch (err) {
      printWarn(`  Consumable recovery failed: ${err.message || err}`);
      printWarn("  Falling back to wallet challenge...");
    }
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
  let writeGatewayEnvFlag = false;
  let noEnsureGatewayPersistent = false;
  let signupRecoverySecret = undefined;
  let forwardTelegramRecipientArg = "";
  let referralCodeArg = "";
  let referralInvalidRetries = 0;

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
    if (args[i] === "--write-gateway-env") {
      writeGatewayEnvFlag = true;
    }
    if (args[i] === "--no-ensure-gateway-persistent") {
      noEnsureGatewayPersistent = true;
    }
    if (
      (args[i] === "--telegram-recipient" ||
        args[i] === "--forward-telegram-chat-id" ||
        args[i] === "--telegram-chat-id") &&
      args[i + 1]
    ) {
      forwardTelegramRecipientArg = args[++i];
    }
    if ((args[i] === "--referral-code" || args[i] === "-r") && args[i + 1]) {
      referralCodeArg = args[++i];
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

  if (doSignupFlow && !referralCodeArg) {
    printInfo(
      "\n  Optional: enter a referral code for bonus access time (24h extra when valid). Press Enter to skip.\n",
    );
    printInfo(
      "  Benefits: extra trial time now; referring others later earns +24h per user who completes at least one trade with the agent.\n",
    );
    referralCodeArg = await prompt("Referral code (optional)", "");
  }

  if (doSignupFlow) {
    print("\n  Signing up for a new account...\n");
    if (!externalUserId) {
      externalUserId = await prompt("External User ID (or press enter for auto-generated)", `agent_${randomUUID().slice(0, 8)}`);
    }

    for (let signupAttempt = 0; ; signupAttempt++) {
      try {
        const signupResult = await doSignup(orchestratorUrl, externalUserId, referralCodeArg);
        apiKey = signupResult.apiKey;
        if (signupResult.recoverySecret) {
          signupRecoverySecret = signupResult.recoverySecret;
        }
        signedUpThisSession = true;
        printSuccess(`  Signup successful!`);
        printInfo(`  Tier: ${signupResult.tier}`);
        printInfo(`  Scopes: ${signupResult.scopes.join(", ")}`);
        break;
      } catch (err) {
        const msg = err.message || String(err);
        const apiCode = err.code;
        const referralRejected =
          apiCode === "REFERRAL_CODE_INVALID" ||
          msg.includes("REFERRAL_CODE_INVALID") ||
          msg.includes("Unknown referral code");
        if (referralRejected) {
          referralInvalidRetries += 1;
          if (referralInvalidRetries > 30) {
            printError("Too many invalid referral attempts. Aborting.");
            process.exit(1);
          }
          printWarn("  That referral code was not accepted (unknown or invalid).");
          printInfo("  Leave it blank or enter a different code, then try again.");
          referralCodeArg = await prompt("Referral code (optional, leave empty to skip)", "");
          continue;
        }
        if (msg.includes("SIGNUP_ALREADY_COMPLETED") || msg.includes("409")) {
          printWarn(`  User "${externalUserId}" is already registered.`);
          if (signupAttempt >= 2) {
            printError("  Too many attempts. If you already have an account, re-run setup and choose 'y' when asked for an API key.");
            process.exit(1);
          }
          externalUserId = await prompt("Try a different User ID", `agent_${randomUUID().slice(0, 8)}`);
        } else {
          printError(`Signup failed: ${msg}`);
          process.exit(1);
        }
      }
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
    for (let attempt = 0; ; attempt++) {
      const ack = await prompt("Type API_KEY_STORED to confirm you saved this key", "");
      if (ack === "API_KEY_STORED") break;
      if (attempt >= 2) {
        printError("Confirmation not provided after 3 attempts. Aborting setup so you do not lose access to your API key.");
        process.exit(1);
      }
      printWarn("  Please type exactly: API_KEY_STORED");
    }
    printSuccess("  API key backup confirmation received.");
  }

  if (!apiKey) {
    printError("API key is required. Use --signup to create an account or provide a key.");
    process.exit(1);
  }

  print("\nEstablishing session...\n");

  const existingForRecovery = readConfig();
  const prevPlugin = getPluginConfig(existingForRecovery);
  const prevSafe = prevPlugin && typeof prevPlugin === "object" ? { ...prevPlugin } : {};
  const pluginConfig = {
    ...prevSafe,
    orchestratorUrl,
    walletId: null,
    apiKey,
    apiTimeout: 120000,
    refreshToken: undefined,
    walletPublicKey: undefined,
    agentId: "main",
    recoverySecret: signupRecoverySecret ?? prevPlugin?.recoverySecret,
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
      for (let attempt = 0; ; attempt++) {
        const ack = await prompt("Type BACKED_UP to continue", "");
        if (ack === "BACKED_UP") break;
        if (attempt >= 2) {
          printError("Backup confirmation not provided after 3 attempts. Aborting setup to prevent key loss.");
          process.exit(1);
        }
        printWarn("  Please type exactly: BACKED_UP");
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

  let forwardTelegramRecipient = forwardTelegramRecipientArg.trim();
  print("\nTelegram delivery (optional)...\n");
  printInfo("  Enter your Telegram @username or numeric chat id so agent replies can be routed to you.");
  printInfo(
    "  Usernames resolve when plugin config telegramBotToken is set, or TELEGRAM_BOT_TOKEN / OPENCLAW_TELEGRAM_BOT_TOKEN is set for this prompt.",
  );
  printInfo("  Private chats: message your bot once first.\n");
  if (!forwardTelegramRecipient) {
    forwardTelegramRecipient = await prompt("Telegram @username or chat id (optional, Enter to skip)", "");
  }
  forwardTelegramRecipient = forwardTelegramRecipient.trim();

  if (forwardTelegramRecipient) {
    const botToken = String(
      prevPlugin?.telegramBotToken ||
        process.env.TELEGRAM_BOT_TOKEN ||
        process.env.OPENCLAW_TELEGRAM_BOT_TOKEN ||
        "",
    ).trim();
    try {
      const { looksLikeTelegramChatId, resolveTelegramRecipientToChatId } = await import(
        pathToFileURL(join(PLUGIN_ROOT, "dist", "src", "telegram-resolve.js")).href,
      );
      if (looksLikeTelegramChatId(forwardTelegramRecipient)) {
        pluginConfig.forwardTelegramRecipient = forwardTelegramRecipient;
        printSuccess(`  Saved Telegram chat id`);
      } else if (botToken) {
        const id = await resolveTelegramRecipientToChatId({ botToken, raw: forwardTelegramRecipient });
        pluginConfig.forwardTelegramRecipient = id;
        printSuccess(`  Resolved @${forwardTelegramRecipient.replace(/^@/, "")} → chat id ${id}`);
      } else {
        pluginConfig.forwardTelegramRecipient = forwardTelegramRecipient;
        printInfo(
          "  Saved as-is; set plugin telegramBotToken or gateway TELEGRAM_BOT_TOKEN to resolve @username on first run.",
        );
      }
    } catch (err) {
      printWarn(`  Telegram resolve failed: ${err instanceof Error ? err.message : String(err)}`);
      printInfo("  Saving your username anyway — fix token or use numeric chat id.");
      pluginConfig.forwardTelegramRecipient = forwardTelegramRecipient;
    }
  }

  print("\nWriting configuration...\n");

  const existingConfig = readConfig();
  removeLegacyWalletPrivateKey(pluginConfig);
  setPluginConfig(existingConfig, pluginConfig);

  if (!existingConfig.agents || typeof existingConfig.agents !== "object") {
    existingConfig.agents = {};
  }
  if (!existingConfig.agents.defaults) existingConfig.agents.defaults = {};
  if (!existingConfig.agents.defaults.heartbeat || typeof existingConfig.agents.defaults.heartbeat !== "object") {
    existingConfig.agents.defaults.heartbeat = {};
  }
  if (!Array.isArray(existingConfig.agents.list)) {
    existingConfig.agents.list = [];
  }
  const heartbeatPrompt =
    "Read HEARTBEAT.md (workspace context). Follow it strictly — execute the full trading cycle and report results to the user. Do NOT reply HEARTBEAT_OK. Always produce a visible summary of what you checked and did.";
  const defaultHeartbeatEvery = "30m";
  const hasMainAgent = existingConfig.agents.list.some((a) => a && a.id === "main");
  if (!hasMainAgent) {
    existingConfig.agents.list.push({ id: "main", default: true, heartbeat: { every: defaultHeartbeatEvery, target: "last", prompt: heartbeatPrompt } });
  } else {
    const mainAgent = existingConfig.agents.list.find((a) => a.id === "main");
    if (!mainAgent.heartbeat) mainAgent.heartbeat = { every: defaultHeartbeatEvery, target: "last", prompt: heartbeatPrompt };
    else mainAgent.heartbeat.prompt = heartbeatPrompt;
  }
  if (!existingConfig.cron || typeof existingConfig.cron !== "object") {
    existingConfig.cron = { enabled: true, maxConcurrentRuns: 2, sessionRetention: "24h" };
  }

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

  if (writeGatewayEnvFlag && lastSeenWalletPrivateKey) {
    if (process.platform !== "linux" || process.env.WSL_DISTRO_NAME) {
      printWarn(
        "  --write-gateway-env is for Linux (non-WSL) systemd user gateways; skipped on this platform.",
      );
    } else {
      try {
        const { writeTraderclawGatewayWalletEnv } = await import("./gateway-persistence-linux.mjs");
        writeTraderclawGatewayWalletEnv(lastSeenWalletPrivateKey);
        printSuccess(
          `  Wrote ${WALLET_PRIVATE_KEY_ENV} for the systemd user gateway (see ~/.config/systemd/user/openclaw-gateway.service.d/).`,
        );
        printInfo("  Run: openclaw gateway restart");
      } catch (err) {
        printWarn(`  Could not write gateway wallet env file: ${err.message || err}`);
      }
    }
  } else if (writeGatewayEnvFlag && !lastSeenWalletPrivateKey) {
    printWarn("  --write-gateway-env skipped: no wallet private key was available this session.");
  }

  if (!noEnsureGatewayPersistent) {
    try {
      const { ensureLinuxGatewayPersistence, isLinuxGatewayPersistenceEligible } = await import(
        "./gateway-persistence-linux.mjs",
      );
      if (isLinuxGatewayPersistenceEligible()) {
        print("\nGateway persistence (Linux)...\n");
        await ensureLinuxGatewayPersistence({
          emitLog: (level, text) => {
            if (level === "warn") printWarn(`  ${text}`);
            else printInfo(`  ${text}`);
          },
        });
      }
    } catch (err) {
      printWarn(`  Gateway persistence (optional): ${err.message || err}`);
    }
  }

  try {
    const { deployWorkspaceHeartbeat } = await import("./installer-step-engine.mjs");
    print("\nWorkspace HEARTBEAT.md...\n");
    const hb = deployWorkspaceHeartbeat({ pluginPackage: NPM_PACKAGE_NAME });
    if (hb.deployed) {
      printSuccess(`  Installed HEARTBEAT.md → ${hb.dest}`);
    } else if (hb.skipped) {
      printInfo(`  HEARTBEAT.md already exists at ${hb.dest} — left unchanged.`);
    } else {
      printWarn(`  Could not install HEARTBEAT.md automatically (${hb.reason || "unknown"})`);
      if (hb.src) printInfo(`  Expected source: ${hb.src}`);
    }
  } catch (err) {
    printWarn(`  HEARTBEAT.md workspace install: ${err.message || err}`);
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
  Telegram fwd:  ${pluginConfig.forwardTelegramRecipient || "(not set)"}
  API Key:       ${showApiKey ? apiKey : maskKey(apiKey)}
  Session:       Active (tier: ${sessionTokens.session?.tier || "?"})
  Config:        ${CONFIG_FILE}
`);
  print(`  Runtime wallet proof key source: --wallet-private-key or env ${WALLET_PRIVATE_KEY_ENV} (never openclaw.json)`);
  printWarn(
    `  For the OpenClaw gateway (Telegram/agent tools), the same env must be set on the gateway service — not only in this shell. See: ${TRADERCLAW_SESSION_TROUBLESHOOTING_URL}`,
  );
  print("Session commands:");
  print("  traderclaw status     Check connection health (auto-refreshes session)");
  print("  traderclaw login      Re-authenticate (challenge flow)");
  print("  traderclaw logout     Revoke current session");
  print("  traderclaw config     View current configuration");
  print("");
}

async function cmdGateway(args) {
  const sub = args[0];
  if (sub === "ensure-persistent") {
    const { ensureLinuxGatewayPersistence } = await import("./gateway-persistence-linux.mjs");
    print("\nTraderClaw — gateway persistence (Linux)\n");
    const result = await ensureLinuxGatewayPersistence({
      emitLog: (level, text) => {
        if (level === "warn") printWarn(`  ${text}`);
        else printInfo(`  ${text}`);
      },
    });
    if (result.skipped) {
      printInfo(`  Skipped: ${result.reason || "not applicable"}`);
      return;
    }
    if (result.errors?.length) {
      printWarn(`  Completed with notes: ${result.errors.join("; ")}`);
    } else {
      printSuccess("  Done. Gateway should survive SSH disconnect; use: openclaw gateway restart");
    }
    return;
  }
  printError("Unknown gateway subcommand. Try: traderclaw gateway ensure-persistent");
  process.exit(1);
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
    llmAuthMode: "api_key",
    llmOAuthPaste: "",
    llmOAuthSkipLogin: false,
    orchestratorUrl: "https://api.traderclaw.ai",
    gatewayBaseUrl: "",
    gatewayToken: "",
    enableTelegram: false,
    telegramToken: "",
    xConsumerKey: "",
    xConsumerSecret: "",
    xAccessTokenMain: "",
    xAccessTokenMainSecret: "",
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
    if (key === "--llm-auth" && next) {
      const v = args[++i];
      out.llmAuthMode = v === "oauth" ? "oauth" : "api_key";
    }
    if (key === "--llm-oauth-paste" && next) out.llmOAuthPaste = args[++i];
    if (key === "--llm-oauth-skip-login") out.llmOAuthSkipLogin = true;
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
      execSync("npm install -g --registry https://registry.npmjs.org/ openclaw@latest", { stdio: "ignore" });
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
    try {
      const { getLinuxGatewayPersistenceSnapshot } = await import("./gateway-persistence-linux.mjs");
      const snap = getLinuxGatewayPersistenceSnapshot();
      if (snap.eligible && snap.linger !== true) {
        log.warn(
          "systemd user linger not enabled — gateway may stop after SSH disconnect; run: traderclaw gateway ensure-persistent",
        );
      } else if (snap.eligible && snap.linger === true) {
        log.pass("systemd user linger enabled (SSH-safe gateway)");
      }
    } catch {
      log.warn("could not check systemd user linger (optional)");
    }
  } else {
    log.warn("skipping gateway status check (openclaw missing)");
  }

  log.info("Manual staging run commands:");
  log.info("  1) traderclaw install --wizard");
  log.info("  2) In wizard, set LLM (API key or Codex OAuth) and Telegram token");
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

/**
 * Returns the wizard LLM catalog immediately from the curated static list.
 *
 * WHY we no longer call `openclaw models list --all`:
 * The OpenClaw CLI enumerates models by making live network calls to each
 * provider's API (provider plugins inject catalogs via network).  The wizard
 * runs BEFORE any API credentials have been configured, so every probe will
 * always ETIMEDOUT — there is nothing to authenticate with yet.  Calling the
 * CLI here is architecturally wrong for this stage of setup.
 *
 * The curated list below is the correct source for the wizard: it covers all
 * supported providers with their recommended models and loads in < 1 ms.
 * After installation the user can run `openclaw models list` to see the full
 * live catalog for their configured providers.
 */
async function loadWizardLlmCatalogAsync() {
  return {
    source: "curated",
    providers: [
      {
        id: "anthropic",
        models: [
          { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6 (recommended)" },
          { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
          { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5" },
        ],
      },
      {
        id: "openai",
        models: [
          { id: "openai/gpt-5.4", name: "GPT-5.4 (recommended)" },
          { id: "openai/gpt-5.4-mini", name: "GPT-5.4 mini" },
          { id: "openai/gpt-5.4-nano", name: "GPT-5.4 nano" },
        ],
      },
      {
        id: "openai-codex",
        models: [
          { id: "openai-codex/gpt-5.4", name: "GPT-5.4 Codex (recommended, ChatGPT OAuth)" },
          {
            id: "openai-codex/gpt-5.3-codex-spark",
            name: "GPT-5.3 Codex Spark (subscription entitlement; experimental)",
          },
        ],
      },
      {
        id: "google",
        models: [
          { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash (recommended)" },
          { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
        ],
      },
      {
        id: "xai",
        models: [
          { id: "xai/grok-4", name: "Grok 4 (recommended)" },
          { id: "xai/grok-3", name: "Grok 3" },
        ],
      },
      {
        id: "deepseek",
        models: [
          { id: "deepseek/deepseek-chat", name: "DeepSeek Chat V3 (recommended)" },
          { id: "deepseek/deepseek-reasoner", name: "DeepSeek Reasoner R1" },
        ],
      },
      {
        id: "openrouter",
        models: [
          { id: "openrouter/anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6 via OpenRouter (recommended)" },
          { id: "openrouter/openai/gpt-5.4", name: "GPT-5.4 via OpenRouter" },
          { id: "openrouter/google/gemini-2.5-flash", name: "Gemini 2.5 Flash via OpenRouter" },
        ],
      },
      {
        id: "groq",
        models: [
          { id: "groq/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout (recommended)" },
          { id: "groq/llama-4-maverick-17b-128e-instruct", name: "Llama 4 Maverick" },
        ],
      },
      {
        id: "mistral",
        models: [
          { id: "mistral/mistral-large-latest", name: "Mistral Large (recommended)" },
          { id: "mistral/mistral-medium-latest", name: "Mistral Medium" },
        ],
      },
      {
        id: "perplexity",
        models: [{ id: "perplexity/sonar-pro", name: "Sonar Pro" }],
      },
      {
        id: "together",
        models: [{ id: "together/moonshotai/Kimi-K2.5", name: "Kimi K2.5" }],
      },
      {
        id: "nvidia",
        models: [{ id: "nvidia/llama-3.3-70b-instruct", name: "Llama 3.3 70B Instruct" }],
      },
      {
        id: "qwen",
        models: [{ id: "qwen/qwen3-235b-a22b", name: "Qwen3 235B A22B" }],
      },
      {
        id: "moonshot",
        models: [{ id: "moonshot/kimi-k2", name: "Kimi K2" }],
      },
    ],
    generatedAt: new Date().toISOString(),
  };
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
      input, select, textarea { width:100%; padding:10px; border-radius:8px; border:1px solid #334a87; background:#0d1530; color:#e8eef9; font-family: inherit; font-size: 14px; box-sizing: border-box; }
      textarea { min-height: 88px; resize: vertical; }
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
      .info-dot { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:50%; background:#22315a; color:#9cb0de; font-size:11px; font-weight:700; cursor:help; flex-shrink:0; }
      @keyframes spin { to { transform:rotate(360deg); } }
      .oauth-flow { background:#0d1530; border:1px solid #334a87; border-radius:10px; padding:14px; margin-top:10px; }
      .oauth-flow ol { margin:8px 0 0 18px; padding:0; color:#c5d7f5; font-size:13px; line-height:1.5; }
      .oauth-flow li { margin-bottom:8px; }
      .oauth-row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px; }
      .oauth-row input[readonly] { flex:1 1 280px; font-size:12px; }
      .oauth-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
      .oauth-actions button.secondary { background:#334a87; }
      .oauth-guide { background:#0a1f2e; border:1px solid #2a7a6a; border-radius:10px; padding:14px; margin-top:8px; }
      .oauth-guide ol { margin:10px 0 0 18px; padding:0; color:#d9e8ff; font-size:13px; line-height:1.55; }
      .oauth-guide li { margin-bottom:7px; }
      .oauth-step.pending { color:#9cb0de; }
      .oauth-step.active { color:#9ee6ff; font-weight:700; }
      .oauth-step.done { color:#78f0a9; }
      .oauth-step.error { color:#ff9b9b; font-weight:700; }
      .ok-banner { color:#78f0a9; font-size:13px; margin-top:8px; }
      .err-banner { color:#ff6b6b; font-size:13px; margin-top:8px; }
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
        <p class="muted">Use an API key for OpenAI Platform and other providers, or ChatGPT/Codex OAuth for subscription access (no separate API billing). OAuth tokens are stored by OpenClaw — not as <code>OPENAI_API_KEY</code>.</p>
        <div style="margin-bottom:12px;">
          <label style="margin-bottom:8px;">LLM authentication</label>
          <label style="display:flex; align-items:flex-start; gap:8px; font-size:14px; color:#e8eef9; margin-bottom:6px; cursor:pointer;">
            <input id="llmAuthModeApiKey" name="llmAuthMode" type="radio" value="api_key" style="width:auto; margin-top:3px;" checked />
            <span><strong>API key</strong> — OpenAI Platform (<code>openai</code>), Anthropic, OpenRouter, etc.</span>
          </label>
          <label style="display:flex; align-items:flex-start; gap:8px; font-size:14px; color:#e8eef9; cursor:pointer;">
            <input id="llmAuthModeOauth" name="llmAuthMode" type="radio" value="oauth" style="width:auto; margin-top:3px;" />
            <span><strong>ChatGPT / Codex (OAuth)</strong> — provider <code>openai-codex</code> (Plus/Pro subscription via OpenClaw login)</span>
          </label>
        </div>
        <div class="grid" id="llmProviderModelGrid">
          <div id="llmProviderWrap">
            <label>LLM provider (required)</label>
            <select id="llmProvider"></select>
          </div>
          <div>
            <label>LLM model (advanced, optional)</label>
            <select id="llmModel"></select>
          </div>
        </div>
        <p class="muted hidden" id="llmOauthProviderNote">Provider is fixed to <code>openai-codex</code>. Pick a Codex model below (or enable manual selection).</p>
        <div style="margin-top:8px;">
          <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:#9cb0de;">
            <input id="llmModelManual" type="checkbox" style="width:auto; padding:0; margin:0;" />
            Choose model manually (advanced)
          </label>
        </div>
        <div style="margin-top:12px;" id="llmApiKeyBlock">
          <label>LLM API key or token (required)</label>
          <input id="llmCredential" type="password" placeholder="Paste the credential for the selected provider/model" />
          <p class="muted">Written to OpenClaw <code>config.env</code> for the selected provider. If you do not choose a model manually, the installer picks a safe default.</p>
        </div>
        <div style="margin-top:12px;" id="llmOauthBlock" class="hidden">
          <p class="muted" style="margin-bottom:12px;">
            OAuth here is fully guided. After you choose OAuth, we start OpenClaw login automatically. Use the sign-in button below, then complete ChatGPT in this browser. You should not need to copy any code.
          </p>
          <div class="oauth-guide">
            <p class="muted" style="margin-top:0;">
              <strong>Important:</strong> Complete the ChatGPT sign-in in this browser, then return to this tab. The wizard detects the result automatically.
            </p>
            <p class="muted" style="margin-top:4px;font-size:13px;color:#7a8ba8;">
              <strong>Remote VPS?</strong> Forward port <code>1455</code> alongside the wizard port:
              <code style="display:block;margin-top:4px;padding:4px 8px;background:#111827;border-radius:4px;font-size:12px;">ssh -L 17890:127.0.0.1:17890 -L 1455:127.0.0.1:1455 user@your-vps</code>
            </p>
            <ol>
              <li class="oauth-step pending" id="oauthStepPrepare">Preparing ChatGPT sign-in...</li>
              <li class="oauth-step pending" id="oauthStepOpen">Open ChatGPT sign-in in this browser.</li>
              <li class="oauth-step pending" id="oauthStepComplete">Finish ChatGPT approval, then return here.</li>
              <li class="oauth-step pending" id="oauthStepVerify">We detect completion automatically.</li>
            </ol>
            <div class="oauth-actions">
              <a id="oauthOpenUrlBtn" class="secondary" href="#" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#2d7dff;color:#fff;text-decoration:none;font-weight:600;opacity:.55;pointer-events:none;">Open ChatGPT sign-in</a>
              <button type="button" id="oauthRetryBtn" class="secondary hidden">Try sign-in again</button>
            </div>
            <p id="oauthFlowStatus" class="muted" style="margin-top:8px;" aria-live="polite">Choose OAuth and wait a moment. We will prepare your sign-in automatically.</p>
            <div id="oauthFallbackPaste" class="hidden" style="margin-top:12px;padding:12px;background:#111827;border:1px solid #334a87;border-radius:8px;">
              <p class="muted" style="margin:0 0 8px;font-size:13px;color:#ffcc70;">
                <strong>Redirect didn't reach us?</strong> Copy the full URL from the error page in your browser (it starts with <code>http://localhost:1455/auth/callback?code=…</code>) and paste it below.
              </p>
              <div style="display:flex;gap:8px;">
                <input id="oauthFallbackUrlInput" type="text" placeholder="Paste the full localhost:1455/auth/callback?code=… URL here" style="flex:1;font-size:12px;padding:8px 10px;border-radius:6px;border:1px solid #334a87;background:#0a1224;color:#e0e8ff;">
                <button type="button" id="oauthFallbackSubmitBtn" class="secondary" style="padding:8px 14px;white-space:nowrap;">Submit URL</button>
              </div>
              <p id="oauthFallbackError" class="muted hidden" style="margin:6px 0 0;font-size:12px;color:#ff6b6b;"></p>
            </div>
          </div>
        </div>
        <p class="muted" id="llmLoadState" aria-live="polite">Loading LLM provider catalog...</p>
        <div id="llmLoadingHint" class="loading-hint" role="status" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <span id="llmLoadingHintText">Fetching provider list...</span>
        </div>
      </div>
      <div class="card" id="xCard">
        <h3>Optional: X (Twitter) OAuth 1.0a</h3>
        <p class="muted">Skip this section to use trading and Telegram without X. When set, app keys plus user access token enable the <code>main</code> agent profile (journal &amp; engagement tools).</p>
        <div class="grid">
          <div>
            <label>X consumer key (optional)</label>
            <input id="xConsumerKey" type="password" autocomplete="off" placeholder="From your X Developer App" />
          </div>
          <div>
            <label>X consumer secret (optional)</label>
            <input id="xConsumerSecret" type="password" autocomplete="off" />
          </div>
        </div>
        <div class="grid" style="margin-top:12px;">
          <div>
            <label>X access token — main profile (optional)</label>
            <input id="xAccessTokenMain" type="password" autocomplete="off" placeholder="User access token for the posting account" />
          </div>
          <div>
            <label>X access token secret — main profile (optional)</label>
            <input id="xAccessTokenMainSecret" type="password" autocomplete="off" />
          </div>
        </div>
        <p class="muted">If you use X: create an app at <a href="https://developer.x.com" target="_blank" rel="noopener noreferrer">developer.x.com</a> with OAuth 1.0a Read and Write, and fill all four fields above (or leave all blank). Values are written to <code>openclaw.json</code> at <code>plugins.entries.solana-trader.config.x</code> (consumer key/secret plus <code>profiles.main</code> and <code>profiles.solana-trader</code>, same tokens unless you set <code>X_ACCESS_TOKEN_SOLANA_TRADER</code> / <code>_SECRET</code>).</p>
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
        <div style="margin-top:12px;">
          <label style="display:flex;align-items:center;gap:8px;">Referral code (optional)
            <span class="info-dot" title="Included access: 24 hours for every new account. Add a valid referral code for an extra 24 hours. Refer others: when they complete at least one trade with the agent, you earn +24 hours per active referral. When your access window ends, you will need to stake or keep referring to continue.">i</span>
          </label>
          <input id="referralCode" type="text" maxlength="16" autocomplete="off" placeholder="e.g. ABCD1234" />
          <p class="muted">Included access: 24 hours for every new account. Add a valid referral code for an extra 24 hours. Refer others: when they complete at least one trade with the agent, you earn +24 hours per active referral. When your access window ends, you will need to stake or keep referring to continue.</p>
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
      const llmAuthModeApiKey = document.getElementById("llmAuthModeApiKey");
      const llmAuthModeOauth = document.getElementById("llmAuthModeOauth");
      const llmProviderWrap = document.getElementById("llmProviderWrap");
      const llmOauthProviderNote = document.getElementById("llmOauthProviderNote");
      const llmApiKeyBlock = document.getElementById("llmApiKeyBlock");
      const llmOauthBlock = document.getElementById("llmOauthBlock");
      const telegramTokenEl = document.getElementById("telegramToken");
      const llmLoadStateEl = document.getElementById("llmLoadState");
      const llmLoadingHintEl = document.getElementById("llmLoadingHint");
      const llmLoadingHintTextEl = document.getElementById("llmLoadingHintText");
      const startBtn = document.getElementById("start");
      const llmCardEl = document.getElementById("llmCard");
      const xCardEl = document.getElementById("xCard");
      const xConsumerKeyEl = document.getElementById("xConsumerKey");
      const xConsumerSecretEl = document.getElementById("xConsumerSecret");
      const xAccessTokenMainEl = document.getElementById("xAccessTokenMain");
      const xAccessTokenMainSecretEl = document.getElementById("xAccessTokenMainSecret");
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
      let lastReferralFailFingerprint = "";
      let pollTimer = null;
      let pollIntervalMs = 1200;
      let installLocked = false;
      let savedApiKeyProvider = "";
      let oauthSessionId = null;
      let oauthWizardLoginDone = false;
      let oauthStartInFlight = false;
      let oauthPollTimer = null;
      let oauthOpenedInBrowser = false;
      let oauthFlowStartedAtMs = 0;

      const oauthOpenUrlBtn = document.getElementById("oauthOpenUrlBtn");
      const oauthRetryBtn = document.getElementById("oauthRetryBtn");
      const oauthFlowStatus = document.getElementById("oauthFlowStatus");
      const oauthStepPrepare = document.getElementById("oauthStepPrepare");
      const oauthStepOpen = document.getElementById("oauthStepOpen");
      const oauthStepComplete = document.getElementById("oauthStepComplete");
      const oauthStepVerify = document.getElementById("oauthStepVerify");
      const oauthFallbackPaste = document.getElementById("oauthFallbackPaste");
      const oauthFallbackUrlInput = document.getElementById("oauthFallbackUrlInput");
      const oauthFallbackSubmitBtn = document.getElementById("oauthFallbackSubmitBtn");
      const oauthFallbackError = document.getElementById("oauthFallbackError");
      let oauthFallbackTimer = null;

      function setOauthStep(stepEl, mode) {
        if (!stepEl) return;
        stepEl.classList.remove("pending", "active", "done", "error");
        stepEl.classList.add(mode || "pending");
      }

      function setOauthStatus(text, isError = false, isSuccess = false) {
        if (!oauthFlowStatus) return;
        oauthFlowStatus.className = isError ? "err-banner" : isSuccess ? "ok-banner" : "muted";
        oauthFlowStatus.textContent = text;
      }

      function setOauthOpenButton(url) {
        if (!oauthOpenUrlBtn) return;
        if (!url) {
          oauthOpenUrlBtn.href = "#";
          oauthOpenUrlBtn.style.opacity = ".55";
          oauthOpenUrlBtn.style.pointerEvents = "none";
          oauthOpenUrlBtn.setAttribute("aria-disabled", "true");
          return;
        }
        oauthOpenUrlBtn.href = url;
        oauthOpenUrlBtn.style.opacity = "1";
        oauthOpenUrlBtn.style.pointerEvents = "auto";
        oauthOpenUrlBtn.removeAttribute("aria-disabled");
      }

      function stopOauthPolling() {
        if (oauthPollTimer) {
          clearInterval(oauthPollTimer);
          oauthPollTimer = null;
        }
      }

      async function cancelOauthSession() {
        stopOauthPolling();
        oauthStartInFlight = false;
        if (!oauthSessionId) {
          try {
            await fetch("/api/llm/oauth/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          } catch {
            /* ignore */
          }
          return;
        }
        try {
          await fetch("/api/llm/oauth/cancel", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: oauthSessionId }),
          });
        } catch {
          /* ignore */
        }
        oauthSessionId = null;
      }

      function hideFallbackPaste() {
        if (oauthFallbackPaste) oauthFallbackPaste.classList.add("hidden");
        if (oauthFallbackUrlInput) oauthFallbackUrlInput.value = "";
        if (oauthFallbackError) { oauthFallbackError.textContent = ""; oauthFallbackError.classList.add("hidden"); }
        if (oauthFallbackTimer) { clearTimeout(oauthFallbackTimer); oauthFallbackTimer = null; }
      }

      function showFallbackPasteAfterDelay(ms) {
        hideFallbackPaste();
        oauthFallbackTimer = setTimeout(() => {
          if (oauthFallbackPaste && oauthSessionId && oauthOpenedInBrowser && !oauthWizardLoginDone) {
            oauthFallbackPaste.classList.remove("hidden");
          }
        }, ms);
      }

      function resetOauthWizardState() {
        stopOauthPolling();
        hideFallbackPaste();
        oauthSessionId = null;
        oauthWizardLoginDone = false;
        oauthStartInFlight = false;
        oauthOpenedInBrowser = false;
        oauthFlowStartedAtMs = 0;
        if (oauthRetryBtn) oauthRetryBtn.classList.add("hidden");
        setOauthOpenButton("");
        setOauthStep(oauthStepPrepare, "pending");
        setOauthStep(oauthStepOpen, "pending");
        setOauthStep(oauthStepComplete, "pending");
        setOauthStep(oauthStepVerify, "pending");
        setOauthStatus("Choose OAuth and wait a moment. We will prepare your sign-in automatically.");
      }

      (function initLlmAuthDefaults() {
        const mode = ${JSON.stringify(defaults.llmAuthMode || "api_key")};
        if (mode === "oauth") {
          llmAuthModeOauth.checked = true;
          llmAuthModeApiKey.checked = false;
        }
        applyLlmAuthModeUi();
      })();

      function isOauthMode() {
        return llmAuthModeOauth && llmAuthModeOauth.checked;
      }

      function effectiveLlmProvider() {
        return isOauthMode() ? "openai-codex" : llmProviderEl.value.trim();
      }

      function applyLlmAuthModeUi() {
        if (!llmProviderWrap || !llmApiKeyBlock || !llmOauthBlock) return;
        if (isOauthMode()) {
          savedApiKeyProvider = llmProviderEl.value || savedApiKeyProvider;
          llmProviderEl.value = "openai-codex";
          llmProviderWrap.classList.add("hidden");
          llmOauthProviderNote.classList.remove("hidden");
          llmApiKeyBlock.classList.add("hidden");
          llmOauthBlock.classList.remove("hidden");
          if (!oauthWizardLoginDone && !oauthStartInFlight && !oauthSessionId) {
            void startOauthGuidedFlow();
          }
        } else {
          void cancelOauthSession();
          resetOauthWizardState();
          llmProviderWrap.classList.remove("hidden");
          llmOauthProviderNote.classList.add("hidden");
          llmApiKeyBlock.classList.remove("hidden");
          llmOauthBlock.classList.add("hidden");
          if (savedApiKeyProvider) {
            llmProviderEl.value = savedApiKeyProvider;
          }
        }
      }

      function onLlmAuthModeChange() {
        applyLlmAuthModeUi();
        refreshModelOptions("");
      }

      function hasRequiredInputs() {
        if (!llmCatalogReady || !Boolean(telegramTokenEl.value.trim())) return false;
        if (isOauthMode()) {
          return oauthWizardLoginDone === true;
        }
        return Boolean(llmProviderEl.value.trim()) && Boolean(llmCredentialEl.value.trim());
      }

      async function pollOauthStatusOnce() {
        if (!oauthSessionId || !isOauthMode()) return;
        try {
          const sessionId = oauthSessionId;
          const res = await fetch("/api/llm/oauth/status?sessionId=" + encodeURIComponent(sessionId));
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            stopOauthPolling();
            oauthStartInFlight = false;
            if (data && data.error === "invalid_or_expired_session") {
              setOauthStep(oauthStepPrepare, "done");
              setOauthStep(oauthStepOpen, "error");
              setOauthStep(oauthStepComplete, "error");
              setOauthStep(oauthStepVerify, "error");
              setOauthStatus(
                "Automatic OAuth session expired. This flow requires the wizard and OpenClaw on the same machine and the same browser. Click Try sign-in again.",
                true,
              );
            } else {
              setOauthStatus((data && (data.message || data.error)) || "Could not read OAuth status.", true);
            }
            if (oauthRetryBtn) oauthRetryBtn.classList.remove("hidden");
            updateStartButtonState();
            return;
          }
          const state = typeof data.state === "string" ? data.state : "unknown";
          if (state === "awaiting_browser_callback") {
            setOauthStep(oauthStepPrepare, "done");
            setOauthStep(oauthStepOpen, oauthOpenedInBrowser ? "done" : "active");
            setOauthStep(oauthStepComplete, oauthOpenedInBrowser ? "active" : "pending");
            setOauthStep(oauthStepVerify, oauthOpenedInBrowser ? "active" : "pending");
            if (oauthOpenedInBrowser) {
              const elapsed = oauthFlowStartedAtMs > 0 ? Math.floor((Date.now() - oauthFlowStartedAtMs) / 1000) : 0;
              if (elapsed >= 90) {
                setOauthStatus(
                  "Still waiting for callback. Keep using this same browser on this same machine. If you opened OAuth on another computer, this automatic flow cannot complete.",
                  true,
                );
                if (oauthRetryBtn) oauthRetryBtn.classList.remove("hidden");
              } else {
                setOauthStatus("Waiting for ChatGPT approval to finish. Return here after you continue.", false);
              }
            } else {
              setOauthStatus("Step 2: click Open ChatGPT sign-in, then complete approval and return here.", false);
            }
            updateStartButtonState();
            return;
          }
          stopOauthPolling();
          oauthStartInFlight = false;
          if (state === "succeeded") {
            oauthWizardLoginDone = true;
            oauthSessionId = null;
            hideFallbackPaste();
            setOauthStep(oauthStepPrepare, "done");
            setOauthStep(oauthStepOpen, "done");
            setOauthStep(oauthStepComplete, "done");
            setOauthStep(oauthStepVerify, "done");
            setOauthStatus(data.message || "ChatGPT is connected. You can start installation now.", false, true);
            setOauthOpenButton("");
            if (oauthRetryBtn) oauthRetryBtn.classList.add("hidden");
            updateStartButtonState();
            return;
          }
          const errorText = data.message || data.error || "OAuth login failed.";
          setOauthStep(oauthStepPrepare, "done");
          setOauthStep(oauthStepOpen, "error");
          setOauthStep(oauthStepComplete, "error");
          setOauthStep(oauthStepVerify, "error");
          setOauthStatus(
            errorText + " Automatic mode only works on the same machine and browser. Click Try sign-in again.",
            true,
          );
          setOauthOpenButton("");
          if (oauthRetryBtn) oauthRetryBtn.classList.remove("hidden");
          updateStartButtonState();
        } catch (err) {
          stopOauthPolling();
          oauthStartInFlight = false;
          setOauthStep(oauthStepPrepare, "done");
          setOauthStep(oauthStepOpen, "error");
          setOauthStep(oauthStepComplete, "error");
          setOauthStep(oauthStepVerify, "error");
          setOauthStatus(err && err.message ? String(err.message) : "OAuth status request failed.", true);
          if (oauthRetryBtn) oauthRetryBtn.classList.remove("hidden");
          updateStartButtonState();
        }
      }

      function beginOauthStatusPolling() {
        stopOauthPolling();
        oauthPollTimer = setInterval(() => {
          void pollOauthStatusOnce();
        }, 1500);
        void pollOauthStatusOnce();
      }

      async function startOauthGuidedFlow() {
        if (!isOauthMode() || oauthStartInFlight) return;
        oauthStartInFlight = true;
        oauthWizardLoginDone = false;
        oauthOpenedInBrowser = false;
        oauthFlowStartedAtMs = Date.now();
        if (oauthRetryBtn) oauthRetryBtn.classList.add("hidden");
        setOauthStep(oauthStepPrepare, "active");
        setOauthStep(oauthStepOpen, "pending");
        setOauthStep(oauthStepComplete, "pending");
        setOauthStep(oauthStepVerify, "pending");
        setOauthStatus("Preparing ChatGPT sign-in link...");
        setOauthOpenButton("");
        updateStartButtonState();
        try {
          const res = await fetch("/api/llm/oauth/start", { method: "POST" });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            oauthStartInFlight = false;
            setOauthStep(oauthStepPrepare, "error");
            setOauthStep(oauthStepOpen, "error");
            setOauthStep(oauthStepComplete, "error");
            setOauthStep(oauthStepVerify, "error");
            setOauthStatus((data && (data.message || data.error)) || "Could not start OAuth sign-in.", true);
            if (oauthRetryBtn) oauthRetryBtn.classList.remove("hidden");
            updateStartButtonState();
            return;
          }
          oauthSessionId = typeof data.sessionId === "string" ? data.sessionId : "";
          const authUrl = typeof data.authUrl === "string" ? data.authUrl : "";
          if (!oauthSessionId || !authUrl) {
            oauthStartInFlight = false;
            setOauthStep(oauthStepPrepare, "error");
            setOauthStatus("OpenClaw did not return a valid sign-in URL. Try again.", true);
            if (oauthRetryBtn) oauthRetryBtn.classList.remove("hidden");
            return;
          }
          setOauthOpenButton(authUrl);
          setOauthStep(oauthStepPrepare, "done");
          setOauthStep(oauthStepOpen, "active");
          setOauthStatus("Step 2: click Open ChatGPT sign-in and continue in this same browser.");
          beginOauthStatusPolling();
        } catch (err) {
          oauthStartInFlight = false;
          setOauthStep(oauthStepPrepare, "error");
          setOauthStatus(err && err.message ? String(err.message) : "Could not start OAuth sign-in.", true);
          if (oauthRetryBtn) oauthRetryBtn.classList.remove("hidden");
        }
      }

      /** All-or-nothing: 0 or 4 non-empty X fields; partial is invalid. */
      function xWizardFieldsStatus() {
        const fields = [
          xConsumerKeyEl.value.trim(),
          xConsumerSecretEl.value.trim(),
          xAccessTokenMainEl.value.trim(),
          xAccessTokenMainSecretEl.value.trim(),
        ];
        const filled = fields.filter(Boolean).length;
        return { filled, total: 4, ok: filled === 0 || filled === 4 };
      }

      function updateStartButtonState() {
        if (installLocked) {
          startBtn.disabled = true;
          startBtn.setAttribute("aria-busy", "true");
          if (!llmCatalogLoading) {
            startBtn.textContent = "Installation in progress…";
          }
          return;
        }
        startBtn.removeAttribute("aria-busy");
        startBtn.disabled = llmCatalogLoading || !hasRequiredInputs() || !xWizardFieldsStatus().ok;
        if (!llmCatalogLoading) {
          startBtn.textContent = "Start Installation";
        }
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
            if (elapsedSeconds >= 5) {
              llmLoadingHintTextEl.textContent = "Still loading (" + elapsedSeconds + "s). Check network or reload.";
              return;
            }
            llmLoadingHintTextEl.textContent = "Loading provider list (" + elapsedSeconds + "s)...";
          };
          updateHint();
          stopLlmLoadTicker();
          llmLoadTicker = setInterval(updateHint, 1000);
          updateStartButtonState();
          return;
        }
        stopLlmLoadTicker();
        llmLoadingHintEl.classList.add("hidden");
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
        const provider = effectiveLlmProvider();
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
        setLlmCatalogReady(false, "Loading provider list...");
        try {
          const res = await fetch("/api/llm/options");
          const data = await res.json();
          llmCatalog = data || { providers: [] };
          const providers = (llmCatalog.providers || []).map((entry) => ({ value: entry.id, label: entry.id }));
          if (providers.length === 0) {
            setSelectOptions(llmProviderEl, [{ value: "", label: "No providers available" }], "");
            refreshModelOptions("");
            setLlmCatalogReady(false, "No LLM providers found. Reload the page to try again.", true);
            return;
          }
          setSelectOptions(llmProviderEl, providers, "${defaults.llmProvider}");
          applyLlmAuthModeUi();
          refreshModelOptions("${defaults.llmModel}");
          const catalogMsg = "Choose API key or Codex OAuth, then start installation. After setup, run \`openclaw models list\` for your live catalog.";
          setLlmCatalogReady(true, catalogMsg, false);
        } catch (err) {
          setLlmCatalogReady(false, "Failed to load LLM providers. Reload the page and try again.", true);
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
          xCardEl.classList.add("hidden");
          startCardEl.classList.add("hidden");
          statusCardEl.classList.add("hidden");
          logsCardEl.classList.add("hidden");
          completionScreenEl.classList.remove("hidden");
          return;
        }
        llmCardEl.classList.remove("hidden");
        xCardEl.classList.remove("hidden");
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

        const oauth = isOauthMode();
        const payload = {
          llmAuthMode: oauth ? "oauth" : "api_key",
          llmProvider: oauth ? "openai-codex" : llmProviderEl.value.trim(),
          llmModel: llmModelEl.value.trim(),
          llmCredential: oauth ? "" : llmCredentialEl.value.trim(),
          llmOAuthPaste: "",
          llmOAuthSkipLogin: oauth ? true : false,
          apiKey: document.getElementById("apiKey").value.trim(),
          telegramToken: document.getElementById("telegramToken").value.trim(),
          referralCode: document.getElementById("referralCode").value.trim(),
          xConsumerKey: xConsumerKeyEl.value.trim(),
          xConsumerSecret: xConsumerSecretEl.value.trim(),
          xAccessTokenMain: xAccessTokenMainEl.value.trim(),
          xAccessTokenMainSecret: xAccessTokenMainSecretEl.value.trim(),
        };
        if (oauth) {
          if (!oauthWizardLoginDone) {
            stateEl.textContent = "blocked";
            readyEl.textContent = "";
            manualEl.textContent =
              "Codex OAuth is not completed yet. Use the guided sign-in above in this same browser and wait for the green success message.";
            return;
          }
        } else if (!payload.llmProvider || !payload.llmCredential) {
          stateEl.textContent = "blocked";
          readyEl.textContent = "";
          manualEl.textContent = "LLM provider and API key are required before starting installation.";
          return;
        }
        if (!payload.telegramToken) {
          stateEl.textContent = "blocked";
          readyEl.textContent = "";
          manualEl.textContent = "Telegram bot token is required before starting installation.";
          return;
        }
        const xStatus = xWizardFieldsStatus();
        if (!xStatus.ok) {
          stateEl.textContent = "blocked";
          readyEl.textContent = "";
          manualEl.textContent =
            "X (Twitter) credentials are optional: leave all four fields blank, or fill consumer key, consumer secret, access token, and access token secret.";
          return;
        }

        installLocked = true;
        updateStartButtonState();

        try {
          const res = await fetch("/api/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json().catch(() => ({}));

          if (!res.ok) {
            installLocked = false;
            updateStartButtonState();
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
          installLocked = false;
          updateStartButtonState();
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
        const st = data.status || "idle";
        installLocked = st === "running" || st === "completed";

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
        let manualText = errors.length > 0
          ? errors.map((e) => "Step " + (e.stepId || "unknown") + ":\\n" + (e.error || "")).join("\\n\\n")
          : "";
        const combinedErr = errors.map((e) => e.error || "").join("\\n");
        if (
          data.status === "failed"
          && /REFERRAL_CODE_INVALID|Unknown referral code/i.test(combinedErr)
        ) {
          manualText +=
            (manualText ? "\\n\\n" : "") +
            "Referral code was rejected. Clear or fix the referral field above, then click Start Installation again.";
          const fp = combinedErr.slice(0, 240);
          if (fp && fp !== lastReferralFailFingerprint) {
            lastReferralFailFingerprint = fp;
            try {
              window.alert(
                "Referral code was not accepted. Update or clear the referral field, then click Start Installation again.",
              );
            } catch {
              /* ignore */
            }
          }
        }
        manualEl.textContent = manualText;
        stepsEl.innerHTML = "";
        steps.forEach((row) => {
          const tr = document.createElement("tr");
          tr.innerHTML = "<td>" + row.stepId + "</td><td>" + row.status + "</td><td>" + (row.error || row.detail || "") + "</td>";
          stepsEl.appendChild(tr);
        });
        logsEl.textContent = (data.logs || []).map((l) => "[" + l.at + "] " + l.stepId + " " + l.level + " " + l.text).join("\\n");
        updateStartButtonState();
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
      llmAuthModeApiKey.addEventListener("change", onLlmAuthModeChange);
      llmAuthModeOauth.addEventListener("change", onLlmAuthModeChange);
      llmCredentialEl.addEventListener("input", updateStartButtonState);
      if (oauthOpenUrlBtn) {
        oauthOpenUrlBtn.addEventListener("click", () => {
          if (!oauthSessionId || oauthWizardLoginDone) return;
          oauthOpenedInBrowser = true;
          setOauthStep(oauthStepOpen, "done");
          setOauthStep(oauthStepComplete, "active");
          setOauthStep(oauthStepVerify, "active");
          setOauthStatus("Complete ChatGPT approval in this browser, then return here. We detect completion automatically.");
          showFallbackPasteAfterDelay(15_000);
        });
      }

      if (oauthFallbackSubmitBtn) {
        oauthFallbackSubmitBtn.addEventListener("click", async () => {
          const raw = (oauthFallbackUrlInput && oauthFallbackUrlInput.value || "").trim();
          if (!raw || !raw.includes("code=")) {
            if (oauthFallbackError) {
              oauthFallbackError.textContent = "Paste the full URL from the browser address bar. It must contain code=…";
              oauthFallbackError.classList.remove("hidden");
            }
            return;
          }
          if (oauthFallbackError) oauthFallbackError.classList.add("hidden");
          oauthFallbackSubmitBtn.disabled = true;
          oauthFallbackSubmitBtn.textContent = "Submitting…";
          try {
            const res = await fetch("/api/llm/oauth/submit-callback-url", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId: oauthSessionId, callbackUrl: raw }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) {
              hideFallbackPaste();
              setOauthStatus("Callback received! Waiting for OpenClaw to finish…", false);
            } else {
              if (oauthFallbackError) {
                oauthFallbackError.textContent = data.message || data.error || "Could not submit the URL. Try again.";
                oauthFallbackError.classList.remove("hidden");
              }
            }
          } catch (err) {
            if (oauthFallbackError) {
              oauthFallbackError.textContent = err.message || "Request failed.";
              oauthFallbackError.classList.remove("hidden");
            }
          } finally {
            oauthFallbackSubmitBtn.disabled = false;
            oauthFallbackSubmitBtn.textContent = "Submit URL";
          }
        });
      }

      if (oauthRetryBtn) {
        oauthRetryBtn.addEventListener("click", async () => {
          await cancelOauthSession();
          resetOauthWizardState();
          if (isOauthMode()) {
            await startOauthGuidedFlow();
          }
        });
      }

      telegramTokenEl.addEventListener("input", updateStartButtonState);
      xConsumerKeyEl.addEventListener("input", updateStartButtonState);
      xConsumerSecretEl.addEventListener("input", updateStartButtonState);
      xAccessTokenMainEl.addEventListener("input", updateStartButtonState);
      xAccessTokenMainSecretEl.addEventListener("input", updateStartButtonState);
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
  const { createInstallerStepEngine, assertWizardXCredentials, spawnOpenClawCodexAuthLoginChild } =
    await import("./installer-step-engine.mjs");
  const modeConfig = {
    pluginPackage: "solana-traderclaw",
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

  /** Guided Codex OAuth sessions keyed by sessionId. */
  const oauthSessions = new Map();
  const OPENAI_OAUTH_AUTHORIZE_RE = /https:\/\/auth\.openai\.com\/oauth\/authorize\S*/;
  const oauthSessionTtlMs = 15 * 60 * 1000;

  // Long-lived callback proxy on port 1455. Bound at wizard startup so
  // Cursor/VSCode auto-forwards it to the user's laptop before they begin
  // the OAuth flow. When ChatGPT redirects the browser to localhost:1455,
  // this proxy catches the callback and feeds the code to the active
  // openclaw child process.
  let oauthCallbackProxy = null;

  function findActiveOauthSession() {
    for (const [, s] of oauthSessions) {
      if (s.status === "awaiting_browser_callback" && s.child) return s;
    }
    return null;
  }

  function startCallbackProxy() {
    if (oauthCallbackProxy) return;
    try {
      oauthCallbackProxy = createServer((cbReq, cbRes) => {
        const s = findActiveOauthSession();
        const fullUrl = `http://localhost:1455${cbReq.url}`;
        if (s && cbReq.url && cbReq.url.includes("code=")) {
          s.updatedAt = Date.now();
          try {
            if (s.child && s.child.stdin && !s.child.stdin.writableEnded && !s.child.stdin.destroyed) {
              s.child.stdin.write(`${fullUrl}\n`, () => {
                setTimeout(() => {
                  try {
                    if (s.child && s.child.stdin && !s.child.stdin.destroyed && !s.child.stdin.writableEnded) {
                      s.child.stdin.end();
                    }
                  } catch { /* ignore */ }
                }, 100);
              });
            }
          } catch { /* ignore */ }
          cbRes.statusCode = 200;
          cbRes.setHeader("content-type", "text/html; charset=utf-8");
          cbRes.end(`<html><body style="background:#0a0e1a;color:#78f0a9;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;"><h2>ChatGPT sign-in received!</h2><p style="color:#c5d7f5;font-size:16px;">You can close this tab and return to the installer wizard.</p></body></html>`);
        } else {
          cbRes.statusCode = 200;
          cbRes.setHeader("content-type", "text/html; charset=utf-8");
          cbRes.end(`<html><body style="background:#0a0e1a;color:#9cb0de;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;"><h2>TraderClaw OAuth Callback Listener</h2><p>Waiting for ChatGPT redirect. If you see this page, the callback proxy is working.</p></body></html>`);
        }
      });
      oauthCallbackProxy.listen(1455, "127.0.0.1");
      oauthCallbackProxy.on("error", () => {
        oauthCallbackProxy = null;
      });
    } catch {
      oauthCallbackProxy = null;
    }
  }

  /**
   * Release port 1455 so the OpenClaw CLI can bind its own callback server
   * during `openclaw models auth login`. Returns a promise that resolves
   * once the proxy is fully closed (or after a safety timeout).
   */
  function stopCallbackProxy() {
    return new Promise((resolve) => {
      if (!oauthCallbackProxy) { resolve(); return; }
      const proxy = oauthCallbackProxy;
      oauthCallbackProxy = null;
      const safety = setTimeout(resolve, 2000);
      proxy.close(() => { clearTimeout(safety); setTimeout(resolve, 150); });
    });
  }

  function hasOpenaiCodexAuthTokens() {
    try {
      const authFile = join(homedir(), ".openclaw", "agents", "main", "agent", "auth-profiles.json");
      const raw = readFileSync(authFile, "utf-8");
      const data = JSON.parse(raw);
      return data && typeof data === "object" && JSON.stringify(data).length > 20;
    } catch {
      return false;
    }
  }

  function killOauthSession(sessionId, signal = "SIGTERM") {
    const s = oauthSessions.get(sessionId);
    if (!s) return;
    try {
      if (s.child) s.child.kill(signal);
    } catch {
      /* ignore */
    }
    oauthSessions.delete(sessionId);
  }

  function pruneExpiredOauthSessions() {
    const now = Date.now();
    for (const [id, s] of oauthSessions) {
      const anchor = s.updatedAt || s.createdAt || now;
      if (now - anchor > oauthSessionTtlMs) {
        killOauthSession(id);
      }
    }
  }

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
      try {
        if (!wizardLlmCatalogPromise) {
          wizardLlmCatalogPromise = loadWizardLlmCatalogAsync().catch((err) => {
            wizardLlmCatalogPromise = null;
            throw err;
          });
        }
        const payload = await wizardLlmCatalogPromise;
        respondJson(200, payload);
      } catch (err) {
        respondJson(500, {
          source: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/llm/oauth/status")) {
      pruneExpiredOauthSessions();
      let sessionId = "";
      try {
        const u = new URL(req.url, "http://127.0.0.1");
        sessionId = String(u.searchParams.get("sessionId") || "").trim();
      } catch {
        sessionId = "";
      }
      if (!sessionId) {
        respondJson(400, { ok: false, error: "session_id_required" });
        return;
      }
      const s = oauthSessions.get(sessionId);
      if (!s) {
        respondJson(404, { ok: false, error: "invalid_or_expired_session", message: "OAuth session expired. Start sign-in again." });
        return;
      }
      respondJson(200, {
        ok: true,
        state: s.status || "unknown",
        message: s.message || "",
        authUrl: s.authUrl || "",
        exitCode: typeof s.exitCode === "number" ? s.exitCode : null,
        detail: s.detail || "",
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/llm/oauth/start") {
      pruneExpiredOauthSessions();
      if (running) {
        respondJson(409, { ok: false, error: "install_in_progress" });
        return;
      }
      if (!commandExists("openclaw")) {
        respondJson(503, {
          ok: false,
          error: "openclaw_not_in_path",
          message: "Install OpenClaw on this machine first (e.g. npm install -g openclaw), then try again.",
        });
        return;
      }
      for (const id of [...oauthSessions.keys()]) {
        killOauthSession(id);
      }

      // Release port 1455 so the OpenClaw CLI can bind its own callback
      // server directly. The previous approach relied on the wizard proxy
      // catching the callback and forwarding the code via stdin, but
      // `script` (PTY wrapper) does not reliably forward stdin to the
      // inner process, causing tokens to never be saved.
      await stopCallbackProxy();

      const sessionId = randomUUID();
      const child = spawnOpenClawCodexAuthLoginChild();

      let combined = "";
      let responded = false;
      const urlTimeout = setTimeout(() => {
        if (responded) return;
        responded = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        oauthSessions.delete(sessionId);
        startCallbackProxy();
        respondJson(504, {
          ok: false,
          error: "oauth_url_timeout",
          message:
            "OpenClaw did not provide a ChatGPT sign-in URL in time. Try again.",
        });
      }, 45_000);

      const trySendUrl = () => {
        if (responded) return;
        const m = combined.match(OPENAI_OAUTH_AUTHORIZE_RE);
        if (!m || !m[0]) return;
        clearTimeout(urlTimeout);
        responded = true;
        oauthSessions.set(sessionId, {
          child,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: "awaiting_browser_callback",
          authUrl: m[0],
          message: "Sign in in this same browser. OpenClaw is waiting for callback...",
          detail: "",
          exitCode: null,
          submitted: false,
        });
        respondJson(200, { ok: true, sessionId, authUrl: m[0] });
      };

      child.stdout?.on("data", (d) => {
        combined += d.toString();
        trySendUrl();
      });
      child.stderr?.on("data", (d) => {
        combined += d.toString();
        trySendUrl();
      });
      child.on("error", (err) => {
        clearTimeout(urlTimeout);
        startCallbackProxy();
        if (responded) return;
        responded = true;
        oauthSessions.delete(sessionId);
        respondJson(500, { ok: false, error: "spawn_failed", message: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(urlTimeout);
        startCallbackProxy();
        if (!responded) {
          responded = true;
          oauthSessions.delete(sessionId);
          respondJson(500, {
            ok: false,
            error: "oauth_login_exited_early",
            exitCode: code,
            message:
              "OpenClaw exited before showing a sign-in URL. Start OAuth again and keep the flow on this same machine/browser.",
            detail: stripAnsi(combined).slice(-4000),
          });
          return;
        }
        const pending = oauthSessions.get(sessionId);
        if (pending) {
          pending.child = null;
          pending.updatedAt = Date.now();
          pending.exitCode = typeof code === "number" ? code : null;
          pending.detail = stripAnsi(combined).slice(-4000);
          if (code === 0 && hasOpenaiCodexAuthTokens()) {
            pending.status = "succeeded";
            pending.message = "ChatGPT OAuth completed successfully.";
          } else if (code === 0) {
            pending.status = "failed";
            pending.message =
              "OpenClaw exited OK but no auth tokens were saved. " +
              "Run 'openclaw models auth login --provider openai-codex' in a terminal, " +
              "then re-run the wizard with the already-logged-in option.";
          } else {
            pending.status = "failed";
            pending.message =
              "OpenClaw OAuth did not complete. Try again — make sure you continue in the same browser that opened the sign-in link.";
          }
        }
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/llm/oauth/submit") {
      const body = await parseJsonBody(req).catch(() => ({}));
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const paste = typeof body.paste === "string" ? body.paste.trim() : "";
      if (!sessionId || !oauthSessions.has(sessionId)) {
        respondJson(400, { ok: false, error: "invalid_or_expired_session", message: "Click “Get ChatGPT sign-in link” again." });
        return;
      }
      if (!paste) {
        respondJson(400, { ok: false, error: "paste_required" });
        return;
      }
      const s = oauthSessions.get(sessionId);
      s.submitted = true;
      const { child } = s;

      await new Promise((resolve) => {
        let settled = false;
        let submitTimeout;
        const finish = (httpCode, payload) => {
          if (settled) return;
          settled = true;
          clearTimeout(submitTimeout);
          oauthSessions.delete(sessionId);
          respondJson(httpCode, payload);
          resolve();
        };

        submitTimeout = setTimeout(() => {
          killOauthSession(sessionId);
          finish(504, {
            ok: false,
            error: "oauth_submit_timeout",
            message: "Login did not finish in time. Try again or complete login in a normal terminal.",
          });
        }, 300_000);

        child.once("close", (code) => {
          if (code === 0) {
            finish(200, { ok: true });
          } else {
            finish(500, {
              ok: false,
              error: "oauth_login_failed",
              exitCode: code,
              message: "OpenClaw rejected the pasted URL or code. Paste the full redirect URL from the browser address bar, or run login in a terminal.",
            });
          }
        });

        try {
          const line = `${paste}\n`;
          if (child.stdin?.writableEnded || child.stdin?.destroyed) {
            killOauthSession(sessionId);
            finish(500, { ok: false, error: "stdin_closed", message: "The login session closed before paste could be sent." });
            return;
          }
          child.stdin.write(line, (err) => {
            if (err) {
              killOauthSession(sessionId);
              finish(500, { ok: false, error: "stdin_write_failed", message: err?.message || String(err) });
              return;
            }
            // End stdin so the PTY/readline layer forwards the line and the CLI can proceed (plain `script` often buffers otherwise).
            setTimeout(() => {
              try {
                if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
                  child.stdin.end();
                }
              } catch {
                /* ignore */
              }
            }, 100);
          });
        } catch (err) {
          killOauthSession(sessionId);
          finish(500, { ok: false, error: "stdin_write_failed", message: err?.message || String(err) });
        }
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/llm/oauth/submit-callback-url") {
      const body = await parseJsonBody(req).catch(() => ({}));
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const callbackUrl = typeof body.callbackUrl === "string" ? body.callbackUrl.trim() : "";
      if (!callbackUrl || !callbackUrl.includes("code=")) {
        respondJson(400, { ok: false, error: "invalid_url", message: "URL must contain a code= parameter." });
        return;
      }
      const s = sessionId ? oauthSessions.get(sessionId) : findActiveOauthSession();
      if (!s || !s.child) {
        respondJson(404, { ok: false, error: "no_active_session", message: "No active OAuth session. Click Try sign-in again." });
        return;
      }
      try {
        if (s.child.stdin && !s.child.stdin.writableEnded && !s.child.stdin.destroyed) {
          s.child.stdin.write(`${callbackUrl}\n`, () => {
            setTimeout(() => {
              try {
                if (s.child && s.child.stdin && !s.child.stdin.destroyed && !s.child.stdin.writableEnded) {
                  s.child.stdin.end();
                }
              } catch { /* ignore */ }
            }, 100);
          });
          s.updatedAt = Date.now();
          respondJson(200, { ok: true, message: "Callback URL submitted. Waiting for OpenClaw to complete…" });
        } else {
          respondJson(500, { ok: false, error: "stdin_closed", message: "OpenClaw process stdin is closed. Click Try sign-in again." });
        }
      } catch (err) {
        respondJson(500, { ok: false, error: "write_error", message: err.message || "Failed to write to OpenClaw." });
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/llm/oauth/cancel") {
      const body = await parseJsonBody(req).catch(() => ({}));
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (sessionId && oauthSessions.has(sessionId)) {
        killOauthSession(sessionId);
      } else {
        for (const id of [...oauthSessions.keys()]) {
          killOauthSession(id);
        }
      }
      respondJson(200, { ok: true });
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
      const rawLlmAuth = body.llmAuthMode != null ? body.llmAuthMode : defaults.llmAuthMode;
      const wizardOpts = {
        mode: "light",
        lane: defaults.lane,
        llmAuthMode: rawLlmAuth === "oauth" ? "oauth" : "api_key",
        llmProvider: body.llmProvider || defaults.llmProvider,
        llmModel: body.llmModel || defaults.llmModel,
        llmCredential: body.llmCredential || defaults.llmCredential,
        llmOAuthPaste: typeof body.llmOAuthPaste === "string" ? body.llmOAuthPaste.trim() : defaults.llmOAuthPaste,
        llmOAuthSkipLogin:
          typeof body.llmOAuthSkipLogin === "boolean" ? body.llmOAuthSkipLogin : defaults.llmOAuthSkipLogin === true,
        apiKey: body.apiKey || defaults.apiKey,
        orchestratorUrl: defaults.orchestratorUrl,
        gatewayBaseUrl: defaults.gatewayBaseUrl,
        gatewayToken: defaults.gatewayToken,
        enableTelegram: true,
        telegramToken: body.telegramToken || defaults.telegramToken,
        autoInstallDeps: true,
        referralCode: typeof body.referralCode === "string" ? body.referralCode.trim() : "",
        xConsumerKey: body.xConsumerKey ?? defaults.xConsumerKey,
        xConsumerSecret: body.xConsumerSecret ?? defaults.xConsumerSecret,
        xAccessTokenMain: body.xAccessTokenMain ?? defaults.xAccessTokenMain,
        xAccessTokenMainSecret: body.xAccessTokenMainSecret ?? defaults.xAccessTokenMainSecret,
      };
      const xErr = assertWizardXCredentials(modeConfig, wizardOpts);
      if (xErr) {
        respondJson(400, { ok: false, error: xErr });
        return;
      }

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
          llmAuthMode: wizardOpts.llmAuthMode,
          llmProvider: body.llmProvider || defaults.llmProvider,
          llmModel: body.llmModel || defaults.llmModel,
          llmCredential: body.llmCredential || defaults.llmCredential,
          llmOAuthPaste: wizardOpts.llmOAuthPaste,
          llmOAuthSkipLogin: wizardOpts.llmOAuthSkipLogin,
          apiKey: body.apiKey || defaults.apiKey,
          orchestratorUrl: defaults.orchestratorUrl,
          gatewayBaseUrl: defaults.gatewayBaseUrl,
          gatewayToken: defaults.gatewayToken,
          enableTelegram: true,
          telegramToken: body.telegramToken || defaults.telegramToken,
          autoInstallDeps: true,
          referralCode: wizardOpts.referralCode,
          xConsumerKey: wizardOpts.xConsumerKey,
          xConsumerSecret: wizardOpts.xConsumerSecret,
          xAccessTokenMain: wizardOpts.xAccessTokenMain,
          xAccessTokenMainSecret: wizardOpts.xAccessTokenMainSecret,
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

  // Start the OAuth callback proxy on port 1455 early so Cursor/VSCode
  // auto-forwards it to the user's laptop before the OAuth flow begins.
  startCallbackProxy();
  if (oauthCallbackProxy) {
    printInfo(`OAuth callback proxy listening on http://127.0.0.1:1455`);
  }

  const url = `http://127.0.0.1:${defaults.port}`;
  printSuccess(`Installer wizard is running at ${url}`);
  if (!openBrowser(url)) {
    printInfo(`Open this URL in your browser: ${url}`);
  }
  printInfo("Press Ctrl+C to stop the wizard server.");
  printInfo(`If you are on a remote VPS, forward both ports from your local machine:`);
  printInfo(`  ssh -L ${defaults.port}:127.0.0.1:${defaults.port} -L 1455:127.0.0.1:1455 <user>@<your-vps>`);
}

async function cmdTestSession(args) {
  const config = readConfig();
  const pluginConfig = getPluginConfig(config);

  if (!pluginConfig) {
    printError("No plugin configuration found. Run 'traderclaw setup' first.");
    process.exit(1);
  }

  const orchestratorUrl = pluginConfig.orchestratorUrl;
  if (!orchestratorUrl) {
    printError("orchestratorUrl not set in config. Run 'traderclaw setup' to fix.");
    process.exit(1);
  }

  const dataDir = pluginConfig.dataDir || join(process.cwd(), ".traderclaw-v1-data");
  const sessionTokensPath = join(dataDir, "session-tokens.json");

  let sidecar = null;
  try {
    if (existsSync(sessionTokensPath)) {
      sidecar = JSON.parse(readFileSync(sessionTokensPath, "utf-8"));
    }
  } catch { /* ignore */ }

  const effectiveRefreshToken =
    (sidecar?.refreshToken && sidecar.refreshToken.length > 0)
      ? sidecar.refreshToken
      : pluginConfig.refreshToken;

  const walletPrivateKeyInput = args.includes("--wallet-private-key")
    ? args[args.indexOf("--wallet-private-key") + 1] || ""
    : "";

  print("\nTraderClaw V1 — Session Auth Test\n");
  print("=".repeat(50));
  printInfo(`  Orchestrator:     ${orchestratorUrl}`);
  printInfo(`  API key:          ${pluginConfig.apiKey ? maskKey(pluginConfig.apiKey) : "MISSING"}`);
  printInfo(`  Refresh token:    ${effectiveRefreshToken ? maskKey(effectiveRefreshToken) : "MISSING"}`);
  printInfo(`  Sidecar file:     ${sidecar ? sessionTokensPath : "not found"}`);
  printInfo(`  Wallet pub key:   ${pluginConfig.walletPublicKey || "not set"}`);
  printInfo(`  Wallet priv key:  ${getRuntimeWalletPrivateKey(walletPrivateKeyInput) ? "available" : "NOT AVAILABLE"}`);
  print("");

  const results = [];
  let currentAccessToken = null;
  let currentRefreshToken = effectiveRefreshToken;

  // --- Test 1: Initial refresh ---
  print("  [1/5] Token refresh...");
  const t1Start = Date.now();
  try {
    if (!currentRefreshToken) {
      throw new Error("No refresh token available — skip to challenge flow test");
    }
    const tokens = await doRefresh(orchestratorUrl, currentRefreshToken);
    if (!tokens) {
      printWarn("        Refresh returned null (token revoked/expired) — will test challenge flow");
      results.push({ test: "initial_refresh", status: "expired", ms: Date.now() - t1Start });
      currentRefreshToken = null;
    } else {
      const ms = Date.now() - t1Start;
      currentAccessToken = tokens.accessToken;
      currentRefreshToken = tokens.refreshToken;
      printSuccess(`        OK (${ms}ms) — accessTokenTtl: ${tokens.accessTokenTtlSeconds}s, refreshTokenTtl: ${tokens.refreshTokenTtlSeconds}s`);
      results.push({
        test: "initial_refresh",
        status: "ok",
        ms,
        accessTokenTtl: tokens.accessTokenTtlSeconds,
        refreshTokenTtl: tokens.refreshTokenTtlSeconds,
        tier: tokens.session?.tier,
      });
    }
  } catch (err) {
    printError(`        FAIL: ${err.message}`);
    results.push({ test: "initial_refresh", status: "fail", ms: Date.now() - t1Start, error: err.message });
    currentRefreshToken = null;
  }

  // --- Test 2: Second refresh (verifies rotation worked) ---
  print("  [2/5] Second refresh (token rotation check)...");
  const t2Start = Date.now();
  try {
    if (!currentRefreshToken) {
      throw new Error("No refresh token — skipped (previous test failed)");
    }
    const tokens2 = await doRefresh(orchestratorUrl, currentRefreshToken);
    if (!tokens2) {
      printError("        FAIL: second refresh returned null — rotation may be broken");
      results.push({ test: "rotation_check", status: "fail", ms: Date.now() - t2Start, error: "null response" });
    } else {
      const ms = Date.now() - t2Start;
      const rotated = tokens2.refreshToken !== currentRefreshToken;
      currentAccessToken = tokens2.accessToken;
      currentRefreshToken = tokens2.refreshToken;
      if (rotated) {
        printSuccess(`        OK (${ms}ms) — refresh token rotated correctly`);
      } else {
        printWarn(`        OK (${ms}ms) — refresh token NOT rotated (server may use static tokens)`);
      }
      results.push({ test: "rotation_check", status: "ok", ms, rotated });
    }
  } catch (err) {
    printError(`        FAIL: ${err.message}`);
    results.push({ test: "rotation_check", status: "fail", ms: Date.now() - t2Start, error: err.message });
  }

  // --- Test 3: API call with access token ---
  print("  [3/5] Authenticated API call (/healthz)...");
  const t3Start = Date.now();
  try {
    if (!currentAccessToken) {
      throw new Error("No access token — skipped");
    }
    const health = await httpRequest(`${orchestratorUrl}/healthz`, {
      accessToken: currentAccessToken,
      timeout: 8000,
    });
    const ms = Date.now() - t3Start;
    if (health.ok) {
      printSuccess(`        OK (${ms}ms) — orchestrator healthy`);
      results.push({ test: "api_call", status: "ok", ms });
    } else {
      printError(`        FAIL: HTTP ${health.status}`);
      results.push({ test: "api_call", status: "fail", ms, error: `HTTP ${health.status}` });
    }
  } catch (err) {
    printError(`        FAIL: ${err.message}`);
    results.push({ test: "api_call", status: "fail", ms: Date.now() - t3Start, error: err.message });
  }

  // --- Test 4: Challenge flow (re-auth from scratch) ---
  print("  [4/5] Challenge flow (full re-authentication)...");
  const t4Start = Date.now();
  try {
    if (!pluginConfig.apiKey) {
      throw new Error("No API key — cannot test challenge flow");
    }
    const challenge = await doChallenge(orchestratorUrl, pluginConfig.apiKey, pluginConfig.walletPublicKey);
    const ms = Date.now() - t4Start;
    if (challenge.walletProofRequired) {
      const wpk = getRuntimeWalletPrivateKey(walletPrivateKeyInput);
      if (wpk) {
        try {
          const walletSig = signChallengeLocally(challenge.challenge, wpk);
          const tokens = await doSessionStart(
            orchestratorUrl,
            pluginConfig.apiKey,
            challenge.challengeId,
            challenge.walletPublicKey || pluginConfig.walletPublicKey,
            walletSig,
          );
          const totalMs = Date.now() - t4Start;
          currentAccessToken = tokens.accessToken;
          currentRefreshToken = tokens.refreshToken;
          printSuccess(`        OK (${totalMs}ms) — challenge + wallet proof succeeded`);
          results.push({ test: "challenge_flow", status: "ok", ms: totalMs, walletProof: true });
        } catch (sigErr) {
          printError(`        FAIL (wallet signing): ${sigErr.message}`);
          results.push({ test: "challenge_flow", status: "fail", ms: Date.now() - t4Start, error: sigErr.message });
        }
      } else {
        printWarn(`        PARTIAL (${ms}ms) — challenge OK but wallet proof needed and TRADERCLAW_WALLET_PRIVATE_KEY not available`);
        printWarn("        Set TRADERCLAW_WALLET_PRIVATE_KEY env var or pass --wallet-private-key to test fully");
        results.push({ test: "challenge_flow", status: "partial", ms, walletProofRequired: true, keyAvailable: false });
      }
    } else {
      const tokens = await doSessionStart(orchestratorUrl, pluginConfig.apiKey, challenge.challengeId);
      const totalMs = Date.now() - t4Start;
      currentAccessToken = tokens.accessToken;
      currentRefreshToken = tokens.refreshToken;
      printSuccess(`        OK (${totalMs}ms) — challenge flow succeeded (no wallet proof needed)`);
      results.push({ test: "challenge_flow", status: "ok", ms: totalMs, walletProof: false });
    }
  } catch (err) {
    printError(`        FAIL: ${err.message}`);
    results.push({ test: "challenge_flow", status: "fail", ms: Date.now() - t4Start, error: err.message });
  }

  // --- Test 5: Persist rotated tokens back to sidecar ---
  print("  [5/5] Persist tokens to sidecar...");
  try {
    if (currentRefreshToken && currentAccessToken) {
      mkdirSync(dataDir, { recursive: true });
      let existingSidecar = {};
      try {
        if (existsSync(sessionTokensPath)) {
          existingSidecar = JSON.parse(readFileSync(sessionTokensPath, "utf-8")) || {};
        }
      } catch { /* ignore */ }
      const payload = {
        ...existingSidecar,
        refreshToken: currentRefreshToken,
        accessToken: currentAccessToken,
        accessTokenExpiresAt: Date.now() + 900_000,
        walletPublicKey: pluginConfig.walletPublicKey || undefined,
      };
      const tmp = `${sessionTokensPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf-8");
      const { renameSync } = await import("fs");
      renameSync(tmp, sessionTokensPath);
      printSuccess(`        OK — written to ${sessionTokensPath}`);
      results.push({ test: "persist_sidecar", status: "ok" });

      pluginConfig.refreshToken = currentRefreshToken;
      removeLegacyWalletPrivateKey(pluginConfig);
      setPluginConfig(config, pluginConfig);
      writeConfig(config);
      printSuccess("        Config updated with latest refresh token");
    } else {
      printWarn("        SKIP — no valid tokens to persist");
      results.push({ test: "persist_sidecar", status: "skip" });
    }
  } catch (err) {
    printError(`        FAIL: ${err.message}`);
    results.push({ test: "persist_sidecar", status: "fail", error: err.message });
  }

  // --- Summary ---
  print("\n" + "=".repeat(50));
  const passed = results.filter((r) => r.status === "ok").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const partial = results.filter((r) => r.status === "partial" || r.status === "expired" || r.status === "skip").length;

  if (failed === 0 && passed > 0) {
    printSuccess(`\n  ALL TESTS PASSED (${passed}/${results.length})`);
  } else if (failed > 0) {
    printError(`\n  ${failed} FAILED, ${passed} passed, ${partial} skipped/partial`);
  } else {
    printWarn(`\n  ${passed} passed, ${partial} skipped/partial`);
  }

  print("\n  Build-and-test workflow (no reinstall):");
  printInfo("    cd /path/to/plugin && npm run build");
  printInfo("    npm link");
  printInfo("    sudo systemctl restart openclaw");
  printInfo("    traderclaw test-session");
  print("");

  if (failed > 0) process.exit(1);
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
  repair-openclaw    Re-run npm install in the global openclaw package (fixes missing grammy / @buape/carbon; uses --ignore-scripts so @discordjs/opus does not require build tools)
  gateway            Gateway helpers (see subcommands below)
  login              Re-authenticate (uses refresh token when valid; full challenge only if needed)
  logout             Revoke current session and clear tokens
  status             Check connection health and wallet status
  config             View and manage configuration
  test-session       Test session auth flow (refresh, rotation, challenge) without reinstalling

Setup options:
  --api-key, -k      API key (skip interactive prompt)
  --url, -u          Orchestrator URL (skip interactive prompt)
  --user-id          External user ID for signup
  --wallet-private-key  Optional base58 private key for wallet proof flow (runtime only, never saved)
  --gateway-base-url, -g  Gateway public HTTPS URL for orchestrator callbacks
  --gateway-token, -t     Gateway bearer token (defaults to API key)
  --telegram-recipient    Telegram @username or chat id (aliases: --forward-telegram-chat-id, --telegram-chat-id)
  --referral-code, -r   Optional referral code for new signups (extra trial time when valid)
  --skip-gateway-registration  Skip gateway URL registration with orchestrator
  --show-api-key     Extra hint after signup (full key is always shown once; confirm with API_KEY_STORED)
  --show-wallet-private-key  Reveal full wallet private key in setup output
  --signup           Force signup flow (create new account)
  --write-gateway-env  Write TRADERCLAW_WALLET_PRIVATE_KEY to a systemd EnvironmentFile for the user gateway (Linux)
  --no-ensure-gateway-persistent  Skip automatic Linux loginctl linger + user unit enable after setup

Gateway subcommands:
  gateway ensure-persistent   Linux: enable loginctl linger and systemd --user unit for OpenClaw gateway

Login options:
  --wallet-private-key <k>  Base58 key for wallet proof when the server requires it (runtime only)
  --force-reauth       Clear refresh token and run full API challenge (use after logout or to rotate session)

Config subcommands:
  config show        Show current configuration
  config set <k> <v> Update a configuration value
  config reset       Remove plugin configuration

Install wizard (traderclaw install --wizard):
  --port                 Local port for the wizard (default 17890)
  --llm-provider         e.g. openai, openai-codex, anthropic
  --llm-model            e.g. openai/gpt-5.4 or openai-codex/gpt-5.4
  --llm-api-key, --llm-token   API key for LLM (api_key mode)
  --llm-auth api_key|oauth     OpenAI Platform key vs ChatGPT/Codex OAuth (openai-codex)
  --llm-oauth-paste    Paste redirect URL or code for Codex OAuth (non-skip)
  --llm-oauth-skip-login       Skip login when you already ran openclaw models auth login

Examples:
  traderclaw signup
  traderclaw setup
  traderclaw login --wallet-private-key <base58_key>
  TRADERCLAW_WALLET_PRIVATE_KEY=<base58_key> traderclaw login
  traderclaw precheck --dry-run --output precheck.log
  traderclaw precheck --allow-install
  traderclaw install --wizard
  traderclaw install --wizard --lane quick-local
  traderclaw install --wizard --llm-auth oauth --llm-provider openai-codex --llm-oauth-skip-login
  traderclaw repair-openclaw
  traderclaw gateway ensure-persistent
  traderclaw setup --signup --user-id my_agent_001 --referral-code ABCD1234
  traderclaw setup --api-key oc_xxx --url https://api.traderclaw.ai
  traderclaw setup --gateway-base-url https://gateway.myhost.ts.net
  traderclaw setup --telegram-recipient @myusername
  traderclaw login
  traderclaw login --force-reauth --wallet-private-key <base58_key>
  traderclaw logout
  traderclaw status
  traderclaw config show
  traderclaw config set apiTimeout 60000
  traderclaw test-session
  traderclaw test-session --wallet-private-key <base58_key>
`);
}

async function cmdRepairOpenclaw() {
  const { ensureOpenClawGlobalPackageDependencies } = await import("./installer-step-engine.mjs");
  printInfo("Repairing global OpenClaw npm dependencies (fixes missing grammy, @buape/carbon, etc.)...");
  const r = await ensureOpenClawGlobalPackageDependencies();
  if (r.skipped) {
    printError(`Could not find global OpenClaw package (${r.reason}). Install or upgrade: npm install -g openclaw@latest`);
    process.exit(1);
  }
  printSuccess(`Dependencies refreshed under ${r.dir}`);
  printInfo("Next: openclaw gateway restart");
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    if (CLI_VERSION && PLUGIN_VERSION && CLI_VERSION !== PLUGIN_VERSION) {
      print(`traderclaw v${CLI_VERSION} (plugin solana-traderclaw v${PLUGIN_VERSION})`);
    } else {
      print(`traderclaw v${VERSION}`);
    }
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
    case "repair-openclaw":
      await cmdRepairOpenclaw();
      break;
    case "gateway":
      await cmdGateway(args.slice(1));
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
    case "test-session":
      await cmdTestSession(args.slice(1));
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
