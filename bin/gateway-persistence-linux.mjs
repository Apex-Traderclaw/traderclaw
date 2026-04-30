/**
 * Linux VPS: keep OpenClaw gateway running after SSH disconnect (systemd user + loginctl linger)
 * and optionally persist TRADERCLAW_WALLET_PRIVATE_KEY for the gateway via EnvironmentFile + drop-in.
 */

import { execSync, spawn } from "child_process";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { homedir, userInfo } from "os";
import { basename, join } from "path";

const WALLET_ENV_BASENAME = "traderclaw-gateway-wallet.env";
const DROPIN_NAME = "traderclaw-wallet.conf";
const DEFAULT_UNIT = "openclaw-gateway.service";

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

function isWsl() {
  return typeof process.env.WSL_DISTRO_NAME === "string" && process.env.WSL_DISTRO_NAME.length > 0;
}

/**
 * @returns {{ linux: boolean, wsl: boolean, hasSystemctl: boolean, hasLoginctl: boolean, hasOpenclaw: boolean }}
 */
export function linuxGatewayPersistenceContext() {
  const linux = process.platform === "linux";
  return {
    linux,
    wsl: isWsl(),
    hasSystemctl: linux && commandExists("systemctl"),
    hasLoginctl: linux && commandExists("loginctl"),
    hasOpenclaw: commandExists("openclaw"),
  };
}

/**
 * True when we should attempt linger / user systemd helpers (not macOS, not WSL by default).
 */
export function isLinuxGatewayPersistenceEligible() {
  const ctx = linuxGatewayPersistenceContext();
  if (!ctx.linux || ctx.wsl) return false;
  if (!ctx.hasSystemctl || !ctx.hasLoginctl) return false;
  return true;
}

function parseLinger(output) {
  if (!output || typeof output !== "string") return null;
  for (const line of output.split("\n")) {
    const m = line.match(/^Linger=(.+)$/);
    if (m) return m[1].trim() === "yes";
  }
  return null;
}

/**
 * @returns {{ eligible: boolean, linger: boolean | null, username: string }}
 */
export function getLinuxGatewayPersistenceSnapshot(username = userInfo().username) {
  if (!isLinuxGatewayPersistenceEligible()) {
    return { eligible: false, linger: null, username };
  }
  const raw = getCommandOutput(`loginctl show-user '${String(username).replace(/'/g, "'\\''")}' -p Linger 2>/dev/null`);
  const linger = parseLinger(raw || "");
  return { eligible: true, linger, username };
}

/**
 * Parse `openclaw gateway status --json` for systemd unit basename.
 */
export function resolveGatewayUnitNameFromStatusJson(statusJson) {
  if (!statusJson || typeof statusJson !== "object") return DEFAULT_UNIT;
  const svc = statusJson.service;
  if (svc && typeof svc === "object") {
    const file =
      typeof svc.file === "string"
        ? svc.file
        : typeof svc.systemd?.file === "string"
          ? svc.systemd.file
          : typeof svc.systemd?.unitPath === "string"
            ? svc.systemd.unitPath
            : "";
    if (file && file.endsWith(".service")) {
      const base = basename(file.trim());
      if (base) return base;
    }
    const unit = typeof svc.systemd?.unit === "string" ? svc.systemd.unit.trim() : "";
    if (unit && unit.endsWith(".service")) return unit;
  }
  return DEFAULT_UNIT;
}

