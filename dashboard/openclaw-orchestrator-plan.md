# Objective

Build the **orchestrator backend + monitoring dashboard** for an OpenClaw-based autonomous Solana memecoin trading agent.

### How the pieces fit together
```
User installs OpenClaw plugin + skill
        ↓
OpenClaw Agent (brain: reasoning, strategy, self-improvement, personality)
        ↓ calls 18 typed tools via plugin
Orchestrator [THIS BUILD] (body: data, risk, entitlements, analysis, execution proxy)
        ↓ proxies trades to              ↓ queries market data from
SpyFly Bot (hands: on-chain execution)   Bitquery (eyes: real-time Solana data)
```

**In scope (this build):**
- Orchestrator API serving all 18 tool endpoints the OpenClaw agent calls
- Bitquery integration layer (GraphQL client + query builders)
- Risk engine (hard deny + soft flags, configurable)
- Kill switch management
- Entitlement system (plans, purchases, effective limits, spend guardrails)
- Trade thesis builder, pretrade check, execution proxy to SpyFly
- Memory/journal store for agent learning
- Dashboard UI showing wallet, positions, PnL, trades, risk denials, kill switch, entitlements, Kafka status, strategy state, limits/usage
- WebSocket for real-time dashboard updates
- PostgreSQL persistence

**Out of scope (other team):**
- SpyFly trading bot (wallet creation on-chain, buy/sell, SL/TP/trailing — called via HTTP)
- OpenClaw runtime itself (we just serve the endpoints its plugin calls)

# Tasks

### T001: Database Schema & Shared Types
- **Blocked By**: []
- **Details**:
  - Provision PostgreSQL database
  - Define complete schema in `shared/schema.ts` using Drizzle ORM:
    - `wallets` — id, userId, publicKey, label, strategyProfile, balanceLamports, status, createdAt, lastStopOutAt
    - `positions` — id, walletId, tokenAddress, symbol, side, sizeSol, entryPrice, currentPrice, unrealizedPnl, realizedPnl, managementMode (LOCAL/SERVER), status (open/closed/liquidated), slPct, tpLevels, trailingStopPct, deadlockState, createdAt, closedAt
    - `trades` — id, walletId, positionId, tokenAddress, side, sizeSol, price, slippageBps, orderId, txSignature, status, feesSol, createdAt
    - `entitlement_plans` — code, name, priceSol, durationHours, stackable, maxStack, limitsDelta, autoRenewAllowed
    - `entitlements` — id, walletId, planCode, purchasedAt, expiresAt, limitsDelta, active
    - `risk_denials` — id, walletId, tokenAddress, reason, ruleCode, severity, createdAt
    - `kill_switch_state` — walletId, mode, enabled, updatedAt
    - `memory_entries` — id, userId, walletId, tokenAddress, tags, notes, outcome, strategyVersion, createdAt
    - `strategy_state` — walletId, featureWeights, strategyVersion, updatedAt
  - Define all Zod insert/select schemas and exported TypeScript types matching the ZIP blueprint contracts
  - Run migration
  - Files: `shared/schema.ts`
  - Acceptance: All tables created, types exported, migration succeeds

### T002: Theme, Design System & App Shell
- **Blocked By**: []
- **Details**:
  - Dark trading terminal theme: deep dark background, green/red for profit/loss, blue accent for primary actions
  - Update color tokens in `tailwind.config.ts` and CSS variables in `client/src/index.css`
  - Build app shell with sidebar navigation + top header bar
  - Sidebar: Dashboard, Positions, Trade Log, Entitlements, Settings
  - Header: kill switch indicator, wallet balance badge, connection status dot
  - Dark mode as default (and only) mode for trading terminal aesthetic
  - Files: `tailwind.config.ts`, `client/src/index.css`, `client/src/App.tsx`, `client/src/components/app-sidebar.tsx`, `client/src/components/header.tsx`
  - Acceptance: Dark terminal shell renders, sidebar navigation works between stub pages

### T003: Orchestrator API — Wallet, Capital & Kill Switch
- **Blocked By**: [T001]
- **Details**:
  - Storage layer with PostgreSQL via Drizzle (replace MemStorage)
  - Routes:
    - `GET /api/capital/status?walletId=` → capital view
    - `POST /api/wallet/create` → create wallet record
    - `GET /api/funding/instructions?walletId=` → deposit info
    - `GET /api/wallet/positions?walletId=` → open positions
    - `POST /api/killswitch` → toggle kill switch (mode: TRADES_ONLY / TRADES_AND_STREAMS)
    - `GET /api/killswitch/status?walletId=` → current state
  - Kill switch persists to DB, enforced in subsequent trade endpoints
  - Files: `server/routes.ts`, `server/storage.ts`
  - Acceptance: All 6 endpoints return correct data, kill switch persists

