/**
 * Resolve the solana-traderclaw package root (directory containing openclaw.plugin.json).
 *
 * - When bin/ lives inside the plugin package (git clone), parent of bin/ is the root.
 * - When bin/ ships in a separate CLI package (traderclaw-cli), resolve via node_modules.
 */
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

export function resolvePluginPackageRoot(fromImportMetaUrl) {
  const binDir = dirname(fileURLToPath(fromImportMetaUrl));
  const parent = join(binDir, "..");
  if (existsSync(join(parent, "openclaw.plugin.json"))) {
    return parent;
  }
  try {
    // `package.json` "exports" often omits `./package.json` — resolve the main entry instead.
    const entry = require.resolve("solana-traderclaw");
    let dir = dirname(entry);
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, "openclaw.plugin.json"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  throw new Error(
    "Could not find the solana-traderclaw package. Install the CLI with its dependency " +
      "(npm install -g traderclaw-cli) or install solana-traderclaw next to this tool.",
  );
}