export function readOpenclawGatewayStatusJson() {
  const raw = getCommandOutput("openclaw gateway status --json 2>/dev/null");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function runSpawn(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else {
        const err = new Error(stderr.trim() || `exit ${code}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
    child.on("error", reject);
  });
}

/**
 * @param {{ runPrivileged?: (cmd: string, args: string[]) => Promise<unknown> }} [options]
 * @returns {Promise<{ skipped?: boolean, reason?: string, linger?: boolean, unitName?: string, unitEnabled?: boolean, errors?: string[] }>}
 */
export async function ensureLinuxGatewayPersistence(options = {}) {
  const errors = [];
  const emit = typeof options.emitLog === "function" ? options.emitLog : () => {};

  if (!isLinuxGatewayPersistenceEligible()) {
    const ctx = linuxGatewayPersistenceContext();
    const reason = ctx.wsl
      ? "WSL (skipped; different session model)"
      : !ctx.linux
        ? "not Linux"
        : "systemctl/loginctl missing";
    emit("info", `Gateway persistence: skipped (${reason}).`);
    return { skipped: true, reason };
  }

  if (!commandExists("openclaw")) {
    emit("warn", "Gateway persistence: openclaw not in PATH; skipped.");
    return { skipped: true, reason: "openclaw missing" };
  }

  const statusJson = readOpenclawGatewayStatusJson();
  const unitName = resolveGatewayUnitNameFromStatusJson(statusJson);

  const snap = getLinuxGatewayPersistenceSnapshot();
  let lingerOk = snap.linger === true;

  if (!lingerOk) {
    try {
      if (typeof options.runPrivileged === "function") {
        await options.runPrivileged("sudo", ["loginctl", "enable-linger", snap.username]);
      } else {
        await runSpawn("sudo", ["loginctl", "enable-linger", snap.username]);
      }
      const again = getLinuxGatewayPersistenceSnapshot(snap.username);
      lingerOk = again.linger === true;
      if (lingerOk) emit("info", `Enabled systemd user linger for ${snap.username} (gateway survives SSH disconnect).`);
      else errors.push("linger still not yes after loginctl enable-linger");
    } catch (err) {
      const msg = err?.stderr || err?.message || String(err);
      errors.push(`loginctl enable-linger: ${msg}`);
      emit(
        "warn",
        "Could not enable user linger automatically. Run: sudo loginctl enable-linger $USER",
      );
    }
  } else {
    emit("info", `systemd user linger already enabled for ${snap.username}.`);
  }

  let unitEnabled = false;
  try {
    await runSpawn("systemctl", ["--user", "daemon-reload"]);
    await runSpawn("systemctl", ["--user", "enable", "--now", unitName]);
    unitEnabled = true;
    emit("info", `systemd user unit enabled and started: ${unitName}`);
  } catch (err) {
    const msg = err?.stderr || err?.message || String(err);
    errors.push(`systemctl --user enable --now: ${msg}`);
    emit(
      "warn",
      `Could not enable/start user unit ${unitName} (${msg.trim()}). If the gateway was installed, try: systemctl --user enable --now ${unitName}`,
    );
  }

  let unitActive = false;
  try {
    await runSpawn("systemctl", ["--user", "is-active", unitName]);
    unitActive = true;
    emit("info", `${unitName} is active.`);
  } catch {
    // is-active exits non-zero when inactive; not a hard error
    emit("info", `${unitName} is not yet active (may need: openclaw gateway restart).`);
  }

  return {
    skipped: false,
    linger: lingerOk,
    unitName,
    unitEnabled,
    unitActive,
    errors: errors.length ? errors : undefined,
  };
}

/**
 * Write wallet key to a root-only file and add systemd user drop-in for openclaw-gateway.
 * @returns {{ envPath: string, dropinPath: string, wrote: boolean }}
 */
export function writeTraderclawGatewayWalletEnv(privateKeyBase58, home = homedir()) {
  const key = typeof privateKeyBase58 === "string" ? privateKeyBase58.trim() : "";
  if (!key) {
    throw new Error("writeTraderclawGatewayWalletEnv: empty private key");
  }

  const configDir = join(home, ".config", "openclaw");
  const envPath = join(configDir, WALLET_ENV_BASENAME);
  mkdirSync(configDir, { recursive: true });

  const line = `TRADERCLAW_WALLET_PRIVATE_KEY=${key}\n`;
  writeFileSync(envPath, line, { mode: 0o600 });
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // best effort
  }

  const dropinDir = join(home, ".config", "systemd", "user", "openclaw-gateway.service.d");
  mkdirSync(dropinDir, { recursive: true });
  const dropinPath = join(dropinDir, DROPIN_NAME);
  const dropinBody = `[Service]\nEnvironmentFile=${envPath}\n`;
  writeFileSync(dropinPath, dropinBody, "utf-8");

  try {
    execSync("systemctl --user daemon-reload", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // user may not have user systemd in this context
  }

  return { envPath, dropinPath, wrote: true };
}

/**
 * Printable instructions if automated wallet env is not used.
 */
export function formatGatewayWalletEnvInstructions(envPath = join(homedir(), ".config", "openclaw", WALLET_ENV_BASENAME)) {
  const dropinDir = join(homedir(), ".config", "systemd", "user", "openclaw-gateway.service.d");
  return [
    "To pass TRADERCLAW_WALLET_PRIVATE_KEY to the OpenClaw gateway (systemd user unit):",
    `1) Create ${envPath} with mode 600 containing one line: TRADERCLAW_WALLET_PRIVATE_KEY=<your_base58_key>`,
    `2) Create ${join(dropinDir, DROPIN_NAME)} with:`,
    "   [Service]",
    `   EnvironmentFile=${envPath}`,
    "3) Run: systemctl --user daemon-reload && openclaw gateway restart",
  ].join("\n");
}
