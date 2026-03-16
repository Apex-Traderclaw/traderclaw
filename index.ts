import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { orchestratorRequest } from "./src/http-client.js";
import { SessionManager } from "./src/session-manager.js";
import { AlphaBuffer } from "./src/alpha-buffer.js";
import { AlphaStreamManager } from "./src/alpha-ws.js";

interface PluginConfig {
  orchestratorUrl: string;
  walletId: string;
  apiKey: string;
  externalUserId?: string;
  refreshToken?: string;
  walletPublicKey?: string;
  walletPrivateKey?: string;
  apiTimeout?: number;
  agentId?: string;
  gatewayBaseUrl?: string;
  gatewayToken?: string;
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
  const walletPrivateKey = typeof obj.walletPrivateKey === "string" ? obj.walletPrivateKey : undefined;
  const apiTimeout = typeof obj.apiTimeout === "number" ? obj.apiTimeout : 30000;
  const agentId = typeof obj.agentId === "string" ? obj.agentId : undefined;
  const gatewayBaseUrl = typeof obj.gatewayBaseUrl === "string" ? obj.gatewayBaseUrl : undefined;
  const gatewayToken = typeof obj.gatewayToken === "string" ? obj.gatewayToken : undefined;
  return {
    orchestratorUrl,
    walletId,
    apiKey,
    externalUserId,
    refreshToken,
    walletPublicKey,
    walletPrivateKey,
    apiTimeout,
    agentId,
    gatewayBaseUrl,
    gatewayToken,
  };
}

const solanaTraderPlugin = {
  id: "solana-trader",
  name: "Solana Trader",
  description: "Autonomous Solana memecoin trading agent — orchestrator integration",

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig);
    const { orchestratorUrl, walletId, apiKey, apiTimeout } = config;

    if (!orchestratorUrl) {
      api.logger.error("[solana-trader] orchestratorUrl is required in plugin config. Run: openclaw-trader setup");
      return;
    }

    if (!apiKey && !config.refreshToken) {
      api.logger.error("[solana-trader] apiKey or refreshToken is required in plugin config. Run: openclaw-trader setup");
      return;
    }

    const sessionManager = new SessionManager({
      baseUrl: orchestratorUrl,
      apiKey: apiKey || "",
      refreshToken: config.refreshToken,
      walletPublicKey: config.walletPublicKey,
      walletPrivateKey: config.walletPrivateKey,
      clientLabel: "openclaw-plugin-runtime",
      timeout: apiTimeout,
      onTokensRotated: (tokens) => {
        api.logger.info(
          `[solana-trader] Session tokens rotated. New refreshToken: ${tokens.refreshToken.slice(0, 8)}... ` +
          `Update config with: openclaw-trader config set refreshToken ${tokens.refreshToken}`
        );
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
      description: "Pre-trade risk check — validates a proposed trade against risk rules, kill switch, entitlement limits, and on-chain conditions. Returns approved/denied with reasons and capped size. Always call this before executing a trade.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
        side: Type.Union([Type.Literal("buy"), Type.Literal("sell")], { description: "Trade direction" }),
        sizeSol: Type.Number({ description: "Intended position size in SOL" }),
        slippageBps: Type.Optional(Type.Number({ description: "Slippage tolerance in basis points (e.g., 300 = 3%)" })),
      }),
      execute: wrapExecute(async (_id, params) =>
        post("/api/trade/precheck", {
          tokenAddress: params.tokenAddress,
          side: params.side,
          sizeSol: params.sizeSol,
          slippageBps: params.slippageBps,
        }),
      ),
    });

    api.registerTool({
      name: "solana_trade_execute",
      description: "Execute a trade on Solana via the SpyFly bot. Enforces risk rules before proxying to on-chain execution. Returns trade ID, position ID, and transaction signature.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
        side: Type.Union([Type.Literal("buy"), Type.Literal("sell")], { description: "Trade direction" }),
        sizeSol: Type.Number({ description: "Position size in SOL" }),
        symbol: Type.String({ description: "Token symbol (e.g., BONK, WIF)" }),
        slippageBps: Type.Optional(Type.Number({ description: "Slippage in basis points (default: 300)" })),
        slPct: Type.Optional(Type.Number({ description: "Stop-loss percentage (e.g., 15 = 15% below entry)" })),
        tpLevels: Type.Optional(Type.Array(Type.Number(), { description: "Take-profit levels as percentages (e.g., [25, 50, 100])" })),
        trailingStopPct: Type.Optional(Type.Number({ description: "Trailing stop percentage" })),
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
        return post("/api/trade/execute", {
          tokenAddress: params.tokenAddress,
          side: params.side,
          sizeSol: params.sizeSol,
          symbol: params.symbol,
          slippageBps: params.slippageBps,
          slPct: params.slPct,
          tpLevels: params.tpLevels,
          trailingStopPct: params.trailingStopPct,
          managementMode: params.managementMode,
        }, Object.keys(headers).length > 0 ? headers : undefined);
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
      execute: wrapExecute(async () =>
        get(`/api/entitlements/current?walletId=${walletId}`),
      ),
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
        startupGateState = {
          ok: failed === 0,
          ts: Date.now(),
          steps,
        };
        return {
          ok: startupGateState.ok,
          ts: startupGateState.ts,
          steps,
          summary: { passed, failed },
        };
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
      description: "Check orchestrator system health — uptime, connected services, database status, execution mode (mock/live), and upstream API connectivity.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => get("/api/system/status")),
    });

    api.registerTool({
      name: "solana_startup_gate",
      description: "Run the mandatory startup sequence and return deterministic pass/fail results per step. Optionally auto-fixes gateway credentials if gatewayBaseUrl and gatewayToken are present in plugin config.",
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
            "[solana-trader] Trading tools will fail until session is established. Run: openclaw-trader setup",
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

    api.logger.info(
      `[solana-trader] Registered 52 trading tools for walletId ${walletId} (session auth mode)`,
    );
  },
};

export default solanaTraderPlugin;
