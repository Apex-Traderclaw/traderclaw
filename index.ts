import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { orchestratorRequest } from "./src/http-client.js";
import { SessionManager } from "./src/session-manager.js";
import { AlphaBuffer } from "./src/alpha-buffer.js";
import { AlphaStreamManager } from "./src/alpha-ws.js";
import { parseXConfig, registerXTools } from "./lib/x-tools.mjs";
import { registerWebFetchTool } from "./lib/web-fetch.mjs";
import * as fs from "fs";
import { homedir } from "os";
import * as path from "path";

interface XConfig {
  ok: boolean;
  consumerKey: string;
  consumerSecret: string;
  profiles: Record<string, { accessToken: string; accessTokenSecret: string; userId?: string; username?: string }>;
}

interface PluginConfig {
  orchestratorUrl: string;
  walletId: string;
  apiKey: string;
  externalUserId?: string;
  refreshToken?: string;
  walletPublicKey?: string;
  apiTimeout?: number;
  agentId?: string;
  gatewayBaseUrl?: string;
  gatewayToken?: string;
  dataDir?: string;
  xConfig?: XConfig;
}

function parseConfig(raw: unknown): PluginConfig {
  const obj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const orchestratorUrl = typeof obj.orchestratorUrl === "string" ? obj.orchestratorUrl : "";
  const walletId = typeof obj.walletId === "string" ? obj.walletId : typeof obj.walletId === "number" ? String(obj.walletId) : "";
  const apiKey = typeof obj.apiKey === "string" ? obj.apiKey : "";
  const externalUserId = typeof obj.externalUserId === "string" ? obj.externalUserId : undefined;
  const refreshToken = typeof obj.refreshToken === "string" ? obj.refreshToken : undefined;
  const walletPublicKey = typeof obj.walletPublicKey === "string" ? obj.walletPublicKey : undefined;
  const apiTimeout = typeof obj.apiTimeout === "number" ? obj.apiTimeout : 120000;
  const agentId = typeof obj.agentId === "string" ? obj.agentId : undefined;
  const gatewayBaseUrl = typeof obj.gatewayBaseUrl === "string" ? obj.gatewayBaseUrl : undefined;
  const gatewayToken = typeof obj.gatewayToken === "string" ? obj.gatewayToken : undefined;
  const dataDir = typeof obj.dataDir === "string" ? obj.dataDir : undefined;
  const xConfig = parseXConfig(obj) as XConfig;
  return {
    orchestratorUrl,
    walletId,
    apiKey,
    externalUserId,
    refreshToken,
    walletPublicKey,
    apiTimeout,
    agentId,
    gatewayBaseUrl,
    gatewayToken,
    dataDir,
    xConfig,
  };
}

/** Post-startup welcome for the user; API key comes from plugin config when present. */
function buildTraderClawWelcomeMessage(apiKeyForDisplay: string | null): string {
  const keyBlock = apiKeyForDisplay
    ? `Your TraderClaw API Key:\n\n${apiKeyForDisplay}\n\nUse this to connect your dashboard.`
    : `Your API key is not stored in plaintext in this OpenClaw config (session-only or refresh-token flow). On the machine where you ran setup, run \`traderclaw config show\` to view it, or use the TraderClaw dashboard account settings.`;

  return `🚀 TraderClaw is live.

Connection established. The desk is up.

I'm now watching the Solana memecoin market, tracking launches, ingesting alpha signals, and analyzing liquidity, wallets, and sentiment in real time.

Nothing moves without context.
Nothing executes without passing risk.


🧠 How I operate

I don't chase noise.

Scan → analyze → score → validate → execute.
Every trade is structured. Every decision is logged.

And I evolve.

Every outcome feeds back into the system.
Patterns improve. Filters sharpen. Decisions get better over time.


🔑 Access

${keyBlock}


⚙️ Get started

1) Fund your wallet
Send SOL to your trading wallet
Ask: what is my wallet address?

2) Choose operating mode
HARDENED → defensive, selective
DEGEN → aggressive, faster

3) Give me a name (optional)
Example: Your name is Atlas


🤝 How we work together

I operate autonomously, scanning, filtering, and acting when conditions make sense.

You can guide or question decisions anytime.
I will not execute trades that do not meet criteria.

Think of this as a trading desk you work with, not a bot you micromanage.


⚡ Command Examples (not limited)

• scan for alpha → start hunting
• status → full system check
• pause trading → halt execution


Start simple. Fund → set mode → observe.

Let's see what the market gives us.`;
}

