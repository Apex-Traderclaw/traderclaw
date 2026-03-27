// src/recovery-secret-config.ts
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
var PLUGIN_ID = "solana-trader";
function getOpenclawConfigPath() {
  return path.join(homedir(), ".openclaw", "openclaw.json");
}
function readRecoverySecretFromDisk() {
  try {
    const p = getOpenclawConfigPath();
    if (!fs.existsSync(p)) return void 0;
    const raw = fs.readFileSync(p, "utf-8");
    const j = JSON.parse(raw);
    const s = j?.plugins?.entries?.[PLUGIN_ID]?.config?.recoverySecret;
    return typeof s === "string" && s.trim().length > 0 ? s.trim() : void 0;
  } catch {
    return void 0;
  }
}
function writeRecoverySecretToOpenclawAtomic(newSecret) {
  const p = getOpenclawConfigPath();
  const dir = path.dirname(p);
  let config = {};
  if (fs.existsSync(p)) {
    try {
      config = JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      config = {};
    }
  }
  if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
  const plugins = config.plugins;
  if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
  const entries = plugins.entries;
  const prev = entries[PLUGIN_ID];
  const entry = prev && typeof prev === "object" ? { ...prev } : { enabled: true, config: {} };
  if (!entry.config || typeof entry.config !== "object") entry.config = {};
  const cfg = entry.config;
  cfg.recoverySecret = newSecret;
  entry.enabled = true;
  entries[PLUGIN_ID] = entry;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, p);
}

export {
  getOpenclawConfigPath,
  readRecoverySecretFromDisk,
  writeRecoverySecretToOpenclawAtomic
};
