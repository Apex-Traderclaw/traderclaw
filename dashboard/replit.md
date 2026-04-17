# OpenClaw Solana Trading Agent Orchestrator

## Architecture
```
OpenClaw Agent (brain: reasoning, strategy, self-improvement, local memory)
        ↓ calls 26 typed tools via plugin
Orchestrator [this project] (body: data assembly, risk enforcement, entitlements, execution proxy)
        ↓ proxies trades to              ↓ queries market data from
SpyFly Bot (hands: on-chain execution)   Bitquery (eyes: real-time Solana data)
```

### Dual-Mode Operation
The orchestrator supports two modes for outbound calls (Bitquery + trade execution):

**Mock mode** (default, no external services needed):
- Trade execution returns simulated results
- Bitquery queries return mock data
- All local features work (memory, strategy, thesis, dashboard)

**Upstream proxy mode** (when `UPSTREAM_API_URL` is set AND `OPENCLAW_EXECUTION_MODE=live`):
- Bitquery queries route through upstream `/api/bitquery/query` with HMAC signing
- Trade execution routes through upstream `/api/trade/execute` with HMAC + idempotency key
- Returns explicit errors (with structured error codes) if upstream is unreachable

**Design principle**: The orchestrator gathers data, enforces rules, and manages state.
It never makes trading decisions — that's OpenClaw's job. OpenClaw has a large context
window and long-term memory; it evolves its strategy locally and uses the orchestrator
to assemble market data, check risk, and execute trades.

## Tech Stack
- **Backend**: Express + TypeScript + Drizzle ORM + PostgreSQL
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui + wouter + TanStack Query
- **Real-time**: WebSocket (`ws` package) on `/ws` endpoint
- **Database**: PostgreSQL via Drizzle ORM

## Project Structure
```
shared/schema.ts          - All Drizzle ORM tables + Zod schemas + TypeScript types
server/
  index.ts                - Express server entry point, seeds DB on startup
  db.ts                   - Drizzle database connection
  storage.ts              - DatabaseStorage class implementing IStorage interface
  routes.ts               - All API routes (33 endpoints including /healthz)
  errors.ts               - Structured error codes + apiError() helper
  websocket.ts            - WebSocket manager for real-time broadcasting
  seed.ts                 - Seed data for demo/development
  services/
    upstream-client.ts    - HMAC-signed HTTP client for other team's API (Bitquery + trade proxy)
    bitquery-client.ts    - Bitquery client (direct or upstream proxy mode)
    bitquery-queries.ts   - GraphQL query templates for Solana data
    market-intel.ts       - Market intelligence service (snapshot, holders, flows, liquidity, launches, hot pairs, regime, risk)
    risk-engine.ts        - Risk engine with structured RISK_* codes (integrates entitlement limits)
    thesis-builder.ts     - Data assembly + context enrichment (NOT a decision maker)
    trade-executor.ts     - Trade executor (mock, upstream proxy, or direct SpyFly modes)
    entitlement-manager.ts - Entitlement plans, purchases, effective limits, spend guardrails
    memory-store.ts       - Memory/journal for agent learning
client/src/
  App.tsx                 - App shell with sidebar + header + routing
  components/
    app-sidebar.tsx       - Navigation sidebar
    header.tsx            - Top header with kill switch, balance, connection status
  pages/
    dashboard.tsx         - Main dashboard (9 panels + thesis package viewer)
    positions.tsx         - Open/closed positions detail
    trade-log.tsx         - Trade history + risk denials
    entitlements.tsx      - Plans, purchases, limits
    settings.tsx          - Kill switch, risk params, connections, strategy info
  hooks/
    use-websocket.ts      - Singleton WebSocket hook with auto-reconnect + query invalidation
openclaw-plugin/          - OpenClaw agent plugin (26 tools + background health service)
other-team-docs/          - Other team's API documentation and analysis
INTEGRATION_OPTIONS.md    - Three-option merger analysis (A/B/C)
```

## Database Tables
- `wallets` — Trading wallet records (per-user, per-agent)
- `positions` — Open/closed positions with SL/TP/trailing/management mode
- `trades` — Trade history with fees, PnL, tx signatures
- `entitlement_plans` — Available upgrade plans
- `entitlements` — Active entitlement purchases
- `risk_denials` — Logged risk check denials
- `kill_switch_state` — Per-wallet kill switch state
- `memory_entries` — Agent memory/journal entries (per-wallet, per-token)
- `strategy_state` — Per-wallet feature weights and strategy version (agent-owned, evolving)