const solanaTraderPlugin = {
  id: "solana-trader",
  name: "Solana Trader",
  description: "Autonomous Solana memecoin trading agent — orchestrator integration",

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig);
    const { orchestratorUrl, walletId, apiKey, apiTimeout } = config;

    if (!orchestratorUrl) {
      api.logger.error("[solana-trader] orchestratorUrl is required in plugin config. Run: traderclaw setup");
      return;
    }

    if (!apiKey && !config.refreshToken) {
      api.logger.error(
        "[solana-trader] apiKey or refreshToken is required. Tell the user to run on their machine: traderclaw setup --signup (or traderclaw signup) for a new account, or traderclaw setup / traderclaw login if they already have an API key. The agent cannot sign up or edit credentials.",
      );
      return;
    }

    const dataDir = config.dataDir || path.join(process.cwd(), ".traderclaw-v1-data");
    const sessionTokensPath = path.join(dataDir, "session-tokens.json");

    interface SessionSidecar {
      refreshToken?: string;
      accessToken?: string;
      accessTokenExpiresAt?: number;
      walletPublicKey?: string;
    }

    const readSessionSidecar = (): SessionSidecar | null => {
      try {
        if (!fs.existsSync(sessionTokensPath)) return null;
        const raw = JSON.parse(fs.readFileSync(sessionTokensPath, "utf-8"));
        if (!raw || typeof raw !== "object") return null;
        return raw as SessionSidecar;
      } catch {
        return null;
      }
    };

    const writeSessionSidecarAtomic = (payload: SessionSidecar) => {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${sessionTokensPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf-8");
      fs.renameSync(tmp, sessionTokensPath);
    };

    const sidecar = readSessionSidecar();
    const effectiveRefreshToken =
      typeof sidecar?.refreshToken === "string" && sidecar.refreshToken.length > 0
        ? sidecar.refreshToken
        : config.refreshToken;
    const effectiveWalletPublicKey =
      typeof sidecar?.walletPublicKey === "string" && sidecar.walletPublicKey.length > 0
        ? sidecar.walletPublicKey
        : config.walletPublicKey;

    let initialAccessToken: string | undefined;
    let initialAccessTokenExpiresAt: number | undefined;
    if (
      typeof sidecar?.accessToken === "string" &&
      sidecar.accessToken.length > 0 &&
      typeof sidecar.accessTokenExpiresAt === "number" &&
      Date.now() < sidecar.accessTokenExpiresAt - 5000
    ) {
      initialAccessToken = sidecar.accessToken;
      initialAccessTokenExpiresAt = sidecar.accessTokenExpiresAt;
    }

    api.logger.info(
      `[solana-trader] Session: sidecar=${sidecar ? "yes" : "no"}, refreshToken=${effectiveRefreshToken ? "present (" + effectiveRefreshToken.slice(0, 8) + "...)" : "MISSING"}, ` +
        `apiKey=${apiKey ? "present" : "MISSING"}, walletPublicKey=${effectiveWalletPublicKey ? "present" : "MISSING"}`,
    );

    const sessionManager = new SessionManager({
      baseUrl: orchestratorUrl,
      apiKey: apiKey || "",
      refreshToken: effectiveRefreshToken,
      walletPublicKey: effectiveWalletPublicKey,
      walletPrivateKeyProvider: () => {
        const runtimeKey = process.env.TRADERCLAW_WALLET_PRIVATE_KEY || "";
        return runtimeKey.trim() || undefined;
      },
      clientLabel: "openclaw-plugin-runtime",
      timeout: apiTimeout,
      initialAccessToken,
      initialAccessTokenExpiresAt,
      onTokensRotated: (tokens) => {
        try {
          writeSessionSidecarAtomic({
            refreshToken: tokens.refreshToken,
            accessToken: tokens.accessToken,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            walletPublicKey: tokens.walletPublicKey,
          });
          api.logger.info(`[solana-trader] Persisted session tokens to ${sessionTokensPath}`);
        } catch (err: unknown) {
          api.logger.warn(
            `[solana-trader] Failed to persist session sidecar: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      logger: {
        info: (msg) => api.logger.info(`[solana-trader] ${msg}`),
        warn: (msg) => api.logger.warn(`[solana-trader] ${msg}`),
        error: (msg) => api.logger.error(`[solana-trader] ${msg}`),
      },
    });

    const onUnauthorized = async (): Promise<string> => {
      api.logger.warn("[solana-trader] Received 401 — refreshing session...");
      return sessionManager.handleUnauthorized();
    };

    const post = async (path: string, body: Record<string, unknown>, extraHeaders?: Record<string, string>) => {
      const token = await sessionManager.getAccessToken();
      return orchestratorRequest({
        baseUrl: orchestratorUrl,
        method: "POST",
        path,
        body: { walletId, ...body },
        timeout: apiTimeout,
        accessToken: token,
        extraHeaders,
        onUnauthorized,
      });
    };

    const get = async (path: string) => {
      const token = await sessionManager.getAccessToken();
      return orchestratorRequest({
        baseUrl: orchestratorUrl,
        method: "GET",
        path,
        timeout: apiTimeout,
        accessToken: token,
        onUnauthorized,
      });
    };

    const put = async (path: string, body: Record<string, unknown>) => {
      const token = await sessionManager.getAccessToken();
      return orchestratorRequest({
        baseUrl: orchestratorUrl,
        method: "PUT",
        path,
        body,
        timeout: apiTimeout,
        accessToken: token,
        onUnauthorized,
      });
    };

    const del = async (path: string) => {
      const token = await sessionManager.getAccessToken();
      return orchestratorRequest({
        baseUrl: orchestratorUrl,
        method: "DELETE",
        path,
        timeout: apiTimeout,
        accessToken: token,
        onUnauthorized,
      });
    };

    const json = (data: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    });

    const wrapExecute = (fn: (_id: string, params: Record<string, unknown>) => Promise<unknown>) =>
      async (toolCallId: string, params: Record<string, unknown>) => {
        try {
          const result = await fn(toolCallId, params ?? {});
          return json(result);
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      };

    const stateDir = path.join(dataDir, "state");
    const logsDir = path.join(dataDir, "logs");
    const sharedLogsDir = path.join(logsDir, "shared");
    /** OpenClaw default agent workspace — avoids process.cwd() under systemd (often `/`). */
    const workspaceRoot = path.join(homedir(), ".openclaw", "workspace");
    const stateMdPath = path.join(workspaceRoot, "STATE.md");
    const memoryDir = path.join(workspaceRoot, "memory");

    const ensureDir = (dirPath: string) => {
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    };
    ensureDir(stateDir);
    ensureDir(sharedLogsDir);
    ensureDir(workspaceRoot);

    const readJsonFile = (filePath: string): unknown => {
      try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch { return null; }
    };

    const deepMerge = (target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> => {
      const result = { ...target };
      for (const key of Object.keys(source)) {
        const sv = source[key];
        const tv = result[key];
        if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
          result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
        } else {
          result[key] = sv;
        }
      }
      return result;
    };

    const writeJsonFile = (filePath: string, data: unknown) => {
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    };

    const readJsonlFile = (filePath: string, maxEntries?: number): unknown[] => {
      try {
        if (!fs.existsSync(filePath)) return [];
        const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
        const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        return maxEntries ? entries.slice(-maxEntries) : entries;
      } catch { return []; }
    };

    const appendJsonlFile = (filePath: string, entry: unknown, maxEntries: number) => {
      ensureDir(path.dirname(filePath));
      let entries = readJsonlFile(filePath);
      entries.push(entry);
      if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
      fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
      return entries.length;
    };

    const generateStateMd = (aid: string, stateObj: unknown): string => {
      const lines: string[] = [
        `# ${aid} — Persisted state (STATE.md)`,
        ``,
        `> Auto-generated by solana_state_save. OpenClaw loads workspace files (including STATE.md) into context.`,
        `> Last updated: ${new Date().toISOString()}`,
        ``,
      ];
      if (!stateObj || typeof stateObj !== "object") {
        lines.push("_No state saved yet._");
        return lines.join("\n");
      }
      const state = stateObj as Record<string, unknown>;
      const identity: string[] = [];
      if (state.tier) identity.push(`- **Tier:** ${state.tier}`);
      if (state.walletId) identity.push(`- **Wallet:** ${state.walletId}`);
      if (state.mode) identity.push(`- **Mode:** ${state.mode}`);
      if (state.strategyVersion) identity.push(`- **Strategy Version:** ${state.strategyVersion}`);
      if (state.regime) identity.push(`- **Regime:** ${state.regime}`);
      if (state.maxPositions) identity.push(`- **Max Positions:** ${state.maxPositions}`);
      if (state.maxPositionSizeSol) identity.push(`- **Max Position Size:** ${state.maxPositionSizeSol} SOL`);
      if (identity.length > 0) {
        lines.push("## Identity & Config", "", ...identity, "");
      }
      if (state.defenseMode !== undefined) lines.push(`## Defense Mode\n\n- **Active:** ${state.defenseMode}\n`);
      if (state.killSwitchActive !== undefined) lines.push(`## Kill Switch\n\n- **Active:** ${state.killSwitchActive}\n`);
      if (state.watchlist && Array.isArray(state.watchlist) && state.watchlist.length > 0) {
        lines.push("## Watchlist", "");
        for (const item of state.watchlist.slice(0, 20)) {
          lines.push(`- ${typeof item === "string" ? item : JSON.stringify(item)}`);
        }
        lines.push("");
      }
      if (state.permanentLearnings && Array.isArray(state.permanentLearnings)) {
        lines.push("## Permanent Learnings", "");
        for (const learning of state.permanentLearnings.slice(0, 30)) {
          lines.push(`- ${typeof learning === "string" ? learning : JSON.stringify(learning)}`);
        }
        lines.push("");
      }
      if (state.regimeCanary && typeof state.regimeCanary === "object") {
        const rc = state.regimeCanary as Record<string, unknown>;
        lines.push("## Regime Canary", "", `- **Regime:** ${rc.regime || "unknown"}`, `- **Detected At:** ${rc.detectedAt || "unknown"}`, "");
      }
      const excludeKeys = new Set(["tier", "walletId", "mode", "strategyVersion", "regime", "maxPositions", "maxPositionSizeSol", "defenseMode", "killSwitchActive", "watchlist", "permanentLearnings", "regimeCanary"]);
      const otherKeys = Object.keys(state).filter((k) => !excludeKeys.has(k));
      if (otherKeys.length > 0) {
        lines.push("## Other State Keys", "");
        for (const key of otherKeys.slice(0, 30)) {
          const val = state[key];
          const display = typeof val === "object" ? JSON.stringify(val) : String(val);
          lines.push(`- **${key}:** ${display.length > 200 ? display.slice(0, 200) + "…" : display}`);
        }
        lines.push("");
      }
      return lines.join("\n");
    };

    const writeStateMd = (aid: string, stateObj: unknown) => {
      try {
        ensureDir(workspaceRoot);
        const content = generateStateMd(aid, stateObj);
        fs.writeFileSync(stateMdPath, content, "utf-8");
      } catch {}
    };

    const getDailyLogPath = (date?: Date): string => {
      const d = date || new Date();
      const dateStr = d.toISOString().slice(0, 10);
      return path.join(memoryDir, `${dateStr}.md`);
    };

    const pruneDailyLogs = (retentionDays: number = 7) => {
      try {
        if (!fs.existsSync(memoryDir)) return;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        const files = fs.readdirSync(memoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
        for (const file of files) {
          const dateStr = file.replace(".md", "");
          if (new Date(dateStr) < cutoff) {
            try { fs.unlinkSync(path.join(memoryDir, file)); } catch {}
          }
        }
      } catch {}
    };

    const agentId = config.agentId || "main";

    const sanitizeAgentId = (id: string): string => {
      const clean = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
      if (!clean) return agentId;
      return clean;
    };

    // =========================================================================
    // SCANNING TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_scan_launches",
      description: "Scan for new Solana token launches (Pump.fun, Raydium, PumpSwap). Returns recent launches with initial metrics. Watch for deployer patterns — same deployer launching multiple tokens is a serial rugger red flag.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => post("/api/scan/new-launches", {})),
    });

    api.registerTool({
      name: "solana_scan_hot_pairs",
      description: "Find Solana trading pairs with high volume and price acceleration. Returns hot pairs ranked by activity.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => post("/api/scan/hot-pairs", {})),
    });

    api.registerTool({
      name: "solana_market_regime",
      description: "Get the current Solana market regime (bullish/bearish/neutral) with aggregate metrics like total DEX volume and trending sectors.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => post("/api/market/regime", {})),
    });

    // =========================================================================
    // TOKEN ANALYSIS TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_token_snapshot",
      description: "Get a price/volume snapshot for a Solana token including current price, 24h OHLC, volume, and trade count.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/token/snapshot", { tokenAddress: params.tokenAddress }),
      ),
    });

    api.registerTool({
      name: "solana_token_holders",
      description: "Get holder distribution for a Solana token — top 10 concentration, dev holdings percentage, total holder count.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/token/holders", { tokenAddress: params.tokenAddress }),
      ),
    });

    api.registerTool({
      name: "solana_token_flows",
      description: "Get buy/sell flow data for a Solana token — pressure ratio, net flow, unique trader count.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/token/flows", { tokenAddress: params.tokenAddress }),
      ),
    });

    api.registerTool({
      name: "solana_token_liquidity",
      description: "Get liquidity profile for a Solana token — pool depth in USD, locked liquidity percentage, DEX breakdown.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/token/liquidity", { tokenAddress: params.tokenAddress }),
      ),
    });

    api.registerTool({
      name: "solana_token_risk",
      description: "Get composite risk assessment for a Solana token — checks mint authority, freeze authority, LP lock/burn status, deployer history, concentration, dev holdings, and honeypot indicators. Hard-skip tokens with active mint or freeze authority.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/token/risk", { tokenAddress: params.tokenAddress }),
      ),
    });

    // =========================================================================
    // INTELLIGENCE TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_build_thesis",
      description: "Build a complete thesis package for a token — assembles market data, your strategy weights, your prior trades on this token, journal stats, wallet context, and an advisory risk pre-screen. This is your full intelligence briefing before making a trade decision.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
        maxSizeSol: Type.Optional(Type.Number({ description: "Advisory — max position size in SOL for risk pre-screen. Not in server schema; accepted but currently ignored." })),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/thesis/build", {
          tokenAddress: params.tokenAddress,
          maxSizeSol: params.maxSizeSol,
        }),
      ),
    });

    // =========================================================================
    // TRADING TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_trade_precheck",
      description:
        "Pre-trade risk check — validates a proposed trade against risk rules, kill switch, entitlement limits, and on-chain conditions. Returns approved/denied with reasons and capped size. Always call this before executing a trade. " +
        "Buy: sizeSol required; do not send sizeTokens or sellPct. Sell: send exactly one of sizeTokens or sellPct (not sizeSol). If both sellPct and sizeTokens are sent, sellPct is preferred and sizeTokens is ignored. " +
        "Optional exit fields (trailingStopPct, trailingStop) are accepted to mirror execute payloads; sizing logic ignores them.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
        side: Type.Union([Type.Literal("buy"), Type.Literal("sell")], { description: "Trade direction" }),
        sizeSol: Type.Optional(Type.Number({ description: "Position size in SOL — required for buy, omit for sell" })),
        sellPct: Type.Optional(Type.Number({ description: "Sell percentage 1–100 (100 = full exit) — sell only; preferred over sizeTokens if both sent" })),
        sizeTokens: Type.Optional(Type.Number({ description: "Token amount to sell — sell only; ignored if sellPct is also provided" })),
        slippageBps: Type.Optional(Type.Number({ description: "Slippage tolerance in basis points (e.g., 300 = 3%)" })),
        trailingStopPct: Type.Optional(Type.Number({ description: "Optional — same as execute; ignored for policy sizing" })),
        trailingStop: Type.Optional(
          Type.Object({
            levels: Type.Array(
              Type.Object({
                percentage: Type.Number({ description: "Trailing drawdown % from the armed high once the level is active" }),
                amount: Type.Optional(Type.Number({ description: "% of position to sell at this level (1–100). Server default 100." })),
                triggerAboveATH: Type.Optional(
                  Type.Number({
                    description:
                      "Optional. % above session ATH before this level arms. If omitted, API defaults to 100 (2× ATH).",
                  }),
                ),
              }),
              { minItems: 1, maxItems: 5, description: "Multi-level trailing (optional on precheck)" },
            ),
          }),
        ),
      }),
      execute: wrapExecute(async (_id, params) => {
        const body: Record<string, unknown> = {
          tokenAddress: params.tokenAddress,
          side: params.side,
          slippageBps: params.slippageBps,
        };
        if (params.trailingStopPct !== undefined) {
          body.trailingStopPct = params.trailingStopPct;
        }
        const ts = params.trailingStop as { levels?: unknown[] } | undefined;
        if (ts?.levels && Array.isArray(ts.levels) && ts.levels.length > 0) {
          body.trailingStop = ts;
        }
        if (params.side === "buy") {
          body.sizeSol = params.sizeSol;
        } else {
          if (params.sellPct !== undefined) {
            body.sellPct = params.sellPct;
          } else if (params.sizeTokens !== undefined) {
            body.sizeTokens = params.sizeTokens;
          }
        }
        return post("/api/trade/precheck", body);
      }),
    });

    api.registerTool({
      name: "solana_trade_execute",
      description:
        "Execute a trade on Solana via the SpyFly bot. Enforces risk rules before proxying to on-chain execution. Returns trade ID, position ID, and transaction signature. " +
        "IMPORTANT: tpLevels alone (e.g. [10, 15]) means EACH level sells 100% of the position at that gain — use tpExits for partials (e.g. +10% sell 50%, +15% sell 100%). " +
        "Trailing: use `trailingStopPct` for a single simple trailing %, or `trailingStop.levels` (1–5) for multi-level trailing with optional `triggerAboveATH` per level (% above session ATH before that level arms; if omitted, server defaults to 100 i.e. 2× ATH). When both are sent, `trailingStop` wins. " +
        "Buy: sizeSol required; do not send sizeTokens or sellPct. Sell: send exactly one of sizeTokens or sellPct (not sizeSol). If both sellPct and sizeTokens are sent, sellPct is preferred and sizeTokens is ignored.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
        side: Type.Union([Type.Literal("buy"), Type.Literal("sell")], { description: "Trade direction" }),
        sizeSol: Type.Optional(Type.Number({ description: "Position size in SOL — required for buy, omit for sell" })),
        sellPct: Type.Optional(Type.Number({ description: "Sell percentage 1–100 (100 = full exit) — sell only; preferred over sizeTokens if both sent" })),
        sizeTokens: Type.Optional(Type.Number({ description: "Token amount to sell — sell only; ignored if sellPct is also provided" })),
        symbol: Type.String({ description: "Token symbol (e.g., BONK, WIF)" }),
        slippageBps: Type.Optional(Type.Number({ description: "Slippage in basis points (default: 300)" })),
        slPct: Type.Optional(Type.Number({ description: "Stop-loss percentage (e.g., 15 = 15% below entry)" })),
        tpLevels: Type.Optional(
          Type.Array(Type.Number(), {
            description:
              "TP gain % from entry only — each level defaults to selling 100% of position. Prefer tpExits when you want partial sells.",
          }),
        ),
        tpExits: Type.Optional(
          Type.Array(
            Type.Object({
              percent: Type.Number({ description: "Take-profit trigger: % gain from entry (e.g. 10 = +10%)" }),
              amountPct: Type.Number({
                description: "% of position to sell at this TP (1–100). Example: [{percent:10,amountPct:50},{percent:15,amountPct:100}]",
              }),
            }),
            { description: "Per-level take-profit sizes. Sent to API as tpExits; overrides plain tpLevels for sizing." },
          ),
        ),
        slExits: Type.Optional(
          Type.Array(
            Type.Object({
              percent: Type.Number({ description: "Stop-loss trigger: % drawdown from entry" }),
              amountPct: Type.Number({ description: "% of position to close at this SL level (1–100)" }),
            }),
            { description: "Multi-level stop-loss with partial exits (optional). Otherwise use slPct for a single full exit." },
          ),
        ),
        trailingStopPct: Type.Optional(
          Type.Number({
            description: "Single trailing-stop % (legacy). Ignored if `trailingStop` is provided.",
          }),
        ),
        trailingStop: Type.Optional(
          Type.Object({
            levels: Type.Array(
              Type.Object({
                percentage: Type.Number({
                  description:
                    "Once armed, sell when price drops this % from the high (trailing drawdown).",
                }),
                amount: Type.Optional(
                  Type.Number({
                    description: "% of position to sell when this level fires (1–100). Server default 100.",
                  }),
                ),
                triggerAboveATH: Type.Optional(
                  Type.Number({
                    description:
                      "Optional. Session price must reach this % above session ATH before this level arms (e.g. 50 → 1.5× ATH). If omitted, API defaults to 100 (2× ATH).",
                  }),
                ),
              }),
              {
                minItems: 1,
                maxItems: 5,
                description: "Ordered trailing-stop levels (up to 5).",
              },
            ),
          }),
        ),
        managementMode: Type.Optional(
          Type.Union([Type.Literal("LOCAL_MANAGED"), Type.Literal("SERVER_MANAGED")], {
            description: "Advisory only — server decides position mode internally. Sent for future compatibility.",
          }),
        ),
        idempotencyKey: Type.Optional(Type.String({ description: "Unique key to prevent duplicate executions (e.g., UUID). Server uses walletId + key for replay cache." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const headers: Record<string, string> = {};
        if (params.idempotencyKey) {
          headers["x-idempotency-key"] = String(params.idempotencyKey);
        }
        const body: Record<string, unknown> = {
          tokenAddress: params.tokenAddress,
          side: params.side,
          symbol: params.symbol,
          slippageBps: params.slippageBps,
          slPct: params.slPct,
          managementMode: params.managementMode,
        };
        const tsExecute = params.trailingStop as { levels?: unknown[] } | undefined;
        if (tsExecute?.levels && Array.isArray(tsExecute.levels) && tsExecute.levels.length > 0) {
          body.trailingStop = tsExecute;
        } else if (params.trailingStopPct !== undefined) {
          body.trailingStopPct = params.trailingStopPct;
        }
        if (params.side === "buy") {
          body.sizeSol = params.sizeSol;
        } else {
          if (params.sellPct !== undefined) {
            body.sellPct = params.sellPct;
          } else if (params.sizeTokens !== undefined) {
            body.sizeTokens = params.sizeTokens;
          }
        }
        const tpExits = params.tpExits as Array<{ percent: number; amountPct: number }> | undefined;
        const slExits = params.slExits as Array<{ percent: number; amountPct: number }> | undefined;
        if (Array.isArray(tpExits) && tpExits.length > 0) {
          body.tpExits = tpExits;
        }
        if (Array.isArray(params.tpLevels) && params.tpLevels.length > 0) {
          body.tpLevels = params.tpLevels;
        }
        if (Array.isArray(slExits) && slExits.length > 0) {
          body.slExits = slExits;
        }
        return post("/api/trade/execute", body, Object.keys(headers).length > 0 ? headers : undefined);
      }),
    });

    // =========================================================================
    // REFLECTION TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_trade_review",
      description: "Submit a post-trade review with outcome and notes. Creates a memory entry linked to the trade for future learning. Be honest — your future strategy evolution depends on accurate reviews.",
      parameters: Type.Object({
        tradeId: Type.Optional(Type.String({ description: "Trade ID (UUID) to review" })),
        tokenAddress: Type.Optional(Type.String({ description: "Token mint address for the reviewed trade" })),
        outcome: Type.Union([Type.Literal("win"), Type.Literal("loss"), Type.Literal("neutral")], {
          description: "Trade outcome",
        }),
        notes: Type.String({ description: "Detailed analysis: what worked, what didn't, key signals, lessons learned" }),
        pnlSol: Type.Optional(Type.Number({ description: "Actual profit/loss in SOL" })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization (e.g., ['momentum_win', 'late_entry'])" })),
        strategyVersion: Type.Optional(Type.String({ description: "Strategy version at time of trade (e.g., 'v1.3.0')" })),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/trade/review", {
          tradeId: params.tradeId,
          tokenAddress: params.tokenAddress,
          outcome: params.outcome,
          notes: params.notes,
          pnlSol: params.pnlSol,
          tags: params.tags,
          strategyVersion: params.strategyVersion,
        }),
      ),
    });

    api.registerTool({
      name: "solana_memory_write",
      description: "Write a memory entry — journal observations, market insights, or trading lessons. These memories are searchable and appear in future thesis packages.",
      parameters: Type.Object({
        notes: Type.String({ description: "Observation or lesson to remember" }),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization (e.g., ['momentum', 'risk', 'regime'])" })),
        tokenAddress: Type.Optional(Type.String({ description: "Associate with a specific token" })),
        outcome: Type.Optional(Type.Union([Type.Literal("win"), Type.Literal("loss"), Type.Literal("neutral")], {
          description: "Outcome if trade-related",
        })),
        strategyVersion: Type.Optional(Type.String({ description: "Strategy version at time of writing (e.g., 'v1.3.0')" })),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/memory/write", {
          notes: params.notes,
          tags: params.tags,
          tokenAddress: params.tokenAddress,
          outcome: params.outcome,
          strategyVersion: params.strategyVersion,
        }),
      ),
    });

    api.registerTool({
      name: "solana_memory_search",
      description: "Search your trading memory by text query. Returns matching journal entries, trade reviews, and observations.",
      parameters: Type.Object({
        query: Type.String({ description: "Search text (e.g., 'high concentration tokens' or 'momentum plays')" }),
        limit: Type.Optional(Type.Number({ description: "Advisory — max results to return. Not honored by server; storage applies internal cap (~50)." })),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/memory/search", {
          query: params.query,
          limit: params.limit,
        }),
      ),
    });

    api.registerTool({
      name: "solana_memory_by_token",
      description: "Get all your prior memory entries for a specific token — past trades, reviews, and observations. MANDATORY: always call this before re-entering any token you've previously traded. Required by risk rules.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/memory/by-token", {
          tokenAddress: params.tokenAddress,
        }),
      ),
    });

    api.registerTool({
      name: "solana_journal_summary",
      description: "Get a summary of your trading journal — win rate, total entries, recent notes, and performance over a time period.",
      parameters: Type.Object({
        days: Type.Optional(Type.Number({ description: "Look back period in days (default: 7)" })),
      }),
      execute: wrapExecute(async (_id, params) => {
        let path = `/api/memory/journal-summary?walletId=${walletId}`;
        if (params.days) path += `&lookbackDays=${params.days}`;
        return get(path);
      }),
    });

    // =========================================================================
    // STRATEGY TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_strategy_state",
      description: "Read your current strategy state — feature weights and strategy version. These are YOUR learned preferences that evolve over time.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () =>
        get(`/api/strategy/state?walletId=${walletId}`),
      ),
    });

    api.registerTool({
      name: "solana_strategy_update",
      description: "Update your strategy weights and/or operating mode. Weights reflect which market signals best predict winners. Server enforces guardrails: min 3 features, each weight 0.01–0.50, sum 0.95–1.05, max ±0.20 delta per feature, semver format required, version must increment. Always increment strategyVersion.",
      parameters: Type.Object({
        featureWeights: Type.Record(Type.String(), Type.Number(), {
          description: "Feature weight map (e.g., { volume_momentum: 0.25, buy_pressure: 0.20, ... }). Values should sum to ~1.0",
        }),
        strategyVersion: Type.String({ description: "New version string (e.g., 'v1.3.0'). Always increment from current." }),
        mode: Type.Optional(
          Type.Union([Type.Literal("HARDENED"), Type.Literal("DEGEN")], {
            description: "Operating mode. HARDENED = survival-first, DEGEN = high-velocity. Default: HARDENED",
          }),
        ),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/strategy/update", {
          featureWeights: params.featureWeights,
          strategyVersion: params.strategyVersion,
          mode: params.mode,
        }),
      ),
    });

    // =========================================================================
    // SAFETY TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_killswitch",
      description: "Toggle the emergency kill switch. When enabled, ALL trade execution is blocked. Use in emergencies: repeated losses, unusual market behavior, or security concerns.",
      parameters: Type.Object({
        enabled: Type.Boolean({ description: "true to activate (block all trades), false to deactivate" }),
        mode: Type.Optional(
          Type.Union([Type.Literal("TRADES_ONLY"), Type.Literal("TRADES_AND_STREAMS")], {
            description: "TRADES_ONLY blocks execution; TRADES_AND_STREAMS blocks everything",
          }),
        ),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/killswitch", {
          enabled: params.enabled,
          mode: params.mode,
        }),
      ),
    });

    api.registerTool({
      name: "solana_killswitch_status",
      description: "Check the current kill switch state — whether it's enabled and in what mode.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () =>
        get(`/api/killswitch/status?walletId=${walletId}`),
      ),
    });

    // =========================================================================
    // WALLET TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_capital_status",
      description: "Get your current capital status — SOL balance, open position count, unrealized PnL, daily notional used, daily loss, and effective limits (adjusted by entitlements).",
      parameters: Type.Object({}),
      execute: wrapExecute(async () =>
        get(`/api/capital/status?walletId=${walletId}`),
      ),
    });

    api.registerTool({
      name: "solana_positions",
      description: "List your current trading positions with unrealized PnL, entry price, current price, stop-loss/take-profit settings, and management mode. Call at the START of every trading cycle for interrupt check. Also use to detect dead money (flat positions).",
      parameters: Type.Object({
        status: Type.Optional(Type.String({ description: "Filter by status: 'open', 'closed', or omit for all" })),
      }),
      execute: wrapExecute(async (_id, params) => {
        let path = `/api/wallet/positions?walletId=${walletId}`;
        if (params.status) path += `&status=${params.status}`;
        return get(path);
      }),
    });

    api.registerTool({
      name: "solana_funding_instructions",
      description: "Get deposit instructions for funding your trading wallet with SOL.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () =>
        get(`/api/funding/instructions?walletId=${walletId}`),
      ),
    });

    api.registerTool({
      name: "solana_wallets",
      description: "List all wallets associated with your account. Optionally refresh balances from on-chain.",
      parameters: Type.Object({
        refresh: Type.Optional(Type.Boolean({ description: "If true, refresh balances from on-chain before returning" })),
      }),
      execute: wrapExecute(async (_id, params) => {
        let path = "/api/wallets";
        if (params.refresh) path += "?refresh=true";
        return get(path);
      }),
    });

    api.registerTool({
      name: "solana_wallet_create",
      description: "Create a new trading wallet. Returns the wallet ID and public key. Use this to provision additional wallets for strategy isolation or multi-wallet trading.",
      parameters: Type.Object({
        label: Type.Optional(Type.String({ description: "Human-readable label for the wallet (e.g., 'Degen Wallet')" })),
        publicKey: Type.Optional(Type.String({ description: "Existing Solana public key to import (omit to generate new)" })),
        chain: Type.Optional(Type.Union([Type.Literal("solana"), Type.Literal("bsc")], { description: "Blockchain (default: solana)" })),
        ownerRef: Type.Optional(Type.String({ description: "Owner reference string" })),
        includePrivateKey: Type.Optional(Type.Boolean({ description: "If true, return the private key in the response (only for newly generated wallets)" })),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/wallet/create", {
          label: params.label,
          publicKey: params.publicKey,
          chain: params.chain,
          ownerRef: params.ownerRef,
          includePrivateKey: params.includePrivateKey,
        }),
      ),
    });

    api.registerTool({
      name: "solana_trades",
      description: "List your trade history with pagination. Returns executed trades with details like token, side, size, PnL, and timestamp.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max trades to return (1-200, default: 50)" })),
        offset: Type.Optional(Type.Number({ description: "Offset for pagination (default: 0)" })),
      }),
      execute: wrapExecute(async (_id, params) => {
        let path = `/api/trades?walletId=${walletId}`;
        if (params.limit) path += `&limit=${params.limit}`;
        if (params.offset) path += `&offset=${params.offset}`;
        return get(path);
      }),
    });

    api.registerTool({
      name: "solana_risk_denials",
      description: "List recent risk denials — trades that were blocked by the policy engine. Review these to understand what setups trigger denials and avoid repeating wasted analysis.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max denials to return (1-200, default: 50)" })),
      }),
      execute: wrapExecute(async (_id, params) => {
        let path = `/api/risk-denials?walletId=${walletId}`;
        if (params.limit) path += `&limit=${params.limit}`;
        return get(path);
      }),
    });

    // =========================================================================
    // ENTITLEMENT TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_entitlement_costs",
      description: "Get tier costs — what each tier (starter, pro, enterprise) costs and what capabilities it unlocks.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => get("/api/entitlements/costs")),
    });

    api.registerTool({
      name: "solana_entitlement_plans",
      description: "List available monthly entitlement plans that upgrade your trading limits (position size, daily notional, bandwidth). Shows price, duration, and limit boosts.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => get("/api/entitlements/plans")),
    });

    api.registerTool({
      name: "solana_entitlement_current",
      description: "Get your current entitlements — active tier, scope access, effective limits, and expiration details.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => {
        const result = await get(`/api/entitlements/current?walletId=${walletId}`);
        if (result && typeof result === "object") {
          try {
            const cacheFile = path.join(stateDir, "entitlement-cache.json");
            writeJsonFile(cacheFile, { ...result as Record<string, unknown>, cachedAt: new Date().toISOString() });
          } catch (_) { /* best-effort cache write */ }
        }
        return result;
      }),
    });

    api.registerTool({
      name: "solana_entitlement_purchase",
      description: "Purchase an entitlement plan to upgrade your trading limits. Deducts SOL from your wallet balance. Subject to spend guardrails (daily max, per-upgrade max, cooldown).",
      parameters: Type.Object({
        planCode: Type.String({ description: "Plan code to purchase (e.g., 'pro_trader', 'bandwidth_boost')" }),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/entitlements/purchase", {
          planCode: params.planCode,
        }),
      ),
    });

    api.registerTool({
      name: "solana_entitlement_upgrade",
      description: "Upgrade your account tier (starter → pro → enterprise). Unlocks additional endpoints and capabilities. Pro tier is required for scanning, token analysis, and Bitquery tools.",
      parameters: Type.Object({
        targetTier: Type.Union([Type.Literal("starter"), Type.Literal("pro"), Type.Literal("enterprise")], {
          description: "Target tier to upgrade to",
        }),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/entitlements/upgrade", {
          targetTier: params.targetTier,
        }),
      ),
    });

    // =========================================================================
    // BITQUERY INTELLIGENCE TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_bitquery_templates",
      description: "List all available pre-built Bitquery query templates with descriptions and required variables. Call this first to discover what templates are available before using solana_bitquery_catalog. Returns 50+ templates organized by category covering Pump.fun, PumpSwap, Raydium, Jupiter, BonkSwap, and generic DEX analytics.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => ({
        categories: {
          pumpFunCreation: [
            { path: "pumpFunCreation.trackNewTokens", description: "Track newly created Pump.fun tokens", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpFunCreation.getCreationTimeAndDev", description: "Get creation time and dev address for token", variables: { token: "String!" } },
            { path: "pumpFunCreation.trackLaunchesRealtime", description: "Track new token launches in real-time via query polling", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpFunCreation.getTokensByCreatorAddress", description: "Get all Pump.fun tokens created by creator wallet", variables: { creator: "String!", limit: "Int!" } },
            { path: "pumpFunCreation.getTokensByCreatorHistorical", description: "Historical token creations by wallet", variables: { creator: "String!", since: "DateTime!", till: "DateTime!" } },
          ],
          pumpFunMetadata: [
            { path: "pumpFunMetadata.tokenMetadataByAddress", description: "Get token metadata plus dev and creation time", variables: { token: "String!" } },
            { path: "pumpFunMetadata.trackMayhemModeRealtime", description: "Track Mayhem Mode enabled tokens in real-time", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpFunMetadata.currentMayhemModeStatus", description: "Check current Mayhem mode status for token", variables: { token: "String!" } },
            { path: "pumpFunMetadata.historicalMayhemModeStatus", description: "Historical mayhem mode changes for token", variables: { token: "String!", since: "DateTime!", till: "DateTime!" } },
            { path: "pumpFunMetadata.latestPrice", description: "Latest price for Pump.fun token", variables: { token: "String!" } },
          ],
          pumpFunPriceMomentum: [
            { path: "pumpFunPriceMomentum.streamTokenPrice", description: "Price stream query for polling mode", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpFunPriceMomentum.top10PriceChange5m", description: "Top 10 by short-term price change", variables: { since: "DateTime!" } },
            { path: "pumpFunPriceMomentum.tokenOHLC", description: "OHLC data for Pump.fun token", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpFunPriceMomentum.athMarketCapWindow", description: "ATH market cap in window", variables: { token: "String!", since: "DateTime!", till: "DateTime!" } },
            { path: "pumpFunPriceMomentum.priceChangeDeltaFromMinutesAgo", description: "Price-change delta from X minutes back", variables: { token: "String!", since: "DateTime!" } },
          ],
          pumpFunTradesLiquidity: [
            { path: "pumpFunTradesLiquidity.realtimeTrades", description: "Get real-time trades on Pump.fun", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpFunTradesLiquidity.latestTradesByToken", description: "Latest trades by token", variables: { token: "String!", limit: "Int!" } },
            { path: "pumpFunTradesLiquidity.tradingVolume", description: "Get trading volume for token", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpFunTradesLiquidity.detailedTradeStats", description: "Detailed trade stats (volume/buys/sells/makers/buyers/sellers)", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpFunTradesLiquidity.lastTradeBeforeMigration", description: "Last Pump.fun trade before migration to PumpSwap", variables: { token: "String!" } },
          ],
          pumpFunHoldersRisk: [
            { path: "pumpFunHoldersRisk.first100Buyers", description: "Get first 100 buyers", variables: { token: "String!" } },
            { path: "pumpFunHoldersRisk.first100StillHolding", description: "Check whether first 100 buyers still hold", variables: { holders: "[String!]", token: "String!" } },
            { path: "pumpFunHoldersRisk.devHoldings", description: "Get developer holdings for token", variables: { devWallet: "String!", token: "String!" } },
            { path: "pumpFunHoldersRisk.topHoldersTopTradersTopCreators", description: "Get top holders/top traders/top creators", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpFunHoldersRisk.phishyAndMarketCapFilters", description: "Phishy check + market cap filter scaffolding", variables: { since: "DateTime!", minCap: "String!", maxCap: "String!" } },
          ],
          pumpSwapPostMigration: [
            { path: "pumpSwapPostMigration.newPoolsRealtime", description: "Get newly created PumpSwap pools", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpSwapPostMigration.trackMigratedPools", description: "Track pools migrated to PumpSwap", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpSwapPostMigration.latestTrades", description: "Get latest trades on PumpSwap", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpSwapPostMigration.latestTradesByToken", description: "Latest PumpSwap trades for token", variables: { token: "String!", limit: "Int!" } },
            { path: "pumpSwapPostMigration.pumpSwapSubscriptionScaffold", description: "Query mirror for PumpSwap realtime subscription", variables: { since: "DateTime!" } },
          ],
          pumpSwapPriceTrader: [
            { path: "pumpSwapPriceTrader.trackTokenPriceRealtime", description: "Track PumpSwap token price realtime", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpSwapPriceTrader.latestPrice", description: "Get latest price for PumpSwap token", variables: { token: "String!" } },
            { path: "pumpSwapPriceTrader.ohlc", description: "OHLC for PumpSwap token", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpSwapPriceTrader.latestTradesByTrader", description: "Get latest trades by trader", variables: { wallet: "String!", since: "DateTime!" } },
            { path: "pumpSwapPriceTrader.topTradersAndStats", description: "Top traders and token trade stats", variables: { token: "String!", since: "DateTime!" } },
          ],
          launchpadsRaydiumLetsBonk: [
            { path: "launchpadsRaydiumLetsBonk.latestRaydiumLaunchpadPools", description: "Track latest pools created on Raydium Launchpad", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "launchpadsRaydiumLetsBonk.trackMigrationsToRaydium", description: "Track migrations to Raydium DEX/CPMM across launchpads", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "launchpadsRaydiumLetsBonk.bondingCurveProgress", description: "Compute bonding curve progress from latest pool/liquidity snapshot", variables: { token: "String!", since: "DateTime!" } },
            { path: "launchpadsRaydiumLetsBonk.tokensAbove95Progress", description: "Track launchpad tokens above 95% bonding curve progress", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "launchpadsRaydiumLetsBonk.top100AboutToGraduate", description: "Top 100 launchpad tokens near migration", variables: { since: "DateTime!" } },
          ],
          launchpadsTokenLevel: [
            { path: "launchpadsTokenLevel.latestLaunchpadTrades", description: "Get latest launchpad trades", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "launchpadsTokenLevel.latestPriceForToken", description: "Get latest price for launchpad token", variables: { token: "String!" } },
            { path: "launchpadsTokenLevel.latestTradesByUser", description: "Get latest trades by user", variables: { wallet: "String!", since: "DateTime!" } },
            { path: "launchpadsTokenLevel.topBuyersAndSellers", description: "Get top buyers and top sellers for token", variables: { token: "String!", since: "DateTime!" } },
            { path: "launchpadsTokenLevel.ohlcPairAndLiquidity", description: "Get OHLC, pair address and latest liquidity", variables: { token: "String!", since: "DateTime!" } },
          ],
          exchangeSpecific: [
            { path: "exchangeSpecific.raydiumSuite", description: "Raydium: pools, pair create time, latest price, trades, LP changes, OHLC", variables: { token: "String!", since: "DateTime!" } },
            { path: "exchangeSpecific.bonkSwapSuite", description: "BonkSwap: latest trades, top traders, trader feed, OHLC", variables: { token: "String!", wallet: "String!", since: "DateTime!" } },
            { path: "exchangeSpecific.jupiterSuite", description: "Jupiter swaps and order lifecycle query suite", variables: { since: "DateTime!" } },
            { path: "exchangeSpecific.jupiterStudioSuite", description: "Jupiter Studio token trades, prices, OHLC, launches, migrations", variables: { since: "DateTime!", token: "String" } },
          ],
          genericDexAnalytics: [
            { path: "genericDexAnalytics.latestSolanaTrades", description: "Subscribe/query latest Solana trades", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "genericDexAnalytics.priceVsWsolUsdMultiMarket", description: "Token price vs WSOL/USD and multi-market", variables: { token: "String!", since: "DateTime!" } },
            { path: "genericDexAnalytics.pressureTopsAndDexs", description: "Buy/sell pressure and top-bought/top-sold/pairs/dexs", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "genericDexAnalytics.dexMarketsPairsTokenDetails", description: "DEX markets/pairs/token details", variables: { token: "String!", since: "DateTime!" } },
            { path: "genericDexAnalytics.ohlcHistoryAthTrendSearch", description: "OHLC history, ATH, first-24h, trend, search", variables: { token: "String!", since: "DateTime!" } },
          ],
        },
        subscriptions: [
          { key: "realtimeTokenPricesSolana", description: "Real-time token prices on Solana", variables: { token: "String!" } },
          { key: "ohlc1s", description: "1-second OHLC stream", variables: { token: "String!" } },
          { key: "dexPoolLiquidityChanges", description: "DEXPool liquidity changes stream", variables: { token: "String!" } },
          { key: "pumpFunTokenCreation", description: "Pump.fun token creation stream", variables: {} },
          { key: "pumpFunTrades", description: "Pump.fun trades stream", variables: { token: "String" } },
          { key: "pumpSwapTrades", description: "PumpSwap trades stream", variables: { token: "String" } },
          { key: "raydiumNewPools", description: "Raydium v4/Launchpad/CLMM new pools stream", variables: {} },
        ],
        totalTemplates: 54,
        totalSubscriptions: 7,
        usage: "Use solana_bitquery_catalog with templatePath and variables to run any template. For custom queries, use solana_bitquery_query with raw GraphQL.",
      })),
    });

    api.registerTool({
      name: "solana_bitquery_catalog",
      description: "Run a pre-built Bitquery query template from the catalog. Use solana_bitquery_templates first to discover available templates. Templates cover Pump.fun creation/metadata/price/trades/holders, PumpSwap post-migration, launchpad analytics, exchange-specific suites (Raydium/Jupiter/BonkSwap), and generic DEX analytics. See query-catalog.md in the solana-trader skill for the full reference.",
      parameters: Type.Object({
        templatePath: Type.String({ description: "Template path in 'category.key' format (e.g., 'pumpFunHoldersRisk.first100Buyers')" }),
        variables: Type.Object({}, { additionalProperties: true, description: "Variables required by the template (e.g., { token: 'MINT_ADDRESS', since: '2025-01-01T00:00:00Z' })" }),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/bitquery/catalog", {
          templatePath: params.templatePath as string,
          variables: params.variables || {},
        }),
      ),
    });

    api.registerTool({
      name: "solana_bitquery_query",
      description: "Run a custom raw GraphQL query against the Bitquery v2 EAP endpoint for Solana on-chain data. Use this when no pre-built template fits your needs. IMPORTANT: Consult bitquery-schema.md in the solana-trader skill before writing queries — DEXTrades and DEXTradeByTokens have different field shapes and mixing them causes errors. The schema reference includes a decision guide, correct field paths, aggregate keys, and a common error fix map.",
      parameters: Type.Object({
        query: Type.String({ description: "Raw GraphQL query string (query or subscription operation)" }),
        variables: Type.Optional(Type.Object({}, { additionalProperties: true, description: "GraphQL variables (e.g., { token: 'MINT_ADDRESS', since: '2025-01-01T00:00:00Z' })" })),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/bitquery/query", {
          query: params.query as string,
          variables: params.variables || {},
        }),
      ),
    });

    // =========================================================================
    // BITQUERY SUBSCRIPTION TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_bitquery_subscribe",
      description: "Subscribe to a managed real-time Bitquery data stream. The orchestrator manages the WebSocket connection and broadcasts events. Available templates: realtimeTokenPricesSolana, ohlc1s, dexPoolLiquidityChanges, pumpFunTokenCreation, pumpFunTrades, pumpSwapTrades, raydiumNewPools. Returns a subscriptionId for tracking. Pass agentId to enable event-to-agent forwarding — orchestrator delivers each event to your Gateway via /v1/responses in addition to normal WS delivery. Subscriptions expire after 24h and emit subscription_expiring/subscription_expired events. See websocket-streaming.md in the solana-trader skill for the full message contract and usage patterns.",
      parameters: Type.Object({
        templateKey: Type.String({ description: "Subscription template key (e.g., 'pumpFunTrades', 'ohlc1s', 'realtimeTokenPricesSolana')" }),
        variables: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Template variables (e.g., { token: 'MINT_ADDRESS' })" })),
        agentId: Type.Optional(Type.String({ description: "Agent ID for event-to-agent forwarding (e.g., 'main'). When set, orchestrator forwards each stream event to your registered Gateway via /v1/responses." })),
        subscriberType: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("client")], { description: "Subscriber type. Inferred as 'agent' when agentId is present. Defaults to 'client'." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const body: Record<string, unknown> = {
          templateKey: params.templateKey as string,
          variables: params.variables || {},
        };
        const effectiveAgentId = (params.agentId as string | undefined) || config.agentId;
        if (effectiveAgentId) {
          body.agentId = effectiveAgentId;
          body.subscriberType = (params.subscriberType as string | undefined) || "agent";
        } else if (params.subscriberType) {
          body.subscriberType = params.subscriberType;
        }
        return post("/api/bitquery/subscribe", body);
      }),
    });

    api.registerTool({
      name: "solana_bitquery_unsubscribe",
      description: "Unsubscribe from a managed Bitquery data stream. Pass the subscriptionId returned by solana_bitquery_subscribe. Important: always use the server-returned subscriptionId, never generate your own.",
      parameters: Type.Object({
        subscriptionId: Type.String({ description: "Subscription ID returned by solana_bitquery_subscribe (e.g., 'bqs_abc123...')" }),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/bitquery/unsubscribe", {
          subscriptionId: params.subscriptionId as string,
        }),
      ),
    });

    api.registerTool({
      name: "solana_bitquery_subscriptions",
      description: "List all active Bitquery subscriptions and bridge diagnostics. Returns connected clients, active streams, upstream connection status, and per-stream subscriber counts. Use for monitoring real-time data feed health.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () =>
        get("/api/bitquery/subscriptions/active"),
      ),
    });

    api.registerTool({
      name: "solana_bitquery_subscription_reopen",
      description: "Reopen an expired or expiring Bitquery subscription. Subscriptions have a 24h TTL and emit bitquery_subscription_expiring (30 min warning), bitquery_subscription_expired, and reconnect_required events. Call this to renew before or after expiry. The subscription_cleanup cron job handles this automatically, but manual reopen is available for critical subscriptions. Returns the new subscriptionId.",
      parameters: Type.Object({
        subscriptionId: Type.String({ description: "The expired or expiring subscription ID to reopen (e.g., 'bqs_abc123...')" }),
        walletId: Type.Optional(Type.String({ description: "Wallet ID to reopen the subscription for. Defaults to the plugin's configured walletId." })),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/bitquery/subscriptions/reopen", {
          subscriptionId: params.subscriptionId as string,
          ...(params.walletId ? { walletId: params.walletId as string } : {}),
        }),
      ),
    });

    // =========================================================================
    // GATEWAY CREDENTIAL TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_gateway_credentials_set",
      description: "Register or update your OpenClaw Gateway credentials with the orchestrator. This enables event-to-agent forwarding — when subscriptions include agentId, the orchestrator delivers each stream event to your Gateway via /v1/responses. Call this once during initial setup (Step 0). The gatewayBaseUrl is your self-hosted OpenClaw Gateway's public URL. The gatewayToken is the Bearer token for authenticating forwarded events.",
      parameters: Type.Object({
        gatewayBaseUrl: Type.String({ description: "Your OpenClaw Gateway's public HTTPS URL (e.g., 'https://gateway.example.com')" }),
        gatewayToken: Type.String({ description: "Bearer token for authenticating forwarded events to your Gateway" }),
        agentId: Type.Optional(Type.String({ description: "Agent ID to associate credentials with (default: 'main'). Omit to store as the default fallback." })),
        active: Type.Optional(Type.Boolean({ description: "Whether forwarding is active (default: true)" })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const body: Record<string, unknown> = {
          gatewayBaseUrl: params.gatewayBaseUrl as string,
          gatewayToken: params.gatewayToken as string,
        };
        if (params.agentId) body.agentId = params.agentId;
        if (params.active !== undefined) body.active = params.active;
        return put("/api/agents/gateway-credentials", body);
      }),
    });

    api.registerTool({
      name: "solana_gateway_credentials_get",
      description: "Get the currently registered Gateway credentials for event-to-agent forwarding. Returns the gatewayBaseUrl, agentId, active status, and masked token. Use to verify Gateway setup is correct.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () =>
        get("/api/agents/gateway-credentials"),
      ),
    });

    api.registerTool({
      name: "solana_gateway_credentials_delete",
      description: "Delete your registered Gateway credentials. This disables event-to-agent forwarding — subscriptions with agentId will no longer forward events to your Gateway. Only use if decommissioning the Gateway.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () =>
        del("/api/agents/gateway-credentials"),
      ),
    });

    api.registerTool({
      name: "solana_agent_sessions",
      description: "List active agent sessions registered with the orchestrator. Returns session IDs, agent IDs, connection status, and subscription counts. Use for diagnostics — verify your agent is properly registered and its subscriptions are forwarding events.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () =>
        get("/api/agents/active"),
      ),
    });

    // =========================================================================
    // ALPHA SIGNAL TOOLS
    // =========================================================================

    const alphaBuffer = new AlphaBuffer();
    const alphaStreamManager = new AlphaStreamManager({
      wsUrl: orchestratorUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws",
      getAccessToken: () => sessionManager.getAccessToken(),
      buffer: alphaBuffer,
      agentId: config.agentId,
      logger: {
        info: (msg) => api.logger.info(`[solana-trader] ${msg}`),
        warn: (msg) => api.logger.warn(`[solana-trader] ${msg}`),
        error: (msg) => api.logger.error(`[solana-trader] ${msg}`),
      },
    });

    type StartupStepName =
      | "solana_system_status"
      | "solana_gateway_credentials_get"
      | "solana_alpha_subscribe"
      | "solana_capital_status"
      | "solana_positions"
      | "solana_killswitch_status";
    type StartupStepResult = {
      step: StartupStepName;
      ok: boolean;
      ts: number;
      error?: string;
      details?: Record<string, unknown>;
    };
    let startupGateRunning: Promise<{
      ok: boolean;
      ts: number;
      steps: StartupStepResult[];
      summary: {
        passed: number;
        failed: number;
      };
    }> | null = null;
    let startupGateState: {
      ok: boolean;
      ts: number;
      steps: StartupStepResult[];
    } = {
      ok: false,
      ts: 0,
      steps: [],
    };
    let lastForwardProbeState: {
      ok: boolean;
      ts: number;
      result: Record<string, unknown>;
    } | null = null;
    const getActiveCredential = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return null;
      const credentials = (payload as { credentials?: unknown[] }).credentials;
      if (!Array.isArray(credentials)) return null;
      const preferredAgentId = config.agentId || "main";
      const active = credentials.find((entry) =>
        entry &&
        typeof entry === "object" &&
        Boolean((entry as { active?: boolean }).active) &&
        (((entry as { agentId?: string | null }).agentId || "main") === preferredAgentId),
      ) || credentials.find((entry) =>
        entry &&
        typeof entry === "object" &&
        Boolean((entry as { active?: boolean }).active),
      );
      return active && typeof active === "object" ? (active as Record<string, unknown>) : null;
    };
    const runForwardProbe = async ({
      agentId,
      source = "plugin_probe",
    }: {
      agentId?: string;
      source?: string;
    } = {}) => {
      const payload = await post("/api/agents/gateway-forward-probe", {
        agentId: agentId || config.agentId || "main",
        source,
      });
      const result = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
      const ok = Boolean(result.ok);
      lastForwardProbeState = {
        ok,
        ts: Date.now(),
        result,
      };
      return result;
    };
    const runStartupGate = async ({
      autoFixGateway = true,
      force = false,
    }: {
      autoFixGateway?: boolean;
      force?: boolean;
    } = {}) => {
      if (startupGateRunning && !force) return startupGateRunning;
      startupGateRunning = (async () => {
        const steps: StartupStepResult[] = [];
        const pushStep = (entry: StartupStepResult) => steps.push(entry);

        try {
          await get("/api/system/status");
          pushStep({
            step: "solana_system_status",
            ok: true,
            ts: Date.now(),
          });
        } catch (err) {
          pushStep({
            step: "solana_system_status",
            ok: false,
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          });
        }

        let gatewayStepOk = false;
        try {
          const creds = (await get("/api/agents/gateway-credentials")) as Record<string, unknown>;
          let activeCredential = getActiveCredential(creds);
          if (!activeCredential && autoFixGateway) {
            const gatewayBaseUrl = String(config.gatewayBaseUrl || "").trim();
            const gatewayToken = String(config.gatewayToken || "").trim();
            if (gatewayBaseUrl && gatewayToken) {
              const body: Record<string, unknown> = {
                gatewayBaseUrl,
                gatewayToken,
                active: true,
              };
              if (config.agentId) body.agentId = config.agentId;
              await put("/api/agents/gateway-credentials", body);
            }
          }
          const refreshed = (await get("/api/agents/gateway-credentials")) as Record<string, unknown>;
          activeCredential = getActiveCredential(refreshed);
          gatewayStepOk = Boolean(activeCredential);
          if (!gatewayStepOk) {
            throw new Error("Gateway credentials are missing or inactive");
          }
          pushStep({
            step: "solana_gateway_credentials_get",
            ok: true,
            ts: Date.now(),
            details: {
              active: true,
              agentId: String(activeCredential?.agentId || config.agentId || "main"),
              gatewayBaseUrl: String(activeCredential?.gatewayBaseUrl || ""),
            },
          });
        } catch (err) {
          pushStep({
            step: "solana_gateway_credentials_get",
            ok: false,
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err),
            details: {
              hasConfiguredGatewayBaseUrl: Boolean(config.gatewayBaseUrl),
              hasConfiguredGatewayToken: Boolean(config.gatewayToken),
            },
          });
        }

        try {
          const effectiveAgentId = config.agentId || "main";
          if (effectiveAgentId && alphaStreamManager.getAgentId() !== effectiveAgentId) {
            alphaStreamManager.setAgentId(effectiveAgentId);
          }
          alphaStreamManager.setSubscriberType("agent");
          const subscribed = await alphaStreamManager.subscribe();
          pushStep({
            step: "solana_alpha_subscribe",
            ok: Boolean(subscribed?.subscribed),
            ts: Date.now(),
            details: {
              agentId: effectiveAgentId,
              premiumAccess: subscribed?.premiumAccess || false,
              tier: subscribed?.tier || "",
            },
          });
        } catch (err) {
          pushStep({
            step: "solana_alpha_subscribe",
            ok: false,
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err),
            details: {
              skippedBecauseGatewayFailed: !gatewayStepOk,
            },
          });
        }

        try {
          await get(`/api/capital/status?walletId=${walletId}`);
          pushStep({
            step: "solana_capital_status",
            ok: true,
            ts: Date.now(),
          });
        } catch (err) {
          pushStep({
            step: "solana_capital_status",
            ok: false,
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          });
        }

        try {
          await get(`/api/wallet/positions?walletId=${walletId}`);
          pushStep({
            step: "solana_positions",
            ok: true,
            ts: Date.now(),
          });
        } catch (err) {
          pushStep({
            step: "solana_positions",
            ok: false,
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          });
        }

        try {
          await get(`/api/killswitch/status?walletId=${walletId}`);
          pushStep({
            step: "solana_killswitch_status",
            ok: true,
            ts: Date.now(),
          });
        } catch (err) {
          pushStep({
            step: "solana_killswitch_status",
            ok: false,
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const passed = steps.filter((step) => step.ok).length;
        const failed = steps.length - passed;
        const failedSteps = steps.filter((step) => !step.ok);
        const onlyCapitalFailed =
          failedSteps.length === 1 && failedSteps[0]?.step === "solana_capital_status";
        startupGateState = {
          ok: failed === 0,
          ts: Date.now(),
          steps,
        };
        const base = {
          ok: startupGateState.ok,
          ts: startupGateState.ts,
          steps,
          summary: { passed, failed },
        };
        const includeWelcome = startupGateState.ok || onlyCapitalFailed;
        if (includeWelcome) {
          const k = (config.apiKey && String(config.apiKey).trim()) || null;
          const out = { ...base, welcomeMessage: buildTraderClawWelcomeMessage(k) };
          if (onlyCapitalFailed && !startupGateState.ok) {
            return {
              ...out,
              welcomeNote:
                "Startup gate reported solana_capital_status failed (e.g. capital API error). Welcome message still included so the user gets onboarding text and API key; fix capital/wallet if tools keep failing.",
            };
          }
          return out;
        }
        return base;
      })()
        .finally(() => {
          startupGateRunning = null;
        });

      return startupGateRunning;
    };

    api.registerTool({
      name: "solana_alpha_subscribe",
      description: "Subscribe to the SpyFly alpha signal stream via WebSocket. Starts receiving real-time alpha signals (TG/Discord channel calls) into the buffer. Call once on first heartbeat — stays connected with auto-reconnect. Pass agentId to enable event-to-agent forwarding — orchestrator delivers each alpha signal to your Gateway via /v1/responses in addition to buffering. Returns subscription status, tier, and premium access level.",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String({ description: "Agent ID for event-to-agent forwarding (e.g., 'main'). Overrides plugin config agentId if provided." })),
        subscriberType: Type.Optional(Type.String({ description: "Subscriber type: 'agent' (default when agentId is set) or 'user'. Controls how the orchestrator routes events." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const effectiveAgentId = (params.agentId as string | undefined) || config.agentId;
        if (effectiveAgentId && alphaStreamManager.getAgentId() !== effectiveAgentId) {
          alphaStreamManager.setAgentId(effectiveAgentId);
        }
        const effectiveSubscriberType = (params.subscriberType as string | undefined) || (effectiveAgentId ? "agent" : undefined);
        if (effectiveSubscriberType) {
          alphaStreamManager.setSubscriberType(effectiveSubscriberType);
        }
        return alphaStreamManager.subscribe();
      }),
    });

    api.registerTool({
      name: "solana_alpha_unsubscribe",
      description: "Unsubscribe from the SpyFly alpha signal stream and disconnect WebSocket. Use when shutting down or if kill switch is activated with TRADES_AND_STREAMS mode.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => alphaStreamManager.unsubscribe()),
    });

    api.registerTool({
      name: "solana_alpha_signals",
      description: "Get buffered alpha signals from the SpyFly stream. By default returns only unseen signals and marks them as seen. Use minScore to filter low-quality signals. Poll this every heartbeat cycle in Step 1.5b. Returns signals sorted by ingestion time (newest last).",
      parameters: Type.Object({
        minScore: Type.Optional(Type.Number({ description: "Minimum systemScore threshold (0-100). Signals below this are excluded." })),
        chain: Type.Optional(Type.String({ description: "Filter by chain (e.g., 'solana'). BSC is already filtered at ingestion." })),
        kinds: Type.Optional(Type.Array(Type.String(), { description: "Filter by signal kind: 'ca_drop', 'milestone', 'update', 'risk', 'exit'" })),
        unseen: Type.Optional(Type.Boolean({ description: "If true (default), return only unseen signals and mark them as seen. Set false to get all buffered signals." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const signals = alphaBuffer.getSignals({
          minScore: params.minScore as number | undefined,
          chain: params.chain as string | undefined,
          kinds: params.kinds as string[] | undefined,
          unseen: params.unseen !== undefined ? params.unseen as boolean : true,
        });
        return {
          signals,
          count: signals.length,
          bufferSize: alphaBuffer.getBufferSize(),
          subscribed: alphaStreamManager.isSubscribed(),
          stats: alphaStreamManager.getStats(),
        };
      }),
    });

    api.registerTool({
      name: "solana_alpha_history",
      description: "Query historical alpha signal data via the SpyFly REST API (GET /api/pings). Returns up to 1 year of stored signals for source reputation analysis, post-downtime catch-up, and strategy learning. Tier-gated: starter=10, pro=50, enterprise=200 results. 99.99% of tokens are dead but source patterns are invaluable.",
      parameters: Type.Object({
        tokenAddress: Type.Optional(Type.String({ description: "Filter by token mint address" })),
        channelId: Type.Optional(Type.String({ description: "Filter by source channel ID" })),
        limit: Type.Optional(Type.Number({ description: "Max results (tier-capped: starter=10, pro=50, enterprise=200)" })),
        days: Type.Optional(Type.Number({ description: "Look back period in days. Converted to then/now timestamp range." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const queryParts: string[] = [];
        if (params.limit) queryParts.push(`limit=${params.limit}`);
        if (params.channelId) queryParts.push(`channelId=${params.channelId}`);
        if (params.days) {
          const now = Date.now();
          const then = now - (params.days as number) * 24 * 60 * 60 * 1000;
          queryParts.push(`then=${then}`);
          queryParts.push(`now=${now}`);
        }
        if (params.tokenAddress) queryParts.push(`tokenAddress=${params.tokenAddress}`);
        const qs = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";
        return get(`/api/pings${qs}`);
      }),
    });

    api.registerTool({
      name: "solana_alpha_sources",
      description: "Get per-source statistics from the alpha signal buffer — signal count, average systemScore, and source type for each channel. Use for quick reputation checks during signal processing and to identify high-quality vs low-quality sources.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => ({
        sources: alphaBuffer.getSourceStatsAll(),
        bufferSize: alphaBuffer.getBufferSize(),
        subscribed: alphaStreamManager.isSubscribed(),
      })),
    });

    // =========================================================================
    // SYSTEM TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_system_status",
      description: "Check orchestrator system health — uptime, connected services, database status, execution mode, and upstream API connectivity.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => get("/api/system/status")),
    });

    api.registerTool({
      name: "solana_startup_gate",
      description:
        "Run the mandatory startup sequence and return deterministic pass/fail results per step. Optionally auto-fixes gateway credentials if gatewayBaseUrl and gatewayToken are present in plugin config. On full pass, includes welcomeMessage. If the only failed step is solana_capital_status (e.g. capital API error), still includes welcomeMessage so the user gets onboarding text; check welcomeNote in that case.",
      parameters: Type.Object({
        autoFixGateway: Type.Optional(Type.Boolean({ description: "If true (default), auto-register gateway credentials when missing and config includes gatewayBaseUrl + gatewayToken." })),
        force: Type.Optional(Type.Boolean({ description: "If true, always run the startup checks now even if a recent run exists." })),
      }),
      execute: wrapExecute(async (_id, params) =>
        runStartupGate({
          autoFixGateway: params.autoFixGateway !== undefined ? Boolean(params.autoFixGateway) : true,
          force: Boolean(params.force),
        }),
      ),
    });

    api.registerTool({
      name: "solana_traderclaw_welcome",
      description:
        "Returns the canonical TraderClaw welcome message for the user after startup checks succeed (including when the only issue is zero balance — funding is separate). Includes API key when stored in plugin config. Use when the user ran the manual startup checklist instead of solana_startup_gate, or whenever welcomeMessage was not already appended from solana_startup_gate.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => {
        const k = (config.apiKey && String(config.apiKey).trim()) || null;
        return { welcomeMessage: buildTraderClawWelcomeMessage(k) };
      }),
    });

    api.registerTool({
      name: "solana_gateway_forward_probe",
      description: "Run a synthetic orchestrator-to-gateway forwarding probe for /v1/responses and return latency plus failure diagnostics.",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String({ description: "Agent ID to probe (default: plugin config agentId or 'main')." })),
        source: Type.Optional(Type.String({ description: "Probe source label for diagnostics." })),
      }),
      execute: wrapExecute(async (_id, params) =>
        runForwardProbe({
          agentId: params.agentId ? String(params.agentId) : undefined,
          source: params.source ? String(params.source) : "plugin_probe_tool",
        }),
      ),
    });

    api.registerTool({
      name: "solana_runtime_status",
      description: "Return plugin runtime diagnostics including startup-gate cache, alpha stream status, and latest forwarding probe result.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => ({
        startupGate: startupGateState,
        alphaStream: {
          subscribed: alphaStreamManager.isSubscribed(),
          stats: alphaStreamManager.getStats(),
          bufferSize: alphaBuffer.getBufferSize(),
        },
        lastForwardProbe: lastForwardProbeState,
      })),
    });

    // =========================================================================
    // DURABLE STATE TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_state_save",
      description: "Persist durable agent state to local JSON and mirror a human-readable summary to workspace STATE.md (~/.openclaw/workspace/STATE.md). Deep merge: new keys are added, existing keys updated, omitted keys preserved. Does not overwrite the agent's MEMORY.md. Use for: strategy weights cache, watchlists, running counters, regime observations, any data that must survive session boundaries.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent ID whose state to save (must match calling agent)." }),
        state: Type.Unknown({ description: "JSON object to deep-merge into existing state. New keys are added, existing keys are updated, omitted keys are preserved." }),
        overwrite: Type.Optional(Type.Boolean({ description: "If true, replace entire state instead of merging. Default false." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const targetAgentId = sanitizeAgentId(String(params.agentId));
        const filePath = path.join(stateDir, `${targetAgentId}.json`);
        const shouldOverwrite = Boolean(params.overwrite);
        let mergedState: unknown;
        if (shouldOverwrite) {
          mergedState = params.state;
        } else {
          const existing = readJsonFile(filePath) as { state?: Record<string, unknown> } | null;
          const existingState = (existing?.state && typeof existing.state === "object") ? existing.state : {};
          const newState = (params.state && typeof params.state === "object") ? params.state as Record<string, unknown> : params.state;
          if (typeof existingState === "object" && typeof newState === "object" && newState !== null) {
            mergedState = deepMerge(existingState as Record<string, unknown>, newState as Record<string, unknown>);
          } else {
            mergedState = newState;
          }
        }
        const payload = { agentId: targetAgentId, state: mergedState, updatedAt: new Date().toISOString() };
        writeJsonFile(filePath, payload);
        writeStateMd(targetAgentId, mergedState);
        return { ok: true, agentId: targetAgentId, updatedAt: payload.updatedAt, merged: !shouldOverwrite, stateMdWritten: true };
      }),
    });

    api.registerTool({
      name: "solana_state_read",
      description: "Read durable agent state from local storage. Returns the last saved state object or null if no state exists. Also auto-injected at bootstrap — this tool is for mid-session reads.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent ID whose state to read." }),
      }),
      execute: wrapExecute(async (_id, params) => {
        const targetAgentId = sanitizeAgentId(String(params.agentId));
        const filePath = path.join(stateDir, `${targetAgentId}.json`);
        const data = readJsonFile(filePath);
        return data || { agentId: targetAgentId, state: null, updatedAt: null };
      }),
    });

    // =========================================================================
    // EPISODIC MEMORY TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_decision_log",
      description: "Append a structured decision entry to the agent's episodic decision log. Maintains the last 50 entries per agent (FIFO). Entries are auto-injected at bootstrap for session continuity. Use for: trade decisions, analysis conclusions, relay actions, skip reasons.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent ID writing the decision." }),
        type: Type.String({ description: "Decision type: 'trade_entry', 'trade_exit', 'skip', 'watch', 'relay', 'analysis', 'alert', 'cron_result'." }),
        token: Type.Optional(Type.String({ description: "Token mint address if decision relates to a specific token." })),
        rationale: Type.String({ description: "Brief reasoning for the decision (< 500 chars)." }),
        scores: Type.Optional(Type.Unknown({ description: "Relevant scores object (confidence, analyst scores, etc.)." })),
        outcome: Type.Optional(Type.String({ description: "Outcome if known: 'pending', 'win', 'loss', 'neutral'." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const targetAgentId = sanitizeAgentId(String(params.agentId));
        const logPath = path.join(logsDir, targetAgentId, "decisions.jsonl");
        const entry = {
          ts: new Date().toISOString(),
          agentId: targetAgentId,
          type: String(params.type),
          token: params.token ? String(params.token) : undefined,
          rationale: String(params.rationale),
          scores: params.scores || undefined,
          outcome: params.outcome ? String(params.outcome) : "pending",
        };
        const count = appendJsonlFile(logPath, entry, 50);
        return { ok: true, agentId: targetAgentId, entryCount: count };
      }),
    });

    // =========================================================================
    // TEAM BULLETIN TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_team_bulletin_post",
      description: "Post a finding or alert to the shared team bulletin board. All agents can read the bulletin. Maintains last 200 entries with 3-day retention. Use for: broadcasting discoveries, risk alerts, regime observations, cross-agent coordination signals.",
      parameters: Type.Object({
        fromAgent: Type.String({ description: "Posting agent's ID." }),
        type: Type.String({ description: "Bulletin type: 'discovery', 'risk_alert', 'regime_shift', 'position_update', 'convergence', 'exhaustion', 'whale_move', 'source_rep_update', 'pattern_match'." }),
        priority: Type.String({ description: "Priority: 'low', 'medium', 'high', 'critical'." }),
        payload: Type.Unknown({ description: "Structured payload relevant to the bulletin type." }),
      }),
      execute: wrapExecute(async (_id, params) => {
        const fromAgent = sanitizeAgentId(String(params.fromAgent));
        const bulletinPath = path.join(sharedLogsDir, "team-bulletin.jsonl");
        const now = new Date();
        const entry = {
          ts: now.toISOString(),
          fromAgent,
          type: String(params.type),
          priority: String(params.priority),
          payload: params.payload,
        };
        let entries = readJsonlFile(bulletinPath) as { ts: string }[];
        const threeDaysAgo = now.getTime() - (3 * 24 * 60 * 60 * 1000);
        entries = entries.filter((e) => new Date(e.ts).getTime() > threeDaysAgo);
        entries.push(entry as { ts: string });
        if (entries.length > 200) entries = entries.slice(-200);
        fs.writeFileSync(bulletinPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
        return { ok: true, entryCount: entries.length };
      }),
    });

    api.registerTool({
      name: "solana_team_bulletin_read",
      description: "Read entries from the shared team bulletin board with optional filters. Returns entries in chronological order.",
      parameters: Type.Object({
        since: Type.Optional(Type.String({ description: "ISO timestamp — only return entries after this time." })),
        fromAgent: Type.Optional(Type.String({ description: "Filter by posting agent ID." })),
        type: Type.Optional(Type.String({ description: "Filter by bulletin type." })),
        limit: Type.Optional(Type.Number({ description: "Max entries to return (default 50)." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const bulletinPath = path.join(sharedLogsDir, "team-bulletin.jsonl");
        let entries = readJsonlFile(bulletinPath) as Record<string, unknown>[];
        if (params.since) {
          const sinceTs = new Date(String(params.since)).getTime();
          entries = entries.filter((e) => new Date(String(e.ts)).getTime() > sinceTs);
        }
        if (params.fromAgent) entries = entries.filter((e) => e.fromAgent === String(params.fromAgent));
        if (params.type) entries = entries.filter((e) => e.type === String(params.type));
        const limit = typeof params.limit === "number" ? params.limit : 50;
        return { entries: entries.slice(-limit), total: entries.length };
      }),
    });

    // =========================================================================
    // CONTEXT SNAPSHOT TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_context_snapshot_write",
      description: "Write the portfolio context snapshot. CTO writes this at the end of each session to give all agents a consistent world-view at next bootstrap. Contains: open positions, capital state, active regime, recent decisions summary, strategy version.",
      parameters: Type.Object({
        snapshot: Type.Unknown({ description: "Context snapshot object with positions, capital, regime, strategyVersion, activeSubscriptions, recentDecisions summary." }),
      }),
      execute: wrapExecute(async (_id, params) => {
        const filePath = path.join(stateDir, "context-snapshot.json");
        const payload = { snapshot: params.snapshot, writtenBy: agentId, ts: new Date().toISOString() };
        writeJsonFile(filePath, payload);
        return { ok: true, ts: payload.ts };
      }),
    });

    api.registerTool({
      name: "solana_context_snapshot_read",
      description: "Read the latest portfolio context snapshot written by the CTO. Provides a consistent world-view: open positions, capital, regime, strategy version. Also auto-injected at bootstrap.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => {
        const filePath = path.join(stateDir, "context-snapshot.json");
        const data = readJsonFile(filePath);
        return data || { snapshot: null, ts: null };
      }),
    });

    // =========================================================================
    // DETERMINISTIC COMPUTE TOOLS (Anti-Hallucination)
    // =========================================================================

    api.registerTool({
      name: "solana_compute_confidence",
      description: "Deterministic confidence score computation. Applies the V2 weighted formula with convergence bonus and risk penalty. Returns the computed score with full breakdown — no hallucination possible.",
      parameters: Type.Object({
        onchainScore: Type.Number({ description: "On-Chain Analyst score (0.0-1.0)." }),
        signalScore: Type.Number({ description: "Alpha Signal Analyst score (0.0-1.0)." }),
        socialScore: Type.Optional(Type.Number({ description: "Social Intelligence Analyst score (0.0-1.0). Default 0." })),
        smartMoneyScore: Type.Optional(Type.Number({ description: "Smart Money Tracker score (0.0-1.0). Default 0." })),
        riskPenalty: Type.Number({ description: "Risk penalty from Risk Officer flags, hardDeny, manipulation, liquidity, front-running, late freshness." }),
        weights: Type.Optional(Type.Object({
          onchain: Type.Optional(Type.Number()),
          signal: Type.Optional(Type.Number()),
          social: Type.Optional(Type.Number()),
          smart: Type.Optional(Type.Number()),
        }, { description: "Custom weights. Default: onchain=0.45, signal=0.35, social=0.05, smart=0.15." })),
        convergenceSources: Type.Optional(Type.Number({ description: "Number of independent discovery sources that flagged same token. 2=+0.15, 3=+0.20, 4+=+0.25." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const onchain = Number(params.onchainScore) || 0;
        const signal = Number(params.signalScore) || 0;
        const social = Number(params.socialScore) || 0;
        const smart = Number(params.smartMoneyScore) || 0;
        const penalty = Number(params.riskPenalty) || 0;
        const w = params.weights as Record<string, number> | undefined;
        const wOnchain = w?.onchain ?? 0.45;
        const wSignal = w?.signal ?? 0.35;
        const wSocial = w?.social ?? 0.05;
        const wSmart = w?.smart ?? 0.15;
        const sources = Number(params.convergenceSources) || 0;
        let convergenceBonus = 0;
        if (sources >= 4) convergenceBonus = 0.25;
        else if (sources >= 3) convergenceBonus = 0.20;
        else if (sources >= 2) convergenceBonus = 0.15;
        const raw = (wOnchain * onchain) + (wSignal * signal) + (wSocial * social) + (wSmart * smart);
        const confidence = Math.max(0, Math.min(1, raw - penalty + convergenceBonus));
        return {
          confidence: Math.round(confidence * 10000) / 10000,
          raw: Math.round(raw * 10000) / 10000,
          convergenceBonus,
          riskPenalty: penalty,
          weights: { onchain: wOnchain, signal: wSignal, social: wSocial, smart: wSmart },
          components: {
            onchain: Math.round(wOnchain * onchain * 10000) / 10000,
            signal: Math.round(wSignal * signal * 10000) / 10000,
            social: Math.round(wSocial * social * 10000) / 10000,
            smart: Math.round(wSmart * smart * 10000) / 10000,
          },
          formula: `(${wOnchain}×${onchain}) + (${wSignal}×${signal}) + (${wSocial}×${social}) + (${wSmart}×${smart}) - ${penalty} + ${convergenceBonus} = ${confidence.toFixed(4)}`,
        };
      }),
    });

    api.registerTool({
      name: "solana_compute_freshness_decay",
      description: "Compute signal freshness decay factor based on signal age. Returns a 0.0-1.0 multiplier and age category. Deterministic — no API calls.",
      parameters: Type.Object({
        signalAgeMinutes: Type.Number({ description: "Age of the signal in minutes since original call." }),
        signalType: Type.Optional(Type.String({ description: "Signal type: 'ca_drop' (default), 'exit', 'sentiment', 'confirmation'." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const age = Number(params.signalAgeMinutes) || 0;
        const signalType = String(params.signalType || "ca_drop");
        let decay = 1.0;
        let category = "EARLY";
        let recommendation = "PROCEED";
        if (signalType === "exit" || signalType === "sentiment") {
          if (age <= 5) { decay = 1.0; category = "IMMEDIATE"; }
          else if (age <= 15) { decay = 0.8; category = "RECENT"; }
          else if (age <= 30) { decay = 0.5; category = "AGING"; recommendation = "REDUCE_WEIGHT"; }
          else { decay = 0.2; category = "STALE"; recommendation = "SKIP"; }
        } else {
          if (age <= 3) { decay = 1.0; category = "EARLY"; }
          else if (age <= 10) { decay = 0.9; category = "ONTIME"; }
          else if (age <= 30) { decay = 0.7; category = "LATE"; recommendation = "REDUCE_SIZE"; }
          else if (age <= 60) { decay = 0.4; category = "VERY_LATE"; recommendation = "WATCH_ONLY"; }
          else { decay = 0.1; category = "STALE"; recommendation = "SKIP"; }
        }
        return { decayFactor: decay, ageMinutes: age, ageCategory: category, recommendation, signalType };
      }),
    });

    api.registerTool({
      name: "solana_compute_position_limits",
      description: "Compute final position size after all stacked reductions. Applies mode-based range → Risk Officer cap → precheck cap → liquidity hard cap → reduction triggers → floor. Returns sizeSol with full reduction breakdown. Deterministic.",
      parameters: Type.Object({
        mode: Type.String({ description: "'HARDENED' or 'DEGEN'." }),
        confidence: Type.Number({ description: "Confidence score (0.0-1.0)." }),
        capitalSol: Type.Number({ description: "Total available capital in SOL." }),
        poolDepthUsd: Type.Number({ description: "Pool liquidity depth in USD." }),
        solPriceUsd: Type.Number({ description: "Current SOL price in USD for pool-depth conversion." }),
        lifecycle: Type.String({ description: "'FRESH', 'EMERGING', or 'ESTABLISHED'." }),
        winRateLast10: Type.Optional(Type.Number({ description: "Win rate over last 10 trades (0.0-1.0)." })),
        dailyNotionalUsedPct: Type.Optional(Type.Number({ description: "Daily notional used as percentage (0-100)." })),
        consecutiveLosses: Type.Optional(Type.Number({ description: "Current consecutive loss count." })),
        openPositionCount: Type.Optional(Type.Number({ description: "Number of open positions." })),
        tokenConcentrationPct: Type.Optional(Type.Number({ description: "Token concentration percentage (0-100)." })),
        priceMovePct: Type.Optional(Type.Number({ description: "Token price move percentage from recent low." })),
        riskOfficerMaxSizeSol: Type.Optional(Type.Number({ description: "Risk Officer's maxSizeSol cap." })),
        precheckCappedSizeSol: Type.Optional(Type.Number({ description: "Precheck cappedSizeSol." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const mode = String(params.mode).toUpperCase();
        const isHardened = mode === "HARDENED";
        const confidence = Number(params.confidence) || 0;
        const capital = Number(params.capitalSol) || 0;
        const poolUsd = Number(params.poolDepthUsd) || 0;
        const solPrice = Number(params.solPriceUsd) || 1;
        const lifecycle = String(params.lifecycle).toUpperCase();
        const reductions: { factor: number; reason: string }[] = [];
        const highMin = isHardened ? 0.10 : 0.12;
        const highMax = isHardened ? 0.20 : 0.25;
        const exploMin = isHardened ? 0.03 : 0.05;
        const exploMax = isHardened ? 0.08 : 0.10;
        const isHighConf = confidence > 0.75;
        let baseMin = isHighConf ? highMin : exploMin;
        let baseMax = isHighConf ? highMax : exploMax;
        if (lifecycle === "FRESH") {
          baseMin = exploMin;
          baseMax = isHardened ? 0.05 : exploMax;
        }
        let sizeSol = capital * ((baseMin + baseMax) / 2);
        const riskMax = params.riskOfficerMaxSizeSol != null ? Number(params.riskOfficerMaxSizeSol) : Infinity;
        if (riskMax < sizeSol) { reductions.push({ factor: riskMax / sizeSol, reason: "Risk Officer maxSizeSol cap" }); sizeSol = riskMax; }
        const precheckCap = params.precheckCappedSizeSol != null ? Number(params.precheckCappedSizeSol) : Infinity;
        if (precheckCap < sizeSol) { reductions.push({ factor: precheckCap / sizeSol, reason: "Precheck cappedSizeSol" }); sizeSol = precheckCap; }
        const poolCapSol = (poolUsd * 0.02) / solPrice;
        const poolHardCapSol = poolUsd < 50000 ? 1000 / solPrice : Infinity;
        const effectivePoolCap = Math.min(poolCapSol, poolHardCapSol);
        if (effectivePoolCap < sizeSol) { reductions.push({ factor: effectivePoolCap / sizeSol, reason: poolUsd < 50000 ? "Pool < $50K hard cap ($1K max)" : "2% pool depth cap" }); sizeSol = effectivePoolCap; }
        const wr = params.winRateLast10 != null ? Number(params.winRateLast10) : 1;
        if (wr < 0.4) { sizeSol *= 0.6; reductions.push({ factor: 0.6, reason: "Win rate < 40%" }); }
        const dnPct = params.dailyNotionalUsedPct != null ? Number(params.dailyNotionalUsedPct) : 0;
        if (dnPct > 70) { sizeSol *= 0.5; reductions.push({ factor: 0.5, reason: "Daily notional > 70%" }); }
        const consLoss = params.consecutiveLosses != null ? Number(params.consecutiveLosses) : 0;
        if (consLoss >= 2) { sizeSol *= 0.7; reductions.push({ factor: 0.7, reason: `${consLoss} consecutive losses` }); }
        const openPos = params.openPositionCount != null ? Number(params.openPositionCount) : 0;
        if (openPos >= 3) { sizeSol *= 0.8; reductions.push({ factor: 0.8, reason: `${openPos} open positions` }); }
        const concPct = params.tokenConcentrationPct != null ? Number(params.tokenConcentrationPct) : 0;
        if (concPct > 30) { sizeSol *= 0.5; reductions.push({ factor: 0.5, reason: "Token concentration > 30%" }); }
        const pricePct = params.priceMovePct != null ? Number(params.priceMovePct) : 0;
        if (pricePct > 200) { sizeSol *= 0.5; reductions.push({ factor: 0.5, reason: "Token moved +200%" }); }
        const floorPct = isHardened ? 0.0075 : 0.0125;
        const floor = capital * floorPct;
        if (sizeSol < floor) { sizeSol = floor; reductions.push({ factor: 1, reason: `Floor applied: ${(floorPct * 100).toFixed(2)}% of capital` }); }
        return {
          sizeSol: Math.round(sizeSol * 10000) / 10000,
          mode,
          baseRange: { min: baseMin, max: baseMax },
          poolCap: Math.round(effectivePoolCap * 10000) / 10000,
          floor: Math.round(floor * 10000) / 10000,
          reductions,
        };
      }),
    });

    api.registerTool({
      name: "solana_classify_deployer_risk",
      description: "Classify deployer wallet risk level based on history. Returns risk class, score, and flags. Deterministic computation — no API calls.",
      parameters: Type.Object({
        previousTokens: Type.Number({ description: "Number of tokens previously deployed by this wallet." }),
        rugHistory: Type.Boolean({ description: "Whether any previous token was a confirmed rug." }),
        avgTokenLifespanHours: Type.Optional(Type.Number({ description: "Average lifespan of previous tokens in hours." })),
        freshWalletSurge: Type.Optional(Type.Number({ description: "Fresh wallet surge ratio (0.0-1.0) for this deployer's tokens." })),
        devSoldEarlyCount: Type.Optional(Type.Number({ description: "Number of previous tokens where dev sold within first hour." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const prev = Number(params.previousTokens) || 0;
        const rugged = Boolean(params.rugHistory);
        const avgLife = params.avgTokenLifespanHours != null ? Number(params.avgTokenLifespanHours) : null;
        const freshSurge = params.freshWalletSurge != null ? Number(params.freshWalletSurge) : 0;
        const devSold = params.devSoldEarlyCount != null ? Number(params.devSoldEarlyCount) : 0;
        const flags: string[] = [];
        let score = 0;
        if (rugged) { score += 40; flags.push("CONFIRMED_RUG_HISTORY"); }
        if (prev >= 10) { score += 20; flags.push("SERIAL_DEPLOYER"); }
        else if (prev >= 5) { score += 10; flags.push("FREQUENT_DEPLOYER"); }
        if (avgLife !== null && avgLife < 2) { score += 15; flags.push("SHORT_LIVED_TOKENS"); }
        if (freshSurge > 0.5) { score += 15; flags.push("HIGH_FRESH_WALLET_SURGE"); }
        if (devSold > 0 && prev > 0 && devSold / prev > 0.5) { score += 10; flags.push("FREQUENT_EARLY_DEV_SELLS"); }
        let riskClass: string;
        if (score >= 50) riskClass = "CRITICAL";
        else if (score >= 30) riskClass = "HIGH";
        else if (score >= 15) riskClass = "MODERATE";
        else riskClass = "LOW";
        return { riskClass, score, flags, inputs: { previousTokens: prev, rugHistory: rugged, avgTokenLifespanHours: avgLife, freshWalletSurge: freshSurge, devSoldEarlyCount: devSold } };
      }),
    });

    // =========================================================================
    // DEEP ANALYSIS TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_history_export",
      description: "Export comprehensive historical data for analysis: local decision logs + server-side closed trades + memory entries + strategy evolution history. Supports filtering by agent, time range, decision type, and token. Designed for deep analysis with full lookback depth.",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String({ description: "Agent ID to export local logs for. Defaults to configured agent." })),
        since: Type.Optional(Type.String({ description: "ISO timestamp — only export entries after this time." })),
        before: Type.Optional(Type.String({ description: "ISO timestamp — only export entries before this time." })),
        decisionType: Type.Optional(Type.String({ description: "Filter local decisions by type (e.g., 'trade_entry', 'trade_exit', 'analysis')." })),
        token: Type.Optional(Type.String({ description: "Filter decisions and memory by token mint address." })),
        includeState: Type.Optional(Type.Boolean({ description: "Include agent durable state. Default true." })),
        includeBulletin: Type.Optional(Type.Boolean({ description: "Include team bulletin entries. Default false." })),
        includePatterns: Type.Optional(Type.Boolean({ description: "Include named patterns. Default false." })),
        includeTrades: Type.Optional(Type.Boolean({ description: "Include server-side closed trade history (via /api/trades). Default true." })),
        includeMemory: Type.Optional(Type.Boolean({ description: "Include server-side memory entries matching filters (via /api/memory/search). Default false." })),
        includeStrategy: Type.Optional(Type.Boolean({ description: "Include server-side strategy state and weight history (via /api/strategy/state). Default false." })),
        memoryTags: Type.Optional(Type.String({ description: "Comma-separated memory tags to search (used with includeMemory). Default: 'learning_entry,strategy_evolution,pattern_detection'." })),
        limit: Type.Optional(Type.Number({ description: "Max decision entries (local logs). Default 50." })),
        offset: Type.Optional(Type.Number({ description: "Skip first N decision entries. Default 0." })),
        tradesLimit: Type.Optional(Type.Number({ description: "Max closed trades to fetch. Default 100." })),
        tradesPage: Type.Optional(Type.Number({ description: "Page number for trade pagination (1-based). Default 1." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const targetAgentId = sanitizeAgentId(params.agentId ? String(params.agentId) : agentId);
        const sinceTs = params.since ? new Date(String(params.since)).getTime() : 0;
        const beforeTs = params.before ? new Date(String(params.before)).getTime() : Infinity;
        const filterType = params.decisionType ? String(params.decisionType) : null;
        const filterToken = params.token ? String(params.token) : null;
        const maxEntries = typeof params.limit === "number" ? params.limit : 50;
        const skipEntries = typeof params.offset === "number" ? params.offset : 0;
        const includeState = params.includeState !== false;
        const shouldFetchTrades = params.includeTrades !== false;
        const shouldFetchMemory = Boolean(params.includeMemory);
        const shouldFetchStrategy = Boolean(params.includeStrategy);

        const logPath = path.join(logsDir, targetAgentId, "decisions.jsonl");
        let decisions = readJsonlFile(logPath) as { ts: string; type?: string; token?: string }[];
        if (sinceTs > 0) decisions = decisions.filter((d) => new Date(d.ts).getTime() > sinceTs);
        if (beforeTs < Infinity) decisions = decisions.filter((d) => new Date(d.ts).getTime() < beforeTs);
        if (filterType) decisions = decisions.filter((d) => d.type === filterType);
        if (filterToken) decisions = decisions.filter((d) => d.token === filterToken);
        const totalFiltered = decisions.length;
        decisions = decisions.slice(skipEntries, skipEntries + maxEntries);

        const agentResult: Record<string, unknown> = {
          decisions,
          decisionCount: decisions.length,
          totalFiltered,
        };
        if (includeState) {
          const statePath = path.join(stateDir, `${targetAgentId}.json`);
          agentResult.state = readJsonFile(statePath);
        }

        const exportResult: Record<string, unknown> = {
          agents: { [targetAgentId]: agentResult },
          exportedAt: new Date().toISOString(),
        };
        exportResult.contextSnapshot = readJsonFile(path.join(stateDir, "context-snapshot.json"));

        if (params.includeBulletin) {
          let bulletin = readJsonlFile(path.join(sharedLogsDir, "team-bulletin.jsonl")) as { ts: string }[];
          if (sinceTs > 0) bulletin = bulletin.filter((b) => new Date(b.ts).getTime() > sinceTs);
          if (beforeTs < Infinity) bulletin = bulletin.filter((b) => new Date(b.ts).getTime() < beforeTs);
          exportResult.bulletin = bulletin.slice(-maxEntries);
        }
        if (params.includePatterns) {
          exportResult.patterns = readJsonFile(path.join(stateDir, "patterns.json")) || {};
        }
        if (shouldFetchTrades) {
          try {
            const trLimit = typeof params.tradesLimit === "number" ? params.tradesLimit : 100;
            const trPage = typeof params.tradesPage === "number" ? params.tradesPage : 1;
            let tradePath = `/api/trades?walletId=${walletId}&limit=${trLimit}&page=${trPage}`;
            if (filterToken) tradePath += `&tokenAddress=${filterToken}`;
            const trades = await get(tradePath);
            exportResult.closedTrades = trades;
          } catch (err) {
            exportResult.closedTrades = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        if (shouldFetchMemory) {
          try {
            const tags = params.memoryTags
              ? String(params.memoryTags).split(",").map((t) => t.trim())
              : ["learning_entry", "strategy_evolution", "pattern_detection"];
            const memoryResults: unknown[] = [];
            for (const tag of tags) {
              try {
                const entries = await post("/api/memory/search", { query: tag, walletId });
                memoryResults.push({ tag, entries });
              } catch { /* skip failed tags */ }
            }
            exportResult.memoryEntries = memoryResults;
          } catch (err) {
            exportResult.memoryEntries = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        if (shouldFetchStrategy) {
          try {
            const strategyState = await get("/api/strategy/state");
            exportResult.strategyState = strategyState;
          } catch (err) {
            exportResult.strategyState = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        return exportResult;
      }),
    });

    api.registerTool({
      name: "solana_pattern_store",
      description: "Read, write, or list named trading patterns. Patterns are shared state used for pattern matching and strategy evolution.",
      parameters: Type.Object({
        action: Type.String({ description: "'read', 'write', or 'list'." }),
        patternId: Type.Optional(Type.String({ description: "Pattern identifier (required for read/write)." })),
        pattern: Type.Optional(Type.Unknown({ description: "Pattern object to store (required for write). Should include: name, description, conditions, expectedOutcome, confidence, sampleSize, discoveredAt." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        const action = String(params.action);
        const patternsPath = path.join(stateDir, "patterns.json");
        const patterns = (readJsonFile(patternsPath) as Record<string, unknown>) || {};
        if (action === "list") {
          const ids = Object.keys(patterns);
          return { patterns: ids.map((id) => ({ id, ...(patterns[id] as Record<string, unknown>) })), count: ids.length };
        }
        const patternId = params.patternId ? String(params.patternId) : null;
        if (!patternId) return { error: "patternId is required for read/write." };
        if (action === "read") {
          return patterns[patternId] ? { patternId, ...(patterns[patternId] as Record<string, unknown>) } : { patternId, found: false };
        }
        if (action === "write") {
          if (!params.pattern) return { error: "pattern object is required for write." };
          patterns[patternId] = { ...(params.pattern as Record<string, unknown>), updatedAt: new Date().toISOString() };
          writeJsonFile(patternsPath, patterns);
          return { ok: true, patternId, updatedAt: (patterns[patternId] as Record<string, unknown>).updatedAt };
        }
        return { error: `Unknown action: ${action}. Use 'read', 'write', or 'list'.` };
      }),
    });

    // =========================================================================
    // OPENCLAW NATIVE MEMORY TOOLS
    // =========================================================================

    api.registerTool({
      name: "solana_daily_log",
      description: "Append an entry to today's daily episodic log (memory/YYYY-MM-DD.md). OpenClaw auto-loads today + yesterday's log into context at every session start — no tool call needed to read them. Use at session end and after significant events. Auto-prunes logs older than 7 days.",
      parameters: Type.Object({
        summary: Type.String({ description: "Session summary or event description to log. Keep concise (1-5 lines)." }),
        tags: Type.Optional(Type.String({ description: "Comma-separated tags for categorization (e.g., 'trade,regime_shift,session_end')." })),
      }),
      execute: wrapExecute(async (_id, params) => {
        ensureDir(memoryDir);
        const now = new Date();
        const logPath = getDailyLogPath(now);
        const timeStr = now.toISOString().slice(11, 19);
        const tags = params.tags ? ` [${String(params.tags)}]` : "";
        const entry = `\n### ${timeStr} — ${agentId}${tags}\n\n${String(params.summary)}\n`;
        if (!fs.existsSync(logPath)) {
          const dateStr = now.toISOString().slice(0, 10);
          const header = `# Daily Log — ${dateStr}\n\n> Auto-generated by solana_daily_log. OpenClaw loads today + yesterday into context automatically.\n`;
          fs.writeFileSync(logPath, header + entry, "utf-8");
        } else {
          fs.appendFileSync(logPath, entry, "utf-8");
        }
        pruneDailyLogs(7);
        return { ok: true, date: now.toISOString().slice(0, 10), time: timeStr, agent: agentId };
      }),
    });

    // =========================================================================
    // AGENT BOOTSTRAP HOOK — Context Injection
    // =========================================================================

    api.registerHook("agent:bootstrap", async (context: { agentId?: string; bootstrapFiles?: { name: string; path: string; content: string; source: string }[] }) => {
      const bootAgentId = sanitizeAgentId(context.agentId || agentId);
      if (!context.bootstrapFiles) context.bootstrapFiles = [];

      try {
        const stateFile = path.join(stateDir, `${bootAgentId}.json`);
        const stateData = readJsonFile(stateFile);
        if (stateData) {
          context.bootstrapFiles.push({
            name: `${bootAgentId}-durable-state.json`,
            path: `state/${bootAgentId}.json`,
            content: JSON.stringify(stateData, null, 2),
            source: "solana-trader:state",
          });
        }
      } catch (err) {
        api.logger.warn(`[solana-trader] Bootstrap: failed to load state for ${bootAgentId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const logFile = path.join(logsDir, bootAgentId, "decisions.jsonl");
        const decisions = readJsonlFile(logFile, 50);
        if (decisions.length > 0) {
          context.bootstrapFiles.push({
            name: `${bootAgentId}-decision-log.jsonl`,
            path: `logs/${bootAgentId}/decisions.jsonl`,
            content: decisions.map((d) => JSON.stringify(d)).join("\n"),
            source: "solana-trader:decisions",
          });
        }
      } catch (err) {
        api.logger.warn(`[solana-trader] Bootstrap: failed to load decisions for ${bootAgentId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const bulletinFile = path.join(sharedLogsDir, "team-bulletin.jsonl");
        const allEntries = readJsonlFile(bulletinFile) as { ts: string }[];
        const windowMs = 6 * 60 * 60 * 1000;
        const cutoff = Date.now() - windowMs;
        const filtered = allEntries.filter((e) => new Date(e.ts).getTime() > cutoff);
        if (filtered.length > 0) {
          context.bootstrapFiles.push({
            name: "team-bulletin.jsonl",
            path: "logs/shared/team-bulletin.jsonl",
            content: filtered.map((e) => JSON.stringify(e)).join("\n"),
            source: "solana-trader:bulletin",
          });
        }
      } catch (err) {
        api.logger.warn(`[solana-trader] Bootstrap: failed to load bulletin for ${bootAgentId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      try {
        const snapshotFile = path.join(stateDir, "context-snapshot.json");
        const snapshot = readJsonFile(snapshotFile);
        if (snapshot) {
          context.bootstrapFiles.push({
            name: "context-snapshot.json",
            path: "state/context-snapshot.json",
            content: JSON.stringify(snapshot, null, 2),
            source: "solana-trader:snapshot",
          });
        }
      } catch (err) {
        api.logger.warn(`[solana-trader] Bootstrap: failed to load snapshot for ${bootAgentId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      let entitlementData: Record<string, unknown> | null = null;
      try {
        const liveResult = await get(`/api/entitlements/current?walletId=${walletId}`);
        if (liveResult && typeof liveResult === "object") {
          entitlementData = { ...(liveResult as Record<string, unknown>), source: "live-fetch", cachedAt: new Date().toISOString() };
          try {
            writeJsonFile(path.join(stateDir, "entitlement-cache.json"), entitlementData);
          } catch (_) { /* best-effort cache write */ }
        }
      } catch (fetchErr) {
        api.logger.warn(`[solana-trader] Bootstrap: live entitlement fetch failed for ${bootAgentId}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
      }
      if (!entitlementData) {
        try {
          const cached = readJsonFile(path.join(stateDir, "entitlement-cache.json"));
          if (cached && typeof cached === "object") {
            entitlementData = { ...(cached as Record<string, unknown>), source: "cache-fallback" };
          }
        } catch (_) { /* ignore */ }
      }
      if (!entitlementData) {
        try {
          const agentState = readJsonFile(path.join(stateDir, `${bootAgentId}.json`)) as { state?: Record<string, unknown> } | null;
          const s = agentState?.state;
          if (s && typeof s === "object" && "tier" in s) {
            entitlementData = { tier: s.tier, maxPositions: s.maxPositions, maxPositionSizeSol: s.maxPositionSizeSol, source: "durable-state-fallback", cachedAt: new Date().toISOString() };
          }
        } catch (_) { /* ignore */ }
      }
      if (!entitlementData) {
        entitlementData = { tier: "starter", maxPositions: 3, maxPositionSizeSol: 0.1, source: "conservative-default", cachedAt: new Date().toISOString() };
        api.logger.warn(`[solana-trader] Bootstrap: no entitlement source available for ${bootAgentId}, injecting conservative Starter defaults`);
      }
      context.bootstrapFiles.push({
        name: "active-entitlements.json",
        path: "state/entitlement-cache.json",
        content: JSON.stringify(entitlementData, null, 2),
        source: "solana-trader:entitlements",
      });

      api.logger.info(`[solana-trader] Bootstrap: injected ${context.bootstrapFiles.length} files for agent ${bootAgentId}`);
    });

    // =========================================================================
    // MEMORY FLUSH HOOK — Save Before Context Compaction
    //
    // Design notes:
    // 1. In-session state: The flush hook receives only { agentId } from
    //    OpenClaw — the plugin has NO access to the agent's runtime working
    //    state. Only the agent itself can persist state via solana_state_save.
    //    This hook is a safety net that ensures STATE.md stays in sync with
    //    the last persisted state on disk. The session-end checklist requires
    //    agents to call solana_state_save before flush would fire.
    // 2. Decision log: Each solana_decision_log call immediately POSTs to the
    //    server API — there is no local buffer of pending entries to flush.
    //    All decision entries are server-persisted at call time.
    // =========================================================================

    api.registerHook("memory:flush", async (context: { agentId?: string }) => {
      const flushAgentId = sanitizeAgentId(context.agentId || agentId);
      api.logger.info(`[solana-trader] Memory flush triggered for agent ${flushAgentId}`);
      try {
        const stateFile = path.join(stateDir, `${flushAgentId}.json`);
        const stateData = readJsonFile(stateFile) as { state?: Record<string, unknown> } | null;
        if (stateData?.state) {
          writeStateMd(flushAgentId, stateData.state);
          api.logger.info(`[solana-trader] Memory flush: STATE.md updated from persisted state for ${flushAgentId}`);
        } else {
          api.logger.info(`[solana-trader] Memory flush: no persisted state found for ${flushAgentId} — STATE.md not updated`);
        }
      } catch (err) {
        api.logger.warn(`[solana-trader] Memory flush: failed to write STATE.md for ${flushAgentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const now = new Date();
        ensureDir(memoryDir);
        const logPath = getDailyLogPath(now);
        const timeStr = now.toISOString().slice(11, 19);
        const entry = `\n### ${timeStr} — ${flushAgentId} [memory_flush]\n\nContext compaction triggered. STATE.md synced from last persisted state. Decision log entries are server-persisted (no local buffer to flush).\n`;
        if (!fs.existsSync(logPath)) {
          const dateStr = now.toISOString().slice(0, 10);
          const header = `# Daily Log — ${dateStr}\n\n> Auto-generated by solana_daily_log. OpenClaw loads today + yesterday into context automatically.\n`;
          fs.writeFileSync(logPath, header + entry, "utf-8");
        } else {
          fs.appendFileSync(logPath, entry, "utf-8");
        }
      } catch (err) {
        api.logger.warn(`[solana-trader] Memory flush: failed to write daily log for ${flushAgentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    api.registerService({
      id: "solana-trader-session",
      start: async () => {
        try {
          await sessionManager.initialize();
          const info = sessionManager.getSessionInfo();
          api.logger.info(
            `[solana-trader] Session active. Tier: ${info.tier}, Scopes: ${info.scopes.join(", ")}`,
          );
        } catch (err) {
          api.logger.error(
            `[solana-trader] Session initialization failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          api.logger.error(
            "[solana-trader] Trading tools will fail until session is established. User should run on this machine: traderclaw login (after logout) or traderclaw setup / traderclaw signup for a new account. Wallet proof uses local signing only — private key never leaves this system.",
          );
          return;
        }

        try {
          const healthz = await orchestratorRequest({
            baseUrl: orchestratorUrl,
            method: "GET",
            path: "/healthz",
            timeout: 5000,
            accessToken: await sessionManager.getAccessToken(),
          });
          api.logger.info(
            `[solana-trader] Orchestrator healthz OK at ${orchestratorUrl}`,
          );
          if (healthz && typeof healthz === "object") {
            const h = healthz as Record<string, unknown>;
            api.logger.info(
              `[solana-trader] Mode: ${h.executionMode || "unknown"}, Upstream: ${h.upstreamConfigured ? "yes" : "no"}`,
            );
          }
        } catch (err) {
          api.logger.warn(
            `[solana-trader] /healthz unreachable at ${orchestratorUrl}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        try {
          const status = await get("/api/system/status");
          api.logger.info(
            `[solana-trader] Connected to orchestrator (walletId: ${walletId})`,
          );
          if (status && typeof status === "object") {
            api.logger.info(`[solana-trader] System status: ${JSON.stringify(status)}`);
          }
        } catch (err) {
          api.logger.warn(
            `[solana-trader] /api/system/status unreachable: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        try {
          const startupGate = await runStartupGate({ autoFixGateway: true, force: true });
          api.logger.info(
            `[solana-trader] Startup gate completed: ok=${startupGate.ok}, passed=${startupGate.summary.passed}, failed=${startupGate.summary.failed}`,
          );
          if (!startupGate.ok) {
            api.logger.warn(
              `[solana-trader] Startup gate failures: ${JSON.stringify(startupGate.steps.filter((step) => !step.ok))}`,
            );
          }
        } catch (err) {
          api.logger.warn(
            `[solana-trader] Startup gate run failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        try {
          const probe = await runForwardProbe({
            agentId: config.agentId || "main",
            source: "service_startup",
          });
          api.logger.info(
            `[solana-trader] Forward probe result: ${JSON.stringify(probe)}`,
          );
        } catch (err) {
          api.logger.warn(
            `[solana-trader] Forward probe failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    });

    registerXTools(api, Type, config.xConfig, config.agentId || "main", "[solana-trader]");
    registerWebFetchTool(api, Type, "[solana-trader]");

    const xToolCount = config.xConfig?.ok ? 5 : 0;
    api.logger.info(
      `[solana-trader] Registered ${67 + xToolCount} tools (67 trading + ${xToolCount} X/Twitter) for walletId ${walletId} (session auth mode)`,
    );
  },
};

export default solanaTraderPlugin;
