/**
 * Copy repo-root bin/ into cli/bin/ for the traderclaw-cli package.
 * Runs on prepare when developing from the monorepo; skipped when installing from npm (bin/ already packed).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootBin = join(__dirname, "..", "..", "bin");
const destBin = join(__dirname, "..", "bin");

function copyRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dest, name);
    if (statSync(s).isDirectory()) copyRecursive(s, d);
    else cpSync(s, d);
  }
}

if (existsSync(rootBin)) {
  copyRecursive(rootBin, destBin);
  console.log("traderclaw-cli: synced bin/ from repo root");
} else if (!existsSync(join(destBin, "openclaw-trader.mjs"))) {
  throw new Error(
    "traderclaw-cli: bin scripts missing. Run `node scripts/sync-bin.mjs` from a full repo checkout before pack, or install from npm.",
  );
}
