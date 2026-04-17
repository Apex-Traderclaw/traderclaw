import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Dashboard webapp vite config.
// In dev, set OPENCLAW_API_URL to the OpenClaw API origin (default: http://localhost:5060).
// All /api/* and /ws requests are proxied to the OpenClaw API.
const OPENCLAW_API_URL = process.env["OPENCLAW_API_URL"] || "http://localhost:5060";

export default defineConfig({
  envDir: path.resolve(import.meta.dirname, ".."),
  envPrefix: ["VITE_", "OPENCLAW_"],
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env["DASHBOARD_PORT"] || 5173),
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    proxy: {
      "/api": {
        target: OPENCLAW_API_URL,
        changeOrigin: true,
      },
      "/ws": {
        target: OPENCLAW_API_URL.replace(/^http/, "ws"),
        ws: true,
        changeOrigin: true,
      },
      "/healthz": {
        target: OPENCLAW_API_URL,
        changeOrigin: true,
      },
    },
  },
});
