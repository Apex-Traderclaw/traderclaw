import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, existsSync, renameSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

export function resolveWorkspaceRoot(configOverride?: string): string {
  if (configOverride && configOverride.trim()) {
    return configOverride.trim().replace(/^~/, homedir());
  }
  const envDir = process.env.OPENCLAW_WORKSPACE_DIR;
  if (envDir && envDir.trim()) {
    return envDir.trim().replace(/^~/, homedir());
  }
  return join(homedir(), ".openclaw", "workspace");
}

export function resolveMemoryDir(workspaceRoot: string): string {
  return join(workspaceRoot, "memory");
}

export function resolveDailyLogDir(workspaceRoot: string): string {
  return join(workspaceRoot, "daily-logs");
}

export function resolveIntelligenceDir(workspaceRoot: string): string {
  return join(workspaceRoot, "intelligence");
}

export function readWorkspaceFile(workspaceRoot: string, filename: string): string | null {
  try {
    return readFileSync(join(workspaceRoot, filename), "utf-8");
  } catch {
    return null;
  }
}

export function writeWorkspaceFile(workspaceRoot: string, filename: string, content: string): void {
  const fullPath = join(workspaceRoot, filename);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

export function atomicWriteFile(filePath: string, content: string): void {
  const tmpPath = filePath + ".tmp." + Date.now();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmpPath, content, "utf-8");
  try {
    renameSync(tmpPath, filePath);
  } catch {
    try { unlinkSync(tmpPath); } catch {}
    writeFileSync(filePath, content, "utf-8");
  }
}

export function pruneDailyLogs(workspaceRoot: string, retentionDays: number): number {
  const logDir = resolveDailyLogDir(workspaceRoot);
  if (!existsSync(logDir)) return 0;

  const cutoff = Date.now() - retentionDays * 86400000;
  let pruned = 0;

  try {
    const files = readdirSync(logDir);
    for (const f of files) {
      const fullPath = join(logDir, f);
      try {
        const stat = statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(fullPath);
          pruned++;
        }
      } catch {}
    }
  } catch {}

  return pruned;
}

export interface StateDigest {
  walletSol: number | null;
  openPositions: number;
  topPositions: { symbol: string; pnlPct: number; holdingHours: number }[];
  killSwitchActive: boolean;
  portfolioValueSol: number | null;
  lastTradeAge: string;
}

export function generateStateMd(state: Record<string, unknown> | null): string {
  if (!state) return "## STATE\nNo state loaded yet. Call `solana_state` to bootstrap.\n";

  const lines: string[] = ["## STATE"];

  const wallet = state.wallet as Record<string, unknown> | undefined;
  if (wallet) {
    lines.push(`- **Wallet SOL**: ${wallet.balanceSol ?? "?"}`);
    lines.push(`- **Public Key**: ${wallet.publicKey ?? "?"}`);
  }

  interface PositionEntry { pnlPct?: number; tokenSymbol?: string; symbol?: string }
  const positions = state.positions as unknown[];
  if (Array.isArray(positions)) {
    lines.push(`- **Open Positions**: ${positions.length}`);
    const sorted = ([...positions] as PositionEntry[])
      .sort((a, b) => Math.abs(b.pnlPct || 0) - Math.abs(a.pnlPct || 0))
      .slice(0, 5);
    if (sorted.length > 0) {
      lines.push("- **Top Positions**:");
      for (const p of sorted) {
        const pnl = typeof p.pnlPct === "number" ? `${p.pnlPct > 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%` : "?";
        lines.push(`  - ${p.tokenSymbol || p.symbol || "?"}: ${pnl}`);
      }
    }
  }

  const ks = state.killSwitch ?? state.kill_switch;
  if (ks !== undefined) {
    lines.push(`- **Kill Switch**: ${ks ? "🔴 ACTIVE" : "✅ Off"}`);
  }

  return lines.join("\n") + "\n";
}

export function generateDecisionDigest(
  decisions: Record<string, unknown>[],
  maxCount = 10,
): string {
  if (!decisions || decisions.length === 0) {
    return "## RECENT DECISIONS\nNo recent decisions.\n";
  }

  const recent = decisions.slice(-maxCount);
  const lines: string[] = ["## RECENT DECISIONS"];

  for (const d of recent) {
    const action = d.action || d.type || "?";
    const token = d.tokenSymbol || d.symbol || d.tokenAddress || "?";
    const outcome = d.outcome || d.status || "pending";
    const ts = d.timestamp || d.ts || d.createdAt;
    const timeStr = ts ? new Date(ts as string | number).toISOString().slice(0, 16) : "?";
    lines.push(`- [${timeStr}] **${action}** ${token} → ${outcome}`);
  }

  return lines.join("\n") + "\n";
}

export function generateBulletinDigest(
  entries: Record<string, unknown>[],
  windowHours = 24,
): string {
  if (!entries || entries.length === 0) {
    return "## TEAM BULLETIN\nNo recent bulletin entries.\n";
  }

  const cutoff = Date.now() - windowHours * 3600000;
  const recent = entries.filter((e) => {
    const ts = e.ts || e.timestamp || e.createdAt;
    return ts && new Date(ts as string | number).getTime() > cutoff;
  });

  if (recent.length === 0) {
    return `## TEAM BULLETIN\nNo entries in the last ${windowHours}h.\n`;
  }

  const lines: string[] = ["## TEAM BULLETIN"];
  for (const e of recent.slice(-20)) {
    const from = e.from || e.author || "system";
    const msg = e.message || e.content || e.summary || "?";
    lines.push(`- **${from}**: ${msg}`);
  }

  return lines.join("\n") + "\n";
}

export function generateEntitlementsDigest(
  entitlements: Record<string, unknown> | null,
): string {
  if (!entitlements) {
    return "## ENTITLEMENTS\nNot loaded. Call `solana_entitlement_current` to check.\n";
  }

  const lines: string[] = ["## ENTITLEMENTS"];
  lines.push(`- **Tier**: ${entitlements.tier || "?"}`);
  lines.push(`- **Max Positions**: ${entitlements.maxPositions ?? "?"}`);
  lines.push(`- **Max Position SOL**: ${entitlements.maxPositionSol ?? "?"}`);

  const features = entitlements.features as string[] | undefined;
  if (Array.isArray(features) && features.length > 0) {
    lines.push(`- **Features**: ${features.join(", ")}`);
  }

  return lines.join("\n") + "\n";
}