## Structured Error Codes
All error responses use `{ code, message }` format:
- `VALIDATION_ERROR` — Missing or invalid request parameters
- `WALLET_NOT_FOUND` — Wallet ID doesn't exist
- `TRADE_NOT_FOUND` — Trade ID doesn't exist
- `INTERNAL_ERROR` — Unexpected server error
- `KILLSWITCH_ACTIVE` — Kill switch blocks trade execution
- `RISK_KILLSWITCH_ENABLED` — Risk engine: kill switch denial
- `RISK_DENYLIST` — Risk engine: token on deny list
- `RISK_LIQUIDITY_TOO_LOW` — Risk engine: insufficient liquidity
- `RISK_TOP10_CONCENTRATION` — Risk engine: high holder concentration (soft cap)
- `RISK_DEV_HOLDING` — Risk engine: developer holding too high
- `RISK_POSITION_TOO_LARGE` — Risk engine: position exceeds max (soft cap)
- `RISK_DAILY_NOTIONAL_EXCEEDED` — Risk engine: daily volume limit hit
- `RISK_DAILY_LOSS_EXCEEDED` — Risk engine: daily loss limit hit
- `RISK_SLIPPAGE_TOO_HIGH` — Risk engine: slippage exceeds max
- `UPSTREAM_ERROR` — Error from upstream API
- `UPSTREAM_TIMEOUT` — Upstream API request timed out

## Upstream API Client
`server/services/upstream-client.ts` provides HMAC-signed requests to the other team's API:
- **HMAC signing**: `METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + SHA256(body)`
- **Headers**: `x-openclaw-key`, `x-openclaw-signature`, `x-openclaw-timestamp`, `x-openclaw-nonce`
- **Idempotency**: `x-idempotency-key` header on trade execute (uses `trade_{id}`)
- **Per-endpoint timeouts**: healthz=2s, bitquery=12s, precheck=5s, execute=25s

## Thesis Flow (Agent ↔ Orchestrator)
1. Agent calls `POST /api/thesis/build` with `walletId` + `tokenAddress`
2. Orchestrator assembles a `ThesisPackage`:
   - `marketData` — snapshot, holders, flows, liquidity, risk (raw data, no scoring)
   - `walletContext` — balance, open positions, daily usage, entitlement limits
   - `strategyContext` — the agent's own evolving feature weights + version
   - `memoryContext` — prior trades on this token + journal summary (win rate, notes)
   - `riskPreScreen` — advisory risk check (approved/denied, flags, capped size)
3. Agent reasons over the data using its own LLM strategy (OpenClaw handles this)
4. Agent calls `POST /api/trade/precheck` — orchestrator runs hard risk rules
5. Agent calls `POST /api/trade/execute` — orchestrator proxies to SpyFly (or upstream)
6. Agent calls `POST /api/trade/review` — orchestrator stores outcome in memory
7. Agent calls `POST /api/strategy/update` — persists evolved weights back

## API Endpoints (33)
- `GET /healthz` — Unsigned health check (service name, status, execution mode, upstream status)
- `GET /api/health` — Lightweight health check (status, timestamp, uptime)
- `POST /api/wallet/create` — Create wallet
- `GET /api/wallets` — List wallets
- `GET /api/capital/status?walletId=` — Capital view + limits
- `GET /api/funding/instructions?walletId=` — Deposit info
- `GET /api/wallet/positions?walletId=` — Positions (filterable by status)
- `POST /api/killswitch` — Toggle kill switch
- `GET /api/killswitch/status?walletId=` — Kill switch state
- `POST /api/scan/new-launches` — Scan new token launches
- `POST /api/scan/hot-pairs` — Scan hot trading pairs
- `POST /api/market/regime` — Market regime analysis
- `POST /api/token/snapshot` — Token price/volume snapshot
- `POST /api/token/holders` — Holder concentration profile
- `POST /api/token/flows` — Buy/sell flow profile
- `POST /api/token/liquidity` — Liquidity pool profile
- `POST /api/token/risk` — Composite token risk profile
- `POST /api/thesis/build` — Assemble ThesisPackage (data + context, no decisions)
- `POST /api/trade/precheck` — Pre-trade risk check
- `POST /api/trade/execute` — Execute trade (proxies through upstream or SpyFly)
- `POST /api/trade/review` — Post-trade review + journal
- `GET /api/entitlements/plans` — Available plans
- `GET /api/entitlements/current?walletId=` — Active entitlements + effective limits
- `POST /api/entitlements/purchase` — Purchase plan
- `POST /api/memory/write` — Write memory entry
- `POST /api/memory/search` — Search memories by text
- `POST /api/memory/by-token` — Search memories by token address
- `POST /api/memory/journal-summary` — Journal summary stats
- `GET /api/trades?walletId=` — Trade history (paginated)
- `GET /api/risk-denials?walletId=` — Risk denial log
- `GET /api/strategy/state?walletId=` — Read strategy state
- `POST /api/strategy/update` — Agent persists evolved weights
- `GET /api/system/status` — System health + execution mode + upstream status