### T004: Bitquery Integration & Market Intelligence
- **Blocked By**: [T001]
- **Details**:
  - Bitquery GraphQL client (`server/services/bitquery-client.ts`):
    - HTTP client for V2 `https://streaming.bitquery.io/graphql`
    - Bearer token auth via BITQUERY_API_KEY env var
    - Timeout + error handling
  - Query builders (`server/services/bitquery-queries.ts`):
    - Token snapshot (DEXTradeByTokens — price, volume, OHLC)
    - Holder profile (BalanceUpdates — top holders, dev %)
    - Flow profile (DEXTrades — buy/sell pressure, unique traders)
    - Liquidity profile (DEXPools — pool depth, locked %)
    - New launches (Instructions — Pump.fun/PumpSwap/Raydium creation events)
    - Hot pairs (DEXTradeByTokens — volume/price acceleration)
    - Market regime (aggregate DEX metrics)
  - Market intelligence service composing queries into normalized responses
  - Mock mode when BITQUERY_API_KEY not set (returns realistic fake data)
  - Routes:
    - `POST /api/scan/new-launches`
    - `POST /api/scan/hot-pairs`
    - `POST /api/market/regime`
    - `POST /api/token/snapshot`
    - `POST /api/token/holders`
    - `POST /api/token/flows`
    - `POST /api/token/liquidity`
    - `POST /api/token/risk`
  - Files: `server/services/bitquery-client.ts`, `server/services/bitquery-queries.ts`, `server/services/market-intel.ts`, `server/routes.ts`
  - Acceptance: All 8 endpoints respond with structured data (mock or real)

### T005: Risk Engine Service
- **Blocked By**: [T001]
- **Details**:
  - Risk engine (`server/services/risk-engine.ts`):
    - Hard deny rules with defaults:
      - Kill switch enabled → deny
      - Token on denylist → deny
      - Liquidity below $50k → deny
      - Max position $1k → deny
      - Max daily notional $5k → deny
      - Max daily loss $500 → deny
      - Max slippage 800bps → deny
    - Soft risk flags:
      - Top 10 holder concentration > 40% → deny/size-down
      - Dev holding > 10% → deny
      - Extreme volatility → size-down
      - Rapid liquidity drop (-30% in 60s) → deny
    - Returns structured `{ approved, reasons[], cappedSizeSol }` response
    - Logs all denials to `risk_denials` table
  - Files: `server/services/risk-engine.ts`
  - Acceptance: Risk engine correctly blocks/allows/sizes-down based on rules, denials logged

### T006: Trade Flow — Thesis, Precheck, Execute, Review
- **Blocked By**: [T003, T004, T005]
- **Details**:
  - Trade thesis builder (`server/services/thesis-builder.ts`):
    - Composes snapshot + holders + flow + liquidity + risk into scores
    - Returns: opportunityScore, confidenceScore, riskScore, shouldTrade, preferredAction (buy/watch/avoid), positionSizeSol, holdHorizon, thesis[], invalidation[]
  - Pretrade check:
    - Runs risk engine against proposed trade
    - Checks kill switch, balance, exposure, cooldown, blacklist
  - Trade executor (`server/services/trade-executor.ts`):
    - Proxies to SpyFly bot (BOT_API_BASE_URL env var)
    - Sends buy/sell with SL/TP/trailing params
    - Records trade + position in DB
    - Mock mode when BOT_API_BASE_URL not configured
  - Post-trade review: outcome vs thesis, stores to memory
  - Routes:
    - `POST /api/thesis/build`
    - `POST /api/trade/precheck`
    - `POST /api/trade/execute`
    - `POST /api/trade/review`
  - Files: `server/services/thesis-builder.ts`, `server/services/trade-executor.ts`, `server/routes.ts`
  - Acceptance: Full thesis → precheck → execute → review flow works

