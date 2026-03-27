// src/runtime-layout.ts
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync, existsSync, renameSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
function resolveWorkspaceRoot(configOverride) {
  if (configOverride && configOverride.trim()) {
    return configOverride.trim().replace(/^~/, homedir());
  }
  const envDir = process.env.OPENCLAW_WORKSPACE_DIR;
  if (envDir && envDir.trim()) {
    return envDir.trim().replace(/^~/, homedir());
  }
  return join(homedir(), ".openclaw", "workspace");
}
function resolveMemoryDir(workspaceRoot) {
  return join(workspaceRoot, "memory");
}
function resolveDailyLogDir(workspaceRoot) {
  return join(workspaceRoot, "daily-logs");
}
function resolveIntelligenceDir(workspaceRoot) {
  return join(workspaceRoot, "intelligence");
}
function readWorkspaceFile(workspaceRoot, filename) {
  try {
    return readFileSync(join(workspaceRoot, filename), "utf-8");
  } catch {
    return null;
  }
}
function writeWorkspaceFile(workspaceRoot, filename, content) {
  const fullPath = join(workspaceRoot, filename);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}
function atomicWriteFile(filePath, content) {
  const tmpPath = filePath + ".tmp." + Date.now();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmpPath, content, "utf-8");
  try {
    renameSync(tmpPath, filePath);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
    }
    writeFileSync(filePath, content, "utf-8");
  }
}
function pruneDailyLogs(workspaceRoot, retentionDays) {
  const logDir = resolveDailyLogDir(workspaceRoot);
  if (!existsSync(logDir)) return 0;
  const cutoff = Date.now() - retentionDays * 864e5;
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
      } catch {
      }
    }
  } catch {
  }
  return pruned;
}
function generateStateMd(state) {
  if (!state) return "## STATE\nNo state loaded yet. Call `solana_state` to bootstrap.\n";
  const lines = ["## STATE"];
  const wallet = state.wallet;
  if (wallet) {
    lines.push(`- **Wallet SOL**: ${wallet.balanceSol ?? "?"}`);
    lines.push(`- **Public Key**: ${wallet.publicKey ?? "?"}`);
  }
  const positions = state.positions;
  if (Array.isArray(positions)) {
    lines.push(`- **Open Positions**: ${positions.length}`);
    const sorted = [...positions].sort((a, b) => Math.abs(b.pnlPct || 0) - Math.abs(a.pnlPct || 0)).slice(0, 5);
    if (sorted.length > 0) {
      lines.push("- **Top Positions**:");
      for (const p of sorted) {
        const pnl = typeof p.pnlPct === "number" ? `${p.pnlPct > 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%` : "?";
        lines.push(`  - ${p.tokenSymbol || p.symbol || "?"}: ${pnl}`);
      }
    }
  }
  const ks = state.killSwitch ?? state.kill_switch;
  if (ks !== void 0) {
    lines.push(`- **Kill Switch**: ${ks ? "\u{1F534} ACTIVE" : "\u2705 Off"}`);
  }
  return lines.join("\n") + "\n";
}
function generateDecisionDigest(decisions, maxCount = 10) {
  if (!decisions || decisions.length === 0) {
    return "## RECENT DECISIONS\nNo recent decisions.\n";
  }
  const recent = decisions.slice(-maxCount);
  const lines = ["## RECENT DECISIONS"];
  for (const d of recent) {
    const action = d.action || d.type || "?";
    const token = d.tokenSymbol || d.symbol || d.tokenAddress || "?";
    const outcome = d.outcome || d.status || "pending";
    const ts = d.timestamp || d.ts || d.createdAt;
    const timeStr = ts ? new Date(ts).toISOString().slice(0, 16) : "?";
    lines.push(`- [${timeStr}] **${action}** ${token} \u2192 ${outcome}`);
  }
  return lines.join("\n") + "\n";
}
function generateBulletinDigest(entries, windowHours = 24) {
  if (!entries || entries.length === 0) {
    return "## TEAM BULLETIN\nNo recent bulletin entries.\n";
  }
  const cutoff = Date.now() - windowHours * 36e5;
  const recent = entries.filter((e) => {
    const ts = e.ts || e.timestamp || e.createdAt;
    return ts && new Date(ts).getTime() > cutoff;
  });
  if (recent.length === 0) {
    return `## TEAM BULLETIN
No entries in the last ${windowHours}h.
`;
  }
  const lines = ["## TEAM BULLETIN"];
  for (const e of recent.slice(-20)) {
    const from = e.from || e.author || "system";
    const msg = e.message || e.content || e.summary || "?";
    lines.push(`- **${from}**: ${msg}`);
  }
  return lines.join("\n") + "\n";
}
function generateEntitlementsDigest(entitlements) {
  if (!entitlements) {
    return "## ENTITLEMENTS\nNot loaded. Call `solana_entitlement_current` to check.\n";
  }
  const lines = ["## ENTITLEMENTS"];
  lines.push(`- **Tier**: ${entitlements.tier || "?"}`);
  lines.push(`- **Max Positions**: ${entitlements.maxPositions ?? "?"}`);
  lines.push(`- **Max Position SOL**: ${entitlements.maxPositionSol ?? "?"}`);
  const features = entitlements.features;
  if (Array.isArray(features) && features.length > 0) {
    lines.push(`- **Features**: ${features.join(", ")}`);
  }
  return lines.join("\n") + "\n";
}

export {
  resolveWorkspaceRoot,
  resolveMemoryDir,
  resolveDailyLogDir,
  resolveIntelligenceDir,
  readWorkspaceFile,
  writeWorkspaceFile,
  atomicWriteFile,
  pruneDailyLogs,
  generateStateMd,
  generateDecisionDigest,
  generateBulletinDigest,
  generateEntitlementsDigest
};
