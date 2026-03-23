#!/usr/bin/env node
/**
 * npm `bin` entry for global `traderclaw`. Delegates to `openclaw-trader.mjs` with argv preserved.
 * Uses .cjs so npm does not strip the bin link when `package.json` has `"type": "module"`.
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const script = path.join(__dirname, "openclaw-trader.mjs");
const result = spawnSync(process.execPath, [script, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status === null ? 1 : result.status);