## Risk Engine Defaults
- Kill switch → hard deny (code: `RISK_KILLSWITCH_ENABLED`)
- Denylist → hard deny (code: `RISK_DENYLIST`)
- Min liquidity: $50,000 (code: `RISK_LIQUIDITY_TOO_LOW`)
- Max position: $1,000 → soft cap (code: `RISK_POSITION_TOO_LARGE`)
- Max daily notional: $5,000 (code: `RISK_DAILY_NOTIONAL_EXCEEDED`)
- Max daily loss: $500 (code: `RISK_DAILY_LOSS_EXCEEDED`)
- Max slippage: 2000 bps (code: `RISK_SLIPPAGE_TOO_HIGH`)
- Top 10 holder concentration > 40% → soft flag, size-down 50% (code: `RISK_TOP10_CONCENTRATION`)
- Dev holding > 10% → hard deny (code: `RISK_DEV_HOLDING`)
- Limits are augmented by active entitlements (base + sum of limitsDelta)

## WebSocket
- Singleton connection pattern (shared across all components)
- Channels: positions, trades, risk-events, entitlements, system-status
- Auto-reconnect with 3s delay
- Query invalidation on messages matches actual API query keys

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection (auto-set)
- `BITQUERY_API_KEY` — Bitquery API key (optional, mock mode without it)
- `BOT_API_BASE_URL` — SpyFly bot base URL (optional, mock mode without it)
- `SESSION_SECRET` — Session encryption key
- `UPSTREAM_API_URL` — Other team's API base URL (enables proxy mode)
- `UPSTREAM_API_KEY` — API key for HMAC signing to upstream
- `UPSTREAM_API_SECRET` — API secret for HMAC signing to upstream
- `OPENCLAW_EXECUTION_MODE` — `mock` (default) or `live`

## OpenClaw Plugin (`openclaw-plugin/`)

The `openclaw-plugin/` directory contains the `@openclaw/solana-trader` OpenClaw plugin
that connects OpenClaw to this orchestrator via HTTP. It lives in-repo but is installed
separately into an OpenClaw gateway.

```
openclaw-plugin/
  openclaw.plugin.json    - Plugin manifest (id, configSchema, skills reference)
  package.json            - Package metadata + @sinclair/typebox dependency
  index.ts                - Plugin entry point — registers 26 tools + 1 background service
  src/
    http-client.ts        - Shared fetch wrapper with timeout + error handling
  skills/
    solana-trader/
      SKILL.md            - Trading skill (9-step loop, risk rules, strategy evolution)
  README.md               - Installation, config, tool reference, troubleshooting
```

### Plugin Config (in `~/.openclaw/openclaw.json`)
- `orchestratorUrl` (string, required) — Base URL of this orchestrator
- `walletId` (integer, required) — Wallet ID for this agent
- `apiTimeout` (integer, optional, default 30000) — HTTP timeout in ms

### Plugin Health Service
On startup, the plugin:
1. Checks `/healthz` (unsigned) — validates orchestrator is reachable, reports execution mode and upstream status
2. Checks `/api/system/status` — validates full system connectivity

### 26 Agent Tools
- **Scanning** (3): scan_launches, scan_hot_pairs, market_regime
- **Token Analysis** (5): token_snapshot, token_holders, token_flows, token_liquidity, token_risk
- **Intelligence** (1): build_thesis
- **Trading** (2): trade_precheck, trade_execute
- **Reflection** (5): trade_review, memory_write, memory_search, memory_by_token, journal_summary
- **Strategy** (2): strategy_state, strategy_update
- **Safety** (2): killswitch, killswitch_status
- **Wallet** (3): capital_status, positions, funding_instructions
- **Entitlements** (2): entitlement_plans, entitlement_purchase
- **System** (1): system_status

All tools auto-inject `walletId` from config. Agent never passes it manually.

## Other Team Documentation (`other-team-docs/`)
- `EXTERNAL_INTEGRATION_GUIDE.md` — Auth model, endpoint reference, HMAC signing spec
- `API_JSON_CONTRACTS.md` — Request/response JSON examples for all endpoints
- `TEAM_EXECUTION_CONTRACT.md` — Execution contract: call order, timeouts, retry rules, error codes
- `ARCHITECTURE_COMPARISON.md` — Side-by-side comparison of both orchestrators
- `SPYFLY_E2E_WORKFLOW_ARCHITECTURE.md` — SpyFly end-to-end workflow details
- `StateOfProblem.md` — State of the double-orchestrator problem
- `FULL_PICTURE_ANALYSIS.md` — Three teams overview + overlap table + merge decision

## Running
- `npm run dev` — Start development server (Express + Vite)
- `npm run db:push` — Push schema changes to database
- Database is auto-seeded on first startup with demo data
