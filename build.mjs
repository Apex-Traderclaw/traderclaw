import { build } from "esbuild";
import { readdirSync } from "fs";

const srcFiles = readdirSync("./src")
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => `./src/${f}`);

await build({
  entryPoints: ["./index.ts", ...srcFiles],
  outdir: "./dist",
  format: "esm",
  platform: "node",
  target: "node22",
  bundle: true,
  splitting: true,
  external: ["openclaw/plugin-sdk", "@sinclair/typebox", "ws"],
});

console.log("Build complete → dist/");
