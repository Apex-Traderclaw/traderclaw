import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";

const PLUGIN_ID = "solana-trader";

export function getOpenclawConfigPath(): string {
  return path.join(homedir(), ".openclaw", "openclaw.json");
}

/** Read latest consumable recovery secret from disk (hot reload; no gateway restart). */
export function readRecoverySecretFromDisk(): string | undefined {
  try {
    const p = getOpenclawConfigPath();
    if (!fs.existsSync(p)) return undefined;
    const raw = fs.readFileSync(p, "utf-8");
    const j = JSON.parse(raw) as {
      plugins?: { entries?: Record<string, { config?: { recoverySecret?: string } }> };
    };
    const s = j?.plugins?.entries?.[PLUGIN_ID]?.config?.recoverySecret;
    return typeof s === "string" && s.trim().length > 0 ? s.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Merge rotated recovery secret into the solana-trader plugin entry (atomic write). */
export function writeRecoverySecretToOpenclawAtomic(newSecret: string): void {
  const p = getOpenclawConfigPath();
  const dir = path.dirname(p);
  let config: Record<string, unknown> = {};
  if (fs.existsSync(p)) {
    try {
      config = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }
  if (!config.plugins || typeof config.plugins !== "object") config.plugins = {};
  const plugins = config.plugins as Record<string, unknown>;
  if (!plugins.entries || typeof plugins.entries !== "object") plugins.entries = {};
  const entries = plugins.entries as Record<string, unknown>;
  const prev = entries[PLUGIN_ID];
  const entry =
    prev && typeof prev === "object"
      ? { ...(prev as Record<string, unknown>) }
      : { enabled: true, config: {} };
  if (!entry.config || typeof entry.config !== "object") entry.config = {};
  const cfg = entry.config as Record<string, unknown>;
  cfg.recoverySecret = newSecret;
  entry.enabled = true;
  entries[PLUGIN_ID] = entry;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, p);
}