### T007: Entitlements & Memory/Journal
- **Blocked By**: [T001]
- **Details**:
  - Entitlement manager (`server/services/entitlement-manager.ts`):
    - `GET /api/entitlements/plans` → available plans
    - `GET /api/entitlements/current?walletId=` → active entitlements + effective limits
    - `POST /api/entitlements/purchase` → buy plan (atomic balance debit, idempotent)
    - Effective limits = base + sum(active limits_delta)
    - Expiry checks on each request
    - Spend guardrails: daily_max_sol, per_upgrade_max, cooldown_minutes
  - Memory store (`server/services/memory-store.ts`):
    - `POST /api/memory/write` → save note/outcome
    - `POST /api/memory/search` → search by query/tags
    - `POST /api/memory/journal-summary` → aggregate stats over lookback
  - Files: `server/services/entitlement-manager.ts`, `server/services/memory-store.ts`, `server/routes.ts`
  - Acceptance: Plans list, purchase works, limits compute correctly. Memory CRUD functional.

### T008: WebSocket Layer
- **Blocked By**: [T003]
- **Details**:
  - WebSocket server on existing HTTP server using `ws` package
  - Channels: positions, trades, risk-events, entitlements, system-status
  - Client hook `client/src/hooks/use-websocket.ts`
  - Backend broadcasts on state changes (new trade, position update, risk denial, kill switch toggle)
  - Files: `server/websocket.ts`, `client/src/hooks/use-websocket.ts`
  - Acceptance: Dashboard receives live updates without polling

### T009: Dashboard Page — Main Overview
- **Blocked By**: [T002, T003, T005, T007, T008]
- **Details**:
  - Main dashboard with all required panels:
    1. Wallet Balance (SOL + USD)
    2. Open Positions table (token, side, size, entry, current, unrealized PnL, exit mode LOCAL/SERVER, SL/TP/trailing params)
    3. PnL Summary (realized + unrealized + total, mini chart)
    4. Kill Switch toggle (big switch, mode selector, status)
    5. Entitlement Status (current level, active bundles, limits bars)
    6. Usage vs Limits (rolling 1m/5m gauges)
    7. Kafka Throughput (msgs/s, bytes/s, active topics)
    8. Strategy State (version, top feature weights, deadlock status)
    9. Quick Actions (scan launches, scan hot pairs, upgrade)
  - All panels use TanStack Query + WebSocket for real-time
  - Dark trading terminal aesthetic, green/red PnL, clean typography
  - Files: `client/src/pages/dashboard.tsx`, `client/src/components/dashboard/*`
  - Acceptance: All 9 panels render with data, real-time updates work

### T010: Secondary Pages — Trade Log, Positions, Entitlements, Settings
- **Blocked By**: [T009]
- **Details**:
  - **Trade Log** — full history table (time, token, side, size, price, fees, PnL, status), risk denial log, filters, pagination
  - **Positions** — detailed open + closed positions with per-position SL/TP/trailing/deadlock/management mode
  - **Entitlements** — plans + pricing, purchase flow, active entitlements with expiry countdown, upgrade history, auto-upgrade settings, spend caps
  - **Settings** — kill switch controls, risk params (read-only), connection status, strategy info
  - Register all routes in App.tsx
  - Files: `client/src/pages/trade-log.tsx`, `client/src/pages/positions.tsx`, `client/src/pages/entitlements.tsx`, `client/src/pages/settings.tsx`, `client/src/App.tsx`
  - Acceptance: All 4 pages render with data, navigation works, filters/pagination functional

### T011: Seed Data & Visual Polish
- **Blocked By**: [T006, T009, T010]
- **Details**:
  - Seed DB with realistic demo data:
    - 1 wallet with 5 SOL
    - 3 open positions (different tokens, mixed PnL)
    - 10 historical trades (wins + losses)
    - Default entitlement plans (bandwidth boost, subscription expansion, topic unlock)
    - 2 active entitlements
    - 5 risk denials
    - 3 memory entries
    - Kill switch off
    - Strategy state with sample feature weights
  - Polish: loading skeletons, error states with retry, empty states, number formatting (SOL/USD/%), relative timestamps, smooth page transitions
  - Files: `server/seed.ts`, component files
  - Acceptance: App loads with beautiful realistic data, all states polished

### T012: Integration Test & Code Review
- **Blocked By**: [T011]
- **Details**:
  - End-to-end testing: dashboard → positions → trade log → entitlements → settings
  - API testing: all 18+ endpoints respond correctly
  - Kill switch toggle works
  - Entitlement purchase flow works
  - WebSocket updates work
  - Architect code review
  - Fix severe issues
  - Files: All
  - Acceptance: Full app works, no crashes, all pages functional, review passes
