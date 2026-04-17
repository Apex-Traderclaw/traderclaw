# Full System State & Merge Guide

**Date**: March 4, 2026
**Purpose**: Document the complete current state of both teams' systems, identify all overlaps, and provide a detailed merge guide so the other team can integrate our unique features into their codebase — eliminating the double-orchestrator problem.

**Decision**: Merge our unique features (memory, strategy, enhanced thesis, dashboard) into the other team's API layer. Their layer becomes the single orchestrator. Our orchestrator gets sunset.

---

# Top 5 Critical Blockers for the Other Team

These are the biggest gaps discovered from reading their actual source code. Everything else is incremental.

1. **No trade history** — Trades are executed and returned but never saved. No `trades` table exists. The agent cannot query its own trade history, which blocks the memory/journal system from computing win rates. (Section 2.8)

2. **No position tracking** — After a buy, nothing records the open position, entry price, SL/TP levels, or current PnL. The `tpLevels`, `slPct`, and `trailingStopPct` fields are accepted in the request schema but completely ignored. (Section 2.8)

3. **Dead daily loss safety check** — `wallet.dailyRealizedLossUsd` exists as a column but is never incremented. The `RISK_DAILY_LOSS_EXCEEDED` check always passes because the value is always 0. (Section 2.8)

4. **Feature weight naming mismatch** — Their defaults use 5 camelCase features (equal 0.2). SKILL v4 specifies 7 snake_case features with differentiated weights. Migration required for existing wallets. (Finding #18)

5. **No memory system** — Confirmed zero memory/journal infrastructure. This is a full greenfield build (table, storage methods, service, 5 endpoints). (Section 2.1)

---

# Executive Summary

This section explains the situation in plain language. The full technical details follow in Parts 1-5 below.

## What We Built

We built the **orchestrator** — the system that sits between the autonomous trading agent (OpenClaw) and the actual trading infrastructure. Think of it as the agent's operations center. It does several things:

- **Keeps the agent safe**: Before every trade, it checks safety rules — is the token liquid enough? Is the agent losing too much today? Is the position too big? If something looks wrong, it blocks the trade or reduces the size.
- **Gives the agent a memory**: The agent can write down what it learned after each trade ("BONK worked well when buy pressure was high", "lost money on mSOL because I didn't check holder concentration"). It can search these notes later and see its own win rate over time.
- **Helps the agent improve**: The agent has adjustable "weights" for different trading signals (how much to care about volume vs liquidity vs buy pressure). It can tune these over time based on what's working.
- **Prepares intelligence briefings**: Before each trade, the system pulls together everything the agent needs — market data, past experience with this token, current strategy preferences, wallet balance, risk assessment — into one complete package called a "thesis."
- **Provides a monitoring dashboard**: A web interface where humans can see what the agent is doing — open positions, trade history, which trades got blocked and why, account balance, and system health.
- **Manages subscriptions**: Users can buy temporary "boosts" that increase their trading limits for a set period of time.

We also built the **plugin** — 26 tools that the agent can call to interact with all of the above. And a **trading skill** document that teaches the agent how to use these tools effectively.

## What The Other Team Built

They were originally asked to make the SpyFly trading bot and Bitquery market data accessible through API endpoints. They went further and built their own orchestrator-like layer on top, which includes:

- **Security**: Every request is signed with HMAC authentication. Trades have idempotency keys to prevent accidental double-trading.
- **Safety checks**: The same risk rules we have — checking liquidity, slippage, position sizes, daily limits. Same thresholds, same logic.
- **Access control**: A tier system (starter/pro/enterprise) that gates which features users can access.
- **Rate limiting**: Tracks how much each user is consuming and throttles them if they go over limits.
- **Wallet management**: Creates Solana wallets with secure key management (KMS).
- **Trade execution**: Routes trades through Jito bundles on Solana for fast, MEV-protected execution.
- **Market data**: Proxies Bitquery queries through their system with access controls.

## The Problem

Right now, when the agent wants to make a trade, the request goes through **two layers** that do the same safety checks:

1. Our orchestrator checks: Is the kill switch on? Is liquidity too low? Is the position too big? Is the agent over its daily limit?
2. Their API layer checks: Is the kill switch on? Is liquidity too low? Is the position too big? Is the agent over its daily limit?

Same questions, asked twice. Double the time, no extra safety. Every trade takes two hops instead of one.

## The Decision

**Merge into one layer.** Move our unique features into their system and shut ours down.

**What's unique to us** (they need to add these):
- **Memory/journal** — The agent's structured trading notebook. Their system has nothing like this. (Note: OpenClaw has its own built-in brain memory, but this structured database layer gives it queryable trade data, win rate stats, and token-specific history that the brain can't do on its own — more on this below.)
- **Strategy weight updates** — The ability to update strategy weights over time. Their system stores default weights in the wallet JSONB but has no endpoint to update them — they're write-once at wallet creation.
- **Enhanced thesis** — Our intelligence briefing includes memory context (past trades, win rate, token notes). Theirs returns market data + risk + basic strategy weights from the wallet, but has no memory context at all.
- **Entitlement plans** — Time-limited, stackable boosts. Their tiers are permanent and binary.
- **Dashboard** — A full monitoring UI. They have no visual interface.

**What's unique to them** (stays as-is):
- HMAC authentication
- Idempotency on trades
- Rate limiting and usage metering
- KMS wallet creation
- Jito bundle execution

**What's duplicated** (keep theirs, remove ours):
- Risk checks (same rules, same thresholds)
- Kill switch (theirs has global + per-wallet, ours only has per-wallet)
- Execution mode toggle (mock vs live)

## The End Result

After the merge, the request flow becomes:

**Agent -> Plugin -> Their Unified API -> SpyFly/Bitquery**

One hop. One set of safety checks. One kill switch. But now with memory, strategy evolution, enhanced intelligence, and a dashboard — things that were missing from their side.

## About OpenClaw's Memory (Important Context)

OpenClaw already has a very powerful built-in memory system — both long-term and short-term. It can remember past conversations, learn from mistakes, and evolve its reasoning naturally. So why do we also need a structured database for memory?

Think of it like a human trader:
- **The brain** (OpenClaw's native memory) = intuition, pattern recognition, general learning. A trader might "feel" that momentum plays have been working lately.
- **The spreadsheet/journal** (our structured DB) = hard data. The trader can look up: "I've traded BONK 3 times, won 2, lost 1. My win rate this week is 62%. My best signal has been flow divergence."

The brain is powerful but it can't:
- **Query itself structurally** — "Show me every trade on BONK in the last 30 days" requires a database, not memory recall
- **Calculate its own statistics** — "What's my win rate on momentum plays vs liquidity plays?" needs actual computation over historical records
- **Version-control its strategy** — "At version 1.2.3 my win rate was 68%, then I changed weights and it dropped to 54%" needs structured tracking to detect and revert
- **Survive context resets** — If the agent's session resets, native memory may lose recent details. The database persists forever.

Both systems together make OpenClaw a better trader than either alone:

| Situation | Brain Alone | Brain + Structured Memory |
|---|---|---|
| "Should I buy BONK?" | Recalls general impressions | Queries: "3 past trades, 2 wins, 1 loss. Last note: strong buy pressure worked well" |
| "How am I doing?" | Vague sense of performance | Queries: "62% win rate over 7 days, 47 trades, top signal was flow_divergence" |
| "Should I change approach?" | Might drift without structure | Reads current weights, sees buy_pressure correlates with wins, bumps it up, saves as v1.2.4 |
| "New session starts" | May lose recent context | Queries DB: all past learnings, strategy state, recent performance — instantly back up to speed |

This is why the memory and strategy systems are essential even though OpenClaw's native intelligence is already powerful.

---

# Part 1: Full Current State

## 1.1 The Three Pieces

### Piece 1: Our Orchestrator (This Codebase)

The brain's support system. Sits between the OpenClaw autonomous agent and the execution infrastructure.

**Tech Stack**: Node.js + Express + TypeScript, PostgreSQL (Drizzle ORM), React + Vite + Tailwind + shadcn/ui frontend, WebSocket for real-time updates.

#### Backend Services (9 services, ~1,541 lines total)

| # | Service File | Lines | What It Does |
|---|---|---|---|
| 1 | `server/services/market-intel.ts` | 382 | Aggregates Bitquery data into holder profiles, liquidity analysis, market flows, regime classification. Full mock data generator for dev mode. |
| 2 | `server/services/trade-executor.ts` | 270 | 3 execution modes: mock (simulated fills), upstream (HMAC-signed calls to other team's API), direct (SpyFly bot). Manages position state (open/update/close). |
| 3 | `server/services/upstream-client.ts` | 171 | HMAC SHA256 signing client for calling the other team's API. Headers: `x-openclaw-key`, `x-openclaw-signature`, `x-openclaw-timestamp`, `x-openclaw-nonce`. Per-endpoint timeouts. |
| 4 | `server/services/bitquery-queries.ts` | 153 | Predefined GraphQL query templates: token snapshots, OHLC, holder profiles, liquidity, new launches, hot pairs. |
| 5 | `server/services/thesis-builder.ts` | 148 | Compiles full intelligence package: market data + wallet context + strategy weights + memory entries + risk pre-screen. Key differentiator: theirs has market data + risk + basic strategy weights, but no memory context. |
| 6 | `server/services/bitquery-client.ts` | 127 | GraphQL client with dual mode: direct Bitquery calls or proxy through other team's API. Respects execution mode (mock blocks all external calls). |
| 7 | `server/services/risk-engine.ts` | 123 | Evaluates trades against safety rules: kill switch, denylist, min liquidity, dev holdings, concentration, daily loss/notional, slippage. Hard denials (block) vs soft denials (cap size). |
| 8 | `server/services/entitlement-manager.ts` | 114 | Plan purchases, balance checks, spend guardrails (daily limits, cooldowns), additive stacking of limits from multiple active plans. |
| 9 | `server/services/memory-store.ts` | 53 | Trading journal: write observations, search past entries by text, get summaries (win rate, recent notes). The agent learns from this. |

**Other key server files:**

| File | Lines | What It Does |
|---|---|---|
| `server/routes.ts` | 472 | All 25+ API route handlers |
| `server/storage.ts` | 251 | Database access layer (IStorage interface + DatabaseStorage implementation, 35 methods) |
| `server/seed.ts` | 193 | Demo data: 1 wallet, 3 open positions, 10 trades, 4 entitlement plans, 2 active entitlements, 5 risk denials, 3 memory entries |
| `shared/schema.ts` | 192 | All 10 database tables with Drizzle ORM + Zod insert schemas + TypeScript types |
| `server/websocket.ts` | 67 | WebSocket manager for real-time broadcasting |
| `server/errors.ts` | 52 | Structured error codes (`RISK_*`, `VALIDATION_ERROR`, etc.) + `apiError()` helper |

#### Database Schema (PostgreSQL, 10 Tables)

**Table: `users`**
```sql
id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()
username    TEXT NOT NULL UNIQUE
password    TEXT NOT NULL
```

**Table: `wallets`**
```sql
id                SERIAL PRIMARY KEY
user_id           VARCHAR
public_key        VARCHAR NOT NULL UNIQUE
label             VARCHAR NOT NULL DEFAULT 'default'
strategy_profile  VARCHAR DEFAULT 'balanced'
balance_lamports  BIGINT NOT NULL DEFAULT 0
status            VARCHAR NOT NULL DEFAULT 'active'
created_at        TIMESTAMP NOT NULL DEFAULT NOW()
last_stop_out_at  TIMESTAMP
```

**Table: `positions`**
```sql
id                SERIAL PRIMARY KEY
wallet_id         INTEGER NOT NULL
token_address     VARCHAR NOT NULL
symbol            VARCHAR NOT NULL
side              VARCHAR NOT NULL DEFAULT 'long'
size_sol          REAL NOT NULL
entry_price       REAL NOT NULL
current_price     REAL NOT NULL
unrealized_pnl    REAL NOT NULL DEFAULT 0
realized_pnl      REAL NOT NULL DEFAULT 0
management_mode   VARCHAR NOT NULL DEFAULT 'LOCAL_MANAGED'
status            VARCHAR NOT NULL DEFAULT 'open'
sl_pct            REAL
tp_levels         JSONB (number[])
trailing_stop_pct REAL
deadlock_state    VARCHAR
created_at        TIMESTAMP NOT NULL DEFAULT NOW()
closed_at         TIMESTAMP
```

**Table: `trades`**
```sql
id              SERIAL PRIMARY KEY
wallet_id       INTEGER NOT NULL
position_id     INTEGER
token_address   VARCHAR NOT NULL
symbol          VARCHAR NOT NULL DEFAULT 'UNKNOWN'
side            VARCHAR NOT NULL
size_sol        REAL NOT NULL
price           REAL NOT NULL
slippage_bps    INTEGER
order_id        VARCHAR
tx_signature    VARCHAR
status          VARCHAR NOT NULL DEFAULT 'pending'
fees_sol        REAL NOT NULL DEFAULT 0
pnl_sol         REAL
created_at      TIMESTAMP NOT NULL DEFAULT NOW()
```

**Table: `entitlement_plans`**
```sql
code               VARCHAR PRIMARY KEY
name               VARCHAR NOT NULL
description        TEXT
price_sol          REAL NOT NULL
duration_hours     INTEGER NOT NULL
stackable          BOOLEAN NOT NULL DEFAULT false
max_stack          INTEGER NOT NULL DEFAULT 1
limits_delta       JSONB NOT NULL (Record<string, number>)
auto_renew_allowed BOOLEAN NOT NULL DEFAULT false
```

**Table: `entitlements`**
```sql
id           SERIAL PRIMARY KEY
wallet_id    INTEGER NOT NULL
plan_code    VARCHAR NOT NULL
purchased_at TIMESTAMP NOT NULL DEFAULT NOW()
expires_at   TIMESTAMP NOT NULL
limits_delta JSONB NOT NULL (Record<string, number>)
active       BOOLEAN NOT NULL DEFAULT true
```

**Table: `risk_denials`**
```sql
id             SERIAL PRIMARY KEY
wallet_id      INTEGER NOT NULL
token_address  VARCHAR
reason         TEXT NOT NULL
rule_code      VARCHAR NOT NULL
severity       VARCHAR NOT NULL DEFAULT 'hard'
metadata       JSONB (Record<string, unknown>)
created_at     TIMESTAMP NOT NULL DEFAULT NOW()
```

**Table: `kill_switch_state`**
```sql
wallet_id   INTEGER PRIMARY KEY
mode        VARCHAR NOT NULL DEFAULT 'TRADES_ONLY'
enabled     BOOLEAN NOT NULL DEFAULT false
updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
```

**Table: `memory_entries`** (UNIQUE TO US — they don't have this)
```sql
id               SERIAL PRIMARY KEY
user_id          VARCHAR
wallet_id        INTEGER
token_address    VARCHAR
tags             TEXT[] (array)
notes            TEXT NOT NULL
outcome          VARCHAR (win/loss/pending/null)
strategy_version VARCHAR
created_at       TIMESTAMP NOT NULL DEFAULT NOW()
```

**Table: `strategy_state`** (UNIQUE TO US — they don't have this)
```sql
wallet_id        INTEGER PRIMARY KEY
feature_weights  JSONB NOT NULL (Record<string, number>)
strategy_version VARCHAR NOT NULL DEFAULT 'v1.0.0'
updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
```

#### API Routes (25+ endpoints)

**Wallet & System**
| Method | Path | What It Does |
|---|---|---|
| GET | `/healthz` | Unsigned health check. Returns `{ service, status, executionMode, upstreamConfigured, timestamp }` |
| POST | `/api/wallet/create` | Creates wallet with default strategy weights + kill switch |
| GET | `/api/wallets` | Lists all wallets |
| GET | `/api/capital/status` | Balance, PnL, daily usage, effective limits for a wallet |
| GET | `/api/funding/instructions` | Deposit details for funding a wallet |
| GET | `/api/system/status` | Full system health: execution mode, upstream config, WS connections, wallet count, Kafka throughput |
| GET | `/api/health` | Simple `{ status: "ok" }` |

**Market Scanning & Intel**
| Method | Path | What It Does |
|---|---|---|
| POST | `/api/scan/new-launches` | Recently detected token launches (Pump.fun, Raydium, PumpSwap) |
| POST | `/api/scan/hot-pairs` | Tokens with high volume and trade counts |
| POST | `/api/market/regime` | Current market volatility regime (risk_on/risk_off/neutral) |
| POST | `/api/token/snapshot` | Price, volume, 24h OHLC, trade count for a token |
| POST | `/api/token/holders` | Holder distribution, top 10 concentration, dev holdings |
| POST | `/api/token/flows` | Buy/sell pressure, net flows, unique trader counts |
| POST | `/api/token/liquidity` | Pool depth, locked liquidity, DEX breakdown |
| POST | `/api/token/risk` | Composite risk assessment (honeypot, dev flags) |

**Trading & Risk**
| Method | Path | What It Does |
|---|---|---|
| POST | `/api/thesis/build` | Full intelligence package (market + wallet + strategy + memory + risk pre-screen) |
| POST | `/api/trade/precheck` | Risk engine check without executing |
| POST | `/api/trade/execute` | Validates risk then executes buy/sell |
| POST | `/api/trade/review` | Post-trade review saved to memory |
| GET | `/api/trades` | Paginated trade history for a wallet |
| GET | `/api/wallet/positions` | Open or closed positions |
| POST | `/api/killswitch` | Toggle kill switch (enable/disable, mode) |
| GET | `/api/risk-denials` | History of blocked trades |

**Strategy & Memory** (UNIQUE TO US)
| Method | Path | What It Does |
|---|---|---|
| GET | `/api/strategy/state` | Current feature weights and strategy version |
| POST | `/api/strategy/update` | Update weights used for trade analysis |
| POST | `/api/memory/write` | Write a journal entry (notes, outcome, tags, token) |
| POST | `/api/memory/search` | Search past entries by text query |
| POST | `/api/memory/by-token` | Get all entries for a specific token |
| POST | `/api/memory/journal-summary` | Aggregated stats (win rate, entries) over lookback period |

**Entitlements**
| Method | Path | What It Does |
|---|---|---|
| GET | `/api/entitlements/plans` | List available upgrade plans |
| POST | `/api/entitlements/purchase` | Purchase a plan using wallet SOL balance |

#### WebSocket Events (Real-Time Broadcasting)

Connection path: `/ws`

Message format:
```json
{
  "channel": "positions|trades|risk-events|entitlements|system-status",
  "event": "string",
  "data": {},
  "timestamp": "ISO-8601"
}
```

| Channel | Event | When | Data |
|---|---|---|---|
| `system-status` | `connected` | Client connects | `{ connectedClients }` |
| `system-status` | `killswitch-updated` | Kill switch toggled | Kill switch object |
| `system-status` | `strategy-updated` | Strategy weights changed | `{ walletId, strategyVersion }` |
| `risk-events` | `precheck-denied` | Trade precheck fails risk | `{ walletId, tokenAddress, reasons[] }` |
| `risk-events` | `trade-denied` | Trade execution blocked by risk | `{ walletId, tokenAddress, reasons[] }` |
| `trades` | `trade-executed` | Trade fills successfully | Execution result object |
| `positions` | `position-updated` | Position state changes after trade | `{ walletId }` |
| `entitlements` | `purchased` | Entitlement plan purchased | `{ walletId, planCode, entitlement }` |

#### Frontend Dashboard (5 Pages)

**Tech Stack**: React 18 + Vite + Tailwind CSS + shadcn/ui + wouter (routing) + TanStack Query v5 + WebSocket hook

**Files**:
- `client/src/pages/dashboard.tsx` — Main dashboard
- `client/src/pages/positions.tsx` — Position management
- `client/src/pages/trade-log.tsx` — Trade history + risk denials
- `client/src/pages/entitlements.tsx` — Plan marketplace + active plans
- `client/src/pages/settings.tsx` — Configuration + diagnostics
- `client/src/components/app-sidebar.tsx` — Navigation sidebar
- `client/src/components/header.tsx` — Top bar with kill switch + balance
- `client/src/hooks/use-websocket.ts` — WebSocket hook for real-time updates
- `client/src/lib/queryClient.ts` — TanStack Query configuration
- `client/src/App.tsx` — Router setup

**Page Details**:

1. **Dashboard** (`/`): Wallet balance (SOL + USD), unrealized/realized/total PnL cards, open positions table (symbol, size, entry/current price, PnL, management mode, SL/TP), kill switch toggle with mode selector, thesis builder (input token address → full analysis with risk pre-screen), quick scan buttons (Launches, Hot Pairs, Regime), entitlements panel, usage vs limits progress bars, Kafka throughput stats.

2. **Positions** (`/positions`): Tabs for open/closed positions. Each position card shows PnL %, absolute SOL value, management mode (Server/Local), SL%, TP levels, trailing stop%, deadlock state.

3. **Trade Log** (`/trade-log`): Two tabs — Trades (table with timestamps, fill prices, fees, PnL status) and Risk Denials (blocked trade attempts with rule code, severity, reason).

4. **Entitlements** (`/entitlements`): Current effective limits display, active entitlements with countdown timers (progress bars), marketplace of available plans with price, duration, and limit boosts.

5. **Settings** (`/settings`): Kill switch controls, risk parameters (read-only: min liquidity $50k, max slippage 2000bps, etc.), connection status indicators (WebSocket, SpyFly, Bitquery), strategy weights + version, wallet info (public key, profile).

---

### Piece 2: OpenClaw Plugin (The Agent Bridge)

**File**: `openclaw-plugin/index.ts`

The plugin registers **26 tools** that the autonomous agent can call. Each tool maps to one or more orchestrator API endpoints.

| # | Tool Name | Maps To | Category |
|---|---|---|---|
| 1 | `solana_scan_launches` | `POST /api/scan/new-launches` | Market Scanning |
| 2 | `solana_scan_hot_pairs` | `POST /api/scan/hot-pairs` | Market Scanning |
| 3 | `solana_market_regime` | `POST /api/market/regime` | Market Scanning |
| 4 | `solana_token_snapshot` | `POST /api/token/snapshot` | Token Analysis |
| 5 | `solana_token_holders` | `POST /api/token/holders` | Token Analysis |
| 6 | `solana_token_flows` | `POST /api/token/flows` | Token Analysis |
| 7 | `solana_token_liquidity` | `POST /api/token/liquidity` | Token Analysis |
| 8 | `solana_token_risk` | `POST /api/token/risk` | Token Analysis |
| 9 | `solana_build_thesis` | `POST /api/thesis/build` | Intelligence |
| 10 | `solana_trade_precheck` | `POST /api/trade/precheck` | Trading |
| 11 | `solana_trade_execute` | `POST /api/trade/execute` | Trading |
| 12 | `solana_trade_review` | `POST /api/trade/review` | Trading |
| 13 | `solana_memory_write` | `POST /api/memory/write` | Memory (UNIQUE) |
| 14 | `solana_memory_search` | `POST /api/memory/search` | Memory (UNIQUE) |
| 15 | `solana_memory_by_token` | `POST /api/memory/by-token` | Memory (UNIQUE) |
| 16 | `solana_journal_summary` | `POST /api/memory/journal-summary` | Memory (UNIQUE) |
| 17 | `solana_strategy_state` | `GET /api/strategy/state` | Strategy (UNIQUE) |
| 18 | `solana_strategy_update` | `POST /api/strategy/update` | Strategy (UNIQUE) |
| 19 | `solana_killswitch` | `POST /api/killswitch` | Risk Control |
| 20 | `solana_killswitch_status` | `GET /api/killswitch` (via capital status) | Risk Control |
| 21 | `solana_capital_status` | `GET /api/capital/status` | Wallet |
| 22 | `solana_positions` | `GET /api/wallet/positions` | Wallet |
| 23 | `solana_funding_instructions` | `GET /api/funding/instructions` | Wallet |
| 24 | `solana_entitlement_plans` | `GET /api/entitlements/plans` | Entitlements |
| 25 | `solana_entitlement_purchase` | `POST /api/entitlements/purchase` | Entitlements |
| 26 | `solana_system_status` | `GET /api/system/status` | System |

**Background Health Service** (`solana-trader-health`):
- Periodically checks `/healthz` endpoint
- Validates execution mode (mock vs live) and upstream configuration
- Syncs with `/api/system/status` to verify wallet connectivity

---

### Piece 3: Other Team's API Layer (Verified From Their Actual Source Code)

Built on top of SpyFly infrastructure. Was supposed to just expose execution and data endpoints but ended up building a full orchestrator-like layer.

**Tech Stack**: JavaScript (ES Modules, NOT TypeScript), Express, Supabase (primary) + in-memory Map fallback, Zod for request validation. They use `#@/` import aliases for their monorepo (e.g. `#@/apps/logger.js`, `#@/infra/trading.js`, `#@/framework/db/supabase.js`).

**File Structure** (12 files, 2,379 lines total):

| File | Lines | Purpose |
|---|---|---|
| `index.js` | 39 | Entry point, starts Express server, graceful shutdown |
| `app.js` | 95 | Express app factory, wires all services + middleware |
| `config.js` | 165 | Full config from env vars with defaults, tier definitions |
| `middleware/external-auth.js` | 75 | HMAC signature verification middleware |
| `middleware/policy-guard.js` | 205 | Scope check, rate limit, usage metering middleware |
| `routes/public-routes.js` | 614 | All route handlers (signup, wallet, trade, bitquery, entitlements) |
| `services/auth-service.js` | 27 | HMAC signing/verification functions |
| `services/market-intel.js` | 81 | Mock market data generator (deterministic from token address) |
| `services/policy-engine.js` | 228 | Risk checks + usage evaluation + endpoint access control |
| `services/rate-limiter.js` | 38 | In-memory sliding window rate limiter |
| `services/storage.js` | 725 | Full Supabase + in-memory dual-mode storage layer |
| `services/trade-orchestrator.js` | 87 | Mock + live trade execution (SpyFly integration) |

**Their Supabase Tables** (verified from `storage.js` SQL/upsert calls — 11 tables):

| Table | Purpose | Key(s) |
|---|---|---|
| `openclaw_api_clients` | API key + secret + scopes + tier | `api_key` (upsert conflict key) |
| `openclaw_api_key_registry` | Maps `external_user_id` → `api_key`. One-time signup, unique constraint on `external_user_id` (code `23505` check) | `external_user_id` |
| `openclaw_wallets` | Wallet data. **Critical: `strategy_state` is a JSONB column HERE, not a separate table.** Also stores `limits` as JSONB. Columns: `id` (UUID), `label`, `public_key`, `owner_ref`, `chain`, `kms_wallet_id`, `kms_secured`, `balance_sol`, `daily_notional_usd`, `daily_realized_loss_usd`, `strategy_state`, `limits`, `created_at`, `updated_at` | `id` (UUID) |
| `openclaw_killswitch` | Per-wallet kill switch. **Already has `mode` column** (`TRADES_ONLY` / `TRADES_AND_STREAMS`) | `wallet_id` (upsert conflict key) |
| `openclaw_nonce_cache` | Replay protection. Composite key `apiKey:nonce` stored as single `nonce` column | `nonce` (upsert conflict key) |
| `openclaw_idempotency` | Cached trade responses for idempotent replays. Response stored as JSONB | `idempotency_key` + `wallet_id` |
| `openclaw_policy_events` | Audit log of ALL policy decisions (allow/deny). Columns: `id` (UUID), `api_key`, `wallet_id`, `endpoint`, `code`, `decision`, `metadata` (JSONB) | `id` (UUID) |
| `openclaw_entitlement_upgrades` | Log of tier upgrade transactions. Columns: `id`, `api_key`, `wallet_id`, `from_tier`, `to_tier`, `cost_sol`, `tx_signature`, `status`, `metadata`, `created_at` | `id` (UUID) |
| `openclaw_usage_window` | Per-window (60s) usage counters. Tracks: request_count, request/response_bytes, subscription_count, advanced_filter_count | `(subject_key, endpoint, window_epoch)` composite |
| `openclaw_usage_daily` | Daily usage counters. Same metrics as window table but aggregated per day | `(api_key, usage_date, endpoint)` composite |
| `openclaw_usage_events` | Usage threshold violation log. Columns: `id`, `api_key`, `endpoint`, `tier`, `code`, `severity` (warning/critical), `metadata`, `created_at`. Written via raw SQL `INSERT` | `id` (UUID) |

**Tables they DON'T have** (our unique additions needed):
- No `memory_entries` / journal table
- No `positions` table (trades update wallet aggregate, not individual positions)
- No `trades` table (execution results returned but never persisted — only `openclaw_policy_events` and `openclaw_idempotency` keep any trade record)
- No `entitlement_plans` catalog table (their tiers are config-based, not DB-based)
- No `entitlements` / active-plan-instance table

**Critical Code-Level Findings** (things not obvious from docs):

1. **`strategy_state` already exists in their wallet model**:
   ```javascript
   // storage.js — makeWallet()
   strategyState: {
     featureWeights: {
       volumeMomentum: 0.2, buyPressure: 0.2, liquidityDepth: 0.2,
       holderDistribution: 0.2, flowDivergence: 0.2,
     },
     strategyVersion: 'v1.0.0',
   }
   ```
   Their thesis builder already returns `strategyContext: wallet.strategyState` in the `/api/thesis/build` response. However, they have **no endpoint to update these weights** — they're write-once at wallet creation. Our `POST /api/strategy/update` endpoint is still needed.

2. **Their kill switch already supports `mode`**: The `killSwitchSchema` in `public-routes.js` validates `mode: z.enum(['TRADES_ONLY', 'TRADES_AND_STREAMS']).default('TRADES_ONLY')`. The Supabase table stores it. This means less work than expected — they already have the data model for our mode feature.

3. **walletId format difference**: Their wallets use UUID strings (`crypto.randomUUID()`), ours use auto-incrementing integers (`SERIAL PRIMARY KEY`). The plugin and all API contracts need to use UUID strings after the merge.

4. **All their risk checks are hard denials** — no soft denial logic (size capping). Their `PolicyEngine.evaluateTrade()` returns `deny()` for every violation. Our soft denial feature (capping trade size by 50% for concentration risk, capping to max USD for position size) needs to be explicitly added to their policy engine.

5. **SOL price differs**: Their mock: `$180` (in `config.js`). Ours: `$170` (in `BASE_DEFAULTS`). Needs alignment.

6. **Risk code naming differences**:
   | Risk Check | Their Code | Our Code |
   |---|---|---|
   | Top 10 concentration | `RISK_TOP10_TOO_HIGH` | `RISK_TOP10_CONCENTRATION` |
   | Dev holdings | `RISK_DEV_HOLDING_TOO_HIGH` | `RISK_DEV_HOLDING` |
   | Max position | `RISK_MAX_POSITION_EXCEEDED` | `RISK_POSITION_TOO_LARGE` |

   Their codes should be the canonical ones after the merge. The plugin's error-handling logic needs to recognize their code names.

7. **No memory/journal system at all**: Confirmed. Zero memory-related tables, functions, or endpoints in their code. This is a full greenfield addition for them.

8. **Trade execution in live mode**: Calls `buyTokenWebApp()` / `sellToken()` from `#@/infra/trading.js` (SpyFly). The sell function takes `(tokenAddress, sizeSol, publicKey, 0, slippageBps, false, ownerRef)`. The buy function takes an object `{ tokenAddress, amount, wallet, slippageBps, webAppUserId }`.

9. **Storage is dual-mode**: `OpenClawStorage` initializes Supabase via `initializeSupabase()`. If it fails, falls back to in-memory Maps. Every storage method writes to both in-memory AND Supabase (when available). This means in-memory is always a cache layer.

10. **Rate limiter is in-memory only**: `OpenClawRateLimiter` uses a `Map()` — not persisted to Supabase. Resets on server restart. Has burst detection (1s sub-window).

11. **`blockOnExtreme` defaults to `false`**: Usage metering is soft-only by default. Hard denials only happen when this config is enabled.

12. **Signup is public**: `POST /api/auth/signup` requires no HMAC — it's in the `publicRoutes` set that bypasses auth middleware. Takes `{ externalUserId }`, creates API key + secret (one-time per user).

13. **Tier access gates**:
    - `starter`: NO killswitch, NO bitquery endpoints, NO system:status
    - `pro`: Has killswitch + bitquery. No system:status.
    - `enterprise`: Everything including `system:status`.

14. **KMS wallet creation**: For Solana wallets created without a `publicKey`, the system generates a wallet via `walletTools.generateWallet('solana')`, then imports the private key into KMS via `WalletOnboarder.import()`. Returns `kmsWalletId` + `kmsSecured: true`.

15. **Live balance caching**: `getWalletWithLiveBalance()` caches on-chain balance for 10 seconds in an in-memory Map. Calls `walletTools.getWalletBalance(publicKey)` for refresh.

16. **Entitlement upgrade flow**: Validates tier ordering (no downgrades), checks wallet balance, deducts SOL via `walletTools.simpleTransaction()` in live mode (or mock signature in mock mode), then updates client scopes and tier.

17. **BSC chain support**: Their wallet creation accepts `chain: z.enum(['solana', 'bsc'])`. Wallets can be created for BSC chain, though KMS import only runs for Solana (`if (chain === 'solana')`). Our system is Solana-only. After merge, BSC support persists.

18. **Feature weight naming convention mismatch**: Their default weights use camelCase (`volumeMomentum`, `buyPressure`, `liquidityDepth`, `holderDistribution`, `flowDivergence` — 5 features, equal 0.2 each). Our SKILL v4 uses snake_case (`volume_momentum`, `buy_pressure`, `liquidity_depth`, `holder_quality`, `flow_divergence`, `token_maturity`, `risk_inverse` — 7 features, unequal weights summing to 1.0). The naming and count must be reconciled at merge time — recommend adopting snake_case and the 7-feature SKILL v4 set.

19. **No trade history persistence**: Trades are NOT persisted anywhere. `TradeOrchestratorService.execute()` returns a result, the route handler updates `wallet.dailyNotionalUsd` and `wallet.balanceSol`, but no trade record is saved. The only traces are: (a) `openclaw_policy_events` logging the decision, (b) `openclaw_idempotency` caching the response. There is no way to query past trades. This is a significant gap — our system has a full `trades` table.

20. **No position tracking**: They have no concept of positions. After a buy, nothing tracks the open position, its entry price, current price, PnL, SL/TP levels, or management mode. Our system has a full `positions` table with 18 columns. This is a major gap for the agent's trading workflow.

21. **Usage metering intercepts response body**: `policy-guard.js` monkey-patches `res.write()` and `res.end()` to count actual response bytes after the fact. This is used for bandwidth metering. Clever but fragile — must be preserved during merge.

22. **Raw SQL injection concern**: `storage.js` `recordUsage()` and `logUsageEvent()` build SQL strings via `toSqlSafe()` (replaces single quotes) and `toJsonSql()`. While basic escaping is in place, this pattern is less safe than parameterized queries. Not blocking but worth noting for security review.

23. **No scan/market endpoints**: They have NO equivalents to our `/api/scan/new-launches`, `/api/scan/hot-pairs`, or `/api/market/regime`. These come from our `market-intel.ts` which queries Bitquery directly. After merge, these could be added as new routes using their Bitquery proxy, or the agent could use `/api/bitquery/catalog` with appropriate templates.

24. **No `/api/trade/review` endpoint**: They have no post-trade review endpoint. This is part of our memory system. After merge, trade review should write to the new `memory_entries` table.

25. **Thesis builder uses dummy intent for risk pre-screen**: Their `/api/thesis/build` passes `{ sizeSol: 0.1, slippageBps: 300 }` as a fake intent to `policyEngine.evaluateTrade()`. Same pattern as ours — advisory only, not blocking.

26. **Capital/status is richer than ours**: Their `GET /api/capital/status` returns `{ walletId, balanceSol, cachedBalanceSol, liveBalanceRefreshedAt, limits, usage: { dailyNotionalUsd, dailyRealizedLossUsd }, killSwitch, strategyState }`. It bundles kill switch state and strategy state into the capital response. Our capital endpoint doesn't include strategy state.

27. **In-memory buffer limits**: `policyEvents` array is capped at 5,000 entries (FIFO shift). `usageEvents` array also capped at 5,000. These are only in-memory buffers — Supabase is the persistent store when available.

28. **Supabase uses `rpc('exec_sql')`**: For usage recording, they call `supabase.rpc('exec_sql', { sql_query: ... })` — this requires a Supabase SQL function named `exec_sql` to exist in their DB. This is non-standard and won't be available in our PostgreSQL. After merge to a standard Postgres setup, these need to be converted to direct SQL or ORM calls.

**Their Capabilities** (updated with code-verified details):

| Capability | Details |
|---|---|
| **HMAC Auth** | Full request signing: `x-openclaw-key`, `x-openclaw-signature`, `x-openclaw-timestamp`, `x-openclaw-nonce`. Nonce tracking (replay protection), clock skew ±60s. Signature = HMAC-SHA256 of `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(BODY)` using client secret. |
| **Idempotency** | `x-idempotency-key` on `POST /api/trade/execute` prevents double-trading on retries. Stored in `openclaw_idempotency` table. |
| **Risk Checks** | Same rules as ours: position limits ($1000), daily notional ($5000), daily loss ($500), liquidity floors ($50k), holder concentration (40%), dev holdings (10%), slippage ceiling (2000bps). **All hard denials — no soft denial / size capping.** |
| **Kill Switch** | Per-wallet + global. **Already supports `mode` field** (`TRADES_ONLY` / `TRADES_AND_STREAMS`). Error code: `RISK_KILLSWITCH_ENABLED`. |
| **Entitlements (Tiers)** | `starter` (0 SOL), `pro` (0.2 SOL), `enterprise` (0.5 SOL). Permanent, scope-gated. Upgrade via `POST /api/entitlements/upgrade` debits wallet. No time-limited plans — that's our unique addition. |
| **Usage Metering** | Per-window (60s) + daily. Tracks: RPS, bandwidth (bytes), subscription count, advanced filter count. Soft warnings via `x-openclaw-usage-warning` header. Hard denial only when `blockOnExtreme=true` (default: false). |
| **KMS Wallets** | Auto-generates Solana keypair, imports private key into KMS via `WalletOnboarder`. Returns `kmsWalletId` for secure signing. |
| **Structured Errors** | Deterministic codes: `RISK_SLIPPAGE_TOO_HIGH`, `AUTH_SCOPE_MISSING`, `RISK_KILLSWITCH_ENABLED`, etc. All follow `{ code, message }` shape. |

**Their Route Table** (verified from `public-routes.js` + `policy-guard.js`):

| Method | Path | Scope Required | Tier Access | What It Does |
|---|---|---|---|---|
| POST | `/api/auth/signup` | — (public) | All | Creates API key + secret for `externalUserId` |
| POST | `/api/wallet/create` | `wallet:write` | All | Creates wallet with KMS + strategy defaults |
| GET | `/api/capital/status` | `wallet:read` | All | Balance (live + cached), limits, usage, kill switch, strategy state |
| POST | `/api/thesis/build` | `trade:read` | All | Market data + risk pre-screen + strategyContext (from wallet) |
| POST | `/api/trade/precheck` | `trade:read` | All | Risk check without execution |
| POST | `/api/trade/execute` | `trade:execute` | All | Risk check → execute → update wallet balance |
| POST | `/api/killswitch` | `wallet:write` | **pro+** | Toggle kill switch (enabled, mode) |
| GET | `/api/system/status` | `system:read` | **enterprise** | Service health + execution mode |
| POST | `/api/bitquery/catalog` | `bitquery:catalog` | **pro+** | Templated Bitquery queries (requires funded wallet) |
| POST | `/api/bitquery/query` | `bitquery:raw` | **pro+** | Raw GraphQL Bitquery queries (requires funded wallet) |
| GET | `/api/entitlements/costs` | `entitlement:read` | All | Shows tier costs + recipient address |
| POST | `/api/entitlements/upgrade` | `entitlement:write` | All | Upgrade tier (debit wallet, expand scopes) |
| GET | `/healthz` | — (no auth) | All | Health check |
| **Execution Mode** | `mock` vs `live` toggle. |
| **Thesis Builder** | Market data + wallet context + risk pre-screen + basic strategy weights (from wallet JSONB). No memory context, no strategy update endpoint. Uses dummy intent `{sizeSol:0.1, slippageBps:300}` for advisory risk check. |
| **Bitquery Proxy** | Routes queries through their layer. Requires funded wallet to access. |
| **Trade Execution** | In mock mode: generates random price + fees + mock txSignature. In live mode: calls `buyTokenWebApp()` / `sellToken()` from `#@/infra/trading.js` (SpyFly). **Does NOT handle SL/TP/trailing stops** — the `executeSchema` accepts these fields but the `TradeOrchestratorService` ignores them. **Does NOT persist trade records or track positions.** |
| **SpyFly Integration** | Live execution via `#@/infra/trading.js`. Buy: `buyTokenWebApp({ tokenAddress, amount, wallet, slippageBps, webAppUserId })`. Sell: `sellToken(tokenAddress, sizeSol, publicKey, 0, slippageBps, false, ownerRef)`. |
| **Database** | Supabase (Postgres) with in-memory fallback. 11 tables (see table above). No trade history table, no positions table. |

**Their Endpoints**:

| Method | Path | What It Does |
|---|---|---|
| GET | `/healthz` | Unsigned liveness check |
| GET | `/api/system/status` | Service status + execution mode |
| POST | `/api/wallet/create` | KMS-managed wallet creation |
| GET | `/api/capital/status` | Live + cached SOL balances, usage vs limits |
| POST | `/api/bitquery/catalog` | Pre-defined query templates |
| POST | `/api/bitquery/query` | Raw GraphQL queries against Bitquery |
| POST | `/api/trade/precheck` | Validate trade against risk + policy |
| POST | `/api/trade/execute` | Execute trade (side in body, idempotency key header) |
| POST | `/api/thesis/build` | Market + risk + basic strategy weights (no memory) |
| POST | `/api/killswitch` | Toggle kill switch |
| GET | `/api/entitlements/costs` | Current tier pricing |
| POST | `/api/entitlements/upgrade` | Upgrade tier (debits wallet) |

---

## 1.2 The Overlap (The Problem)

| Concern | Us | Them | Duplicated? |
|---|---|---|---|
| Risk checks (slippage, liquidity, concentration, dev, daily loss) | Yes — 9 checks, hard/soft denial | Yes — same rules, same thresholds, **all hard denial only** | **YES** |
| Kill switch | Per-wallet, DB-backed, 2 modes | Per-wallet + global, DB-backed, **already has `mode` column** | **YES** |
| Entitlements | Plan-based, time-limited, stackable, 4 plans | Tier-based, permanent, scope-gated, 3 tiers | **YES — different models** |
| Thesis builder | Full (market + strategy + memory context) | Market + risk + basic strategy weights (no memory, no strategy update) | **Partial — ours adds memory context + strategy updates** |
| Execution mode (mock/live) | Yes | Yes | **YES** |
| Structured error codes | Yes (just added, aligned to theirs) | Yes (native) | **YES — now compatible** |
| Bitquery data access | Direct + proxy mode | Proxy with funded wallet gate | **YES** |
| Trade execution | Mock + upstream + direct | Jito bundles via SpyFy (mock + live) | **YES** |
| Trade persistence | Full trades table (side, price, fees, PnL, tx) | **NO — trades not persisted** | **No — ours only** |
| Position tracking | Full positions table (18 cols, lifecycle) | **NO — no position concept** | **No — ours only** |
| Market scan endpoints | 3 scan endpoints + 5 token analysis | **NO — only Bitquery proxy** | **No — ours only** |
| HMAC auth | Only as client (for calling them) | Full server-side on every request | No — theirs only |
| Idempotency | Only as client | Native on trade execute | No — theirs only |
| Rate limiting / metering | No | Sliding window + usage tracking (RPS, bandwidth, subs, filters) | No — theirs only |
| KMS wallet creation | No (basic publicKey only) | Yes (managed keys, `WalletOnboarder.import()`) | No — theirs is better |
| BSC chain support | No | Yes (`chain: z.enum(['solana', 'bsc'])`) | No — theirs only |
| Memory / journal | Yes (write, search, by-token, summary) | No | **No — ours only** |
| Strategy weights (evolvable) | Yes (7 features, versioned, mode, validation guardrails) | Defaults only (5 features, write-once, no update endpoint) | **No — ours only** |
| Strategy validation | Yes (7 guardrails: floor, cap, sum, delta, count, semver, increment) | No | **No — ours only** |
| Dashboard | Yes (5-page monitoring UI + WebSocket) | No | **No — ours only** |
| Plugin (26 agent tools) | Yes | No | **No — ours only** |
| Usage event logging | No | Yes (per-window + daily, bandwidth, subs, filters) | No — theirs only |
| Policy event audit trail | Partial (risk denials only) | Full (every request logged with decision) | No — theirs is more complete |

## 1.3 Current Request Flow (The Double-Orchestrator Problem)

```
OpenClaw Agent (autonomous brain)
  │
  ▼
OpenClaw Plugin (26 tools)
  │
  ▼
Our Orchestrator (this codebase)
  ├── Risk check #1 (our risk engine — 9 checks)
  ├── Entitlement check #1 (our plans — time-limited stacking)
  ├── Kill switch check #1 (our DB)
  ├── Memory lookup (unique to us)
  ├── Strategy weight lookup (unique to us)
  ├── Thesis assembly (unique — full context)
  ├── HMAC sign the request
  │
  ▼
Their API Layer
  ├── Auth verify (HMAC signature)
  ├── Risk check #2 (their risk engine — SAME rules)
  ├── Entitlement check #2 (their tiers — different model)
  ├── Kill switch check #2 (their DB)
  ├── Metering + rate limit
  │
  ▼
SpyFly / Bitquery (actual execution)
  ├── Jito bundles (on-chain)
  ├── Bitquery GraphQL
  └── KMS wallet ops
```

**The problem**: Every trade goes through 2 risk checks, 2 entitlement gates, 2 kill switches. Double latency for the same result.

---

# Part 2: Merge Guide — What The Other Team Needs To Add

The decision is to merge our unique features into their codebase. Below is everything they need to integrate, with exact code references.

## 2.1 Memory / Journal System

**In simple terms**: This is the agent's trading notebook. After every trade, the agent writes down what happened and what it learned. Before the next trade, it can look up its past notes on this token, check its recent win rate, and make a more informed decision. Without this, the agent can't look back at its own track record.

**Important**: OpenClaw already has a powerful built-in brain with long-term and short-term memory. It naturally learns from conversations and evolves its thinking. This structured database layer is different — it's the "spreadsheet" next to the brain. The brain can't query itself ("show me every BONK trade in the last month") or compute statistics on itself ("what's my win rate this week?"). The structured DB can. It also survives session resets — if the agent restarts, the database is still there with all past learnings intact.

Together, the brain + structured memory make OpenClaw a stronger trader than either system alone.

**What the agent does with it**:
- Before entering a trade: searches the notebook for past experience with this token or similar setups
- After a trade: writes a review (what worked, what didn't, outcome tagged as win/loss)
- Periodically: requests journal summaries to see overall win rate and recent patterns
- Strategy evolution: uses outcome data to decide which trading signals to trust more or less

### Database Table

```sql
CREATE TABLE memory_entries (
  id               SERIAL PRIMARY KEY,
  user_id          VARCHAR,
  wallet_id        INTEGER,
  token_address    VARCHAR,
  tags             TEXT[],
  notes            TEXT NOT NULL,
  outcome          VARCHAR,        -- 'win', 'loss', 'pending', or NULL
  strategy_version VARCHAR,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### TypeScript Types

```typescript
// From shared/schema.ts
export const memoryEntries = pgTable("memory_entries", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id"),
  walletId: integer("wallet_id"),
  tokenAddress: varchar("token_address"),
  tags: text("tags").array(),
  notes: text("notes").notNull(),
  outcome: varchar("outcome"),
  strategyVersion: varchar("strategy_version"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMemoryEntrySchema = createInsertSchema(memoryEntries).omit({
  id: true,
  createdAt: true,
});
export type InsertMemoryEntry = z.infer<typeof insertMemoryEntrySchema>;
export type MemoryEntry = typeof memoryEntries.$inferSelect;
```

### Storage Methods (from `server/storage.ts`)

```typescript
interface IStorage {
  // Get recent memory entries for a wallet (ordered by createdAt desc, limited)
  getMemoryEntries(walletId: number, limit?: number): Promise<MemoryEntry[]>;

  // Get all entries for a specific token
  getMemoryEntriesByToken(walletId: number, tokenAddress: string): Promise<MemoryEntry[]>;

  // Text search across notes and tokenAddress fields (case-insensitive ILIKE)
  searchMemoryEntries(walletId: number, query: string): Promise<MemoryEntry[]>;

  // Create a new journal entry
  createMemoryEntry(entry: InsertMemoryEntry): Promise<MemoryEntry>;

  // Aggregate stats: wins/losses/neutral counts over a lookback period
  getMemoryStats(walletId: number, lookbackDays: number): Promise<{
    wins: number;
    losses: number;
    neutral: number;
  }>;
}
```

**Search implementation**: Uses PostgreSQL `ILIKE` operator matching `%query%` against both `notes` and `token_address` columns. Results filtered by `walletId`, ordered by `created_at DESC`, limited to 20 results.

**Stats implementation**: Fetches all entries since `NOW() - lookbackDays`, then counts entries where `outcome = 'win'`, `outcome = 'loss'`, and everything else as neutral.

### Service Layer (from `server/services/memory-store.ts`, 53 lines)

```typescript
interface JournalSummary {
  period: string;        // e.g. "7 days"
  totalEntries: number;
  wins: number;
  losses: number;
  neutral: number;
  winRate: number;        // percentage (0-100)
  recentNotes: string[];  // last 5 entries' notes text
}

class MemoryStore {
  // Write a journal entry
  async write(params: {
    walletId: number;
    notes: string;
    tokenAddress?: string;
    outcome?: string;
    tags?: string[];
    strategyVersion?: string;
  }): Promise<MemoryEntry>;

  // Search past entries by text query
  async search(walletId: number, query: string): Promise<MemoryEntry[]>;

  // Get entries for a specific token
  async getByToken(walletId: number, tokenAddress: string): Promise<MemoryEntry[]>;

  // Get aggregated journal summary
  async getJournalSummary(walletId: number, lookbackDays?: number): Promise<JournalSummary>;
  // Default lookbackDays = 7
  // Calculates winRate = (wins / totalEntries) * 100, handles division by zero
  // recentNotes = last 5 entries' notes text
}
```

### API Routes

**`POST /api/memory/write`**
```
Request:  { walletId: number, notes: string, tokenAddress?: string, outcome?: string, tags?: string[], strategyVersion?: string }
Response: { ...MemoryEntry }  (the created entry)
Error:    { code: "VALIDATION_ERROR", message: "walletId and notes required" }
```

**`POST /api/memory/search`**
```
Request:  { walletId: number, query: string }
Response: MemoryEntry[]
Error:    { code: "VALIDATION_ERROR", message: "walletId and query required" }
```

**`POST /api/memory/by-token`**
```
Request:  { walletId: number, tokenAddress: string }
Response: MemoryEntry[]
Error:    { code: "VALIDATION_ERROR", message: "walletId and tokenAddress required" }
```

**`POST /api/memory/journal-summary`**
```
Request:  { walletId: number, lookbackDays?: number }
Response: JournalSummary
Error:    { code: "VALIDATION_ERROR", message: "walletId required" }
```

### Plugin Tools That Use Memory

| Tool | What It Sends | What The Agent Gets Back |
|---|---|---|
| `solana_memory_write` | `{ notes, tokenAddress?, outcome?, tags? }` | The created entry |
| `solana_memory_search` | `{ query }` | Array of matching entries |
| `solana_memory_by_token` | `{ tokenAddress }` | Array of entries for that token |
| `solana_journal_summary` | `{ lookbackDays? }` | `{ period, totalEntries, wins, losses, neutral, winRate, recentNotes }` |

---

## 2.2 Strategy Weight System

**In simple terms**: The agent looks at several signals before trading — volume, buy pressure, liquidity, holder distribution, and more. The "weights" control how much the agent cares about each signal. Over time, the agent adjusts these weights based on what's actually working. If trades based on high buy pressure keep winning, the agent increases that weight. If liquidity depth hasn't been predictive, it lowers that weight. This is how the agent systematically improves, not just intuitively.

The weights are version-controlled (v1.0.0, v1.2.3, etc.) so the agent can track what changed and when. If a weight adjustment makes performance worse, it can see that and revert. Without this system, the agent might still evolve its thinking through OpenClaw's native intelligence, but it wouldn't have a structured, measurable way to track and control that evolution.

### Database Table

```sql
CREATE TABLE strategy_state (
  wallet_id        INTEGER PRIMARY KEY,
  feature_weights  JSONB NOT NULL,
  strategy_version VARCHAR NOT NULL DEFAULT 'v1.0.0',
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);
```

**Example `feature_weights` value**:
```json
{
  "volume_momentum": 0.22,
  "buy_pressure": 0.18,
  "liquidity_depth": 0.16,
  "holder_distribution": 0.14,
  "flow_divergence": 0.12,
  "risk_adjusted_return": 0.10,
  "social_signal": 0.08
}
```

Weights always sum to 1.0. The agent adjusts them based on which signals correlated with winning vs losing trades.

### TypeScript Types

```typescript
export const strategyState = pgTable("strategy_state", {
  walletId: integer("wallet_id").primaryKey(),
  featureWeights: jsonb("feature_weights").$type<Record<string, number>>().notNull(),
  strategyVersion: varchar("strategy_version").notNull().default("v1.0.0"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertStrategyStateSchema = createInsertSchema(strategyState);
export type InsertStrategyState = z.infer<typeof insertStrategyStateSchema>;
export type StrategyState = typeof strategyState.$inferSelect;
```

### Storage Methods

```typescript
interface IStorage {
  // Get current strategy state for a wallet
  getStrategyState(walletId: number): Promise<StrategyState | undefined>;

  // Create or update strategy state (upsert on walletId)
  upsertStrategyState(state: InsertStrategyState): Promise<StrategyState>;
}
```

### API Routes

**`GET /api/strategy/state?walletId=1`**
```
Response: { walletId, featureWeights: {...}, strategyVersion: "v1.2.3", updatedAt }
Error:    { code: "VALIDATION_ERROR", message: "walletId required" }
```

**`POST /api/strategy/update`**
```
Request:  { walletId: number, featureWeights: Record<string, number>, strategyVersion: string, mode?: "HARDENED" | "DEGEN" }
Response: { ...StrategyState }  (the updated state)
Error:    { code: "VALIDATION_ERROR", message: "walletId, featureWeights, strategyVersion required" }
         { code: "STRATEGY_VALIDATION_ERROR", violations: [...] }
```

**Server-side validation guardrails** (already implemented in our orchestrator):
1. Weight floor: no weight below 0.01
2. Weight cap: no weight above 0.50
3. Max delta per feature: reject if any feature changed by more than ±0.20 in a single update
4. Sum check: weights must sum to 0.95–1.05
5. Feature count: must have at least 3 features
6. Version format: must be semver (e.g., `v1.2.3`)
7. Version increment: new version must be greater than current

**Feature weight naming reconciliation**: Their wallet model uses camelCase (`volumeMomentum`, `buyPressure`, `liquidityDepth`, `holderDistribution`, `flowDivergence` — 5 features, equal 0.2 each). Our SKILL v4 and orchestrator use snake_case with 7 features. **Recommendation**: Adopt the SKILL v4 snake_case 7-feature set at merge time. Update `makeWallet()` defaults in their `storage.js` to match.

**Mode field**: The `mode` field (`HARDENED` or `DEGEN`) controls the agent's operating parameters per SKILL v4. Stored alongside weights. HARDENED = survival-first (tighter SL, smaller positions), DEGEN = high-velocity (wider SL, pyramiding allowed).

WebSocket broadcast on update:
```json
{
  "channel": "system-status",
  "event": "strategy-updated",
  "data": { "walletId": 1, "strategyVersion": "v1.2.4" }
}
```

### Plugin Tools

| Tool | What It Sends | What The Agent Gets Back |
|---|---|---|
| `solana_strategy_state` | `{}` (uses configured walletId) | `{ featureWeights, strategyVersion, updatedAt }` |
| `solana_strategy_update` | `{ featureWeights, strategyVersion }` | The updated strategy state |

---

## 2.3 Enhanced Thesis Builder

**In simple terms**: Before every trade, the agent gets a "briefing document" called a thesis. Think of it like a one-page report: here's what the market looks like for this token, here's what your wallet situation is, here's what the risk assessment says.

Their version of this briefing only includes market data and risk. Our version adds two critical sections: "here's what you've experienced with this token before" (memory) and "here's which signals you currently trust most" (strategy weights). This turns the briefing from a generic market report into a personalized intelligence package that reflects the agent's own history and preferences.

The agent uses this briefing to decide whether to trade and how much to trade. The richer the briefing, the better the decision.

### ThesisPackage Structure (from `server/services/thesis-builder.ts`, 148 lines)

Their current thesis response already includes `strategyContext: wallet.strategyState` (verified from their code). They need to add the `memoryContext` section and ensure `strategyContext` is populated. Here is the full target structure:

```typescript
interface ThesisPackage {
  meta: {
    tokenAddress: string;
    symbol: string;
    timestamp: string;
  };

  marketData: {
    snapshot: TokenSnapshot;     // price, volume, 24h OHLC, trade count
    holders: HolderProfile;     // distribution, top 10 concentration, dev %
    flows: FlowProfile;         // buy/sell pressure, net flows, unique traders
    liquidity: LiquidityProfile; // pool depth, locked %, DEX breakdown
    risk: TokenRisk;            // honeypot flags, composite score
  };

  walletContext: {
    balanceSol: number;
    openPositions: Position[];
    dailyNotionalUsed: number;
    dailyLossUsed: number;
    effectiveLimits: EffectiveLimits;
  };

  // ---- ALREADY EXISTS IN THEIR CODE (from wallet.strategyState) ----
  strategyContext: {
    featureWeights: Record<string, number>;
    strategyVersion: string;
  } | null;

  // ---- THEY NEED TO ADD THIS ----
  memoryContext: {
    tokenHistory: MemoryEntry[];     // past entries for THIS token
    recentStats: {
      period: string;
      wins: number;
      losses: number;
      neutral: number;
      winRate: number;
    };
    recentNotes: string[];           // last 5 journal entries (any token)
  };

  riskPreScreen: {
    approved: boolean;
    reasons: RiskReason[];
    cappedSizeSol: number;
  };
}
```

### How It Assembles Data

The thesis builder does **parallel fetching** using `Promise.all`:

```
Promise.all([
  marketIntel.getTokenSnapshot(tokenAddress),
  marketIntel.getHolderProfile(tokenAddress),
  marketIntel.getFlowProfile(tokenAddress),
  marketIntel.getLiquidityProfile(tokenAddress),
  marketIntel.getTokenRisk(tokenAddress),
  storage.getWallet(walletId),
  storage.getPositionsByWallet(walletId, "open"),
  storage.getDailyNotional(walletId),
  storage.getDailyLoss(walletId),
  entitlementManager.getEffectiveLimits(walletId),
  storage.getStrategyState(walletId),              // <-- NEW: strategy
  storage.getMemoryEntriesByToken(walletId, token), // <-- NEW: token memory
  storage.getMemoryStats(walletId, 7),              // <-- NEW: 7-day stats
  storage.getMemoryEntries(walletId, 5),            // <-- NEW: recent notes
])
```

Then runs `riskEngine.check()` on the assembled data to get the risk pre-screen.

### Integration Steps For Their Thesis Builder

1. Add `openclaw_memory_entries` table to their Supabase schema (strategy state already exists as JSONB in `openclaw_wallets`)
2. In their `POST /api/thesis/build` handler (in `public-routes.js` around line 222), add 3 extra DB queries: token memory entries, memory stats, recent notes. Strategy context is already returned via `wallet.strategyState`.
3. Include `memoryContext` in the thesis response (alongside existing `strategyContext`)
4. The agent already knows how to read these fields — the plugin passes them through

---

## 2.4 Entitlement Plans (Time-Limited Stackable Model)

**In simple terms**: Their current system has three permanent tiers — starter, pro, enterprise. You pick one and you're in that tier. Our system works differently: users can buy temporary "boosts" that last for a set number of hours and then expire. For example, pay 0.3 SOL and get double your trading limits for 24 hours. These boosts can stack — buy two different boosts and both apply at the same time, adding their effects together.

This gives more flexibility. Instead of committing to a permanent tier, users can boost their limits when they need them and save money when they don't. Both models could coexist: their tiers control which features you can access (scope gating), while our plans control how much you can use those features (limit boosts).

**Decision needed**: Keep their tiers for feature access and add our plan system on top for temporary limit boosts. Or replace entirely — up to them.

### Database Tables

```sql
CREATE TABLE entitlement_plans (
  code               VARCHAR PRIMARY KEY,
  name               VARCHAR NOT NULL,
  description        TEXT,
  price_sol          REAL NOT NULL,
  duration_hours     INTEGER NOT NULL,
  stackable          BOOLEAN NOT NULL DEFAULT false,
  max_stack          INTEGER NOT NULL DEFAULT 1,
  limits_delta       JSONB NOT NULL,
  auto_renew_allowed BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE entitlements (
  id           SERIAL PRIMARY KEY,
  wallet_id    INTEGER NOT NULL,
  plan_code    VARCHAR NOT NULL,
  purchased_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMP NOT NULL,
  limits_delta JSONB NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true
);
```

### How Effective Limits Work (Additive Stacking)

```
Effective Limit = Base Limit + Sum(all active entitlements' limitsDelta values)
```

**Base Limits** (from `server/services/entitlement-manager.ts`):
```typescript
const BASE_LIMITS = {
  maxPositionUsd: 1000,
  maxDailyNotionalUsd: 5000,
  maxDailyLossUsd: 500,
  maxSlippageBps: 2000,
  msgPerSec: 10,
  kbps: 50,
  maxSubscriptions: 3,
  maxConnections: 2,
};
```

**Example**: User buys `pro_trader` plan (adds `{ maxPositionUsd: 500, maxDailyNotionalUsd: 2000, maxDailyLossUsd: 200 }`):
- maxPositionUsd: 1000 + 500 = 1500
- maxDailyNotionalUsd: 5000 + 2000 = 7000
- maxDailyLossUsd: 500 + 200 = 700

If they also buy `bandwidth_boost` (stackable, adds `{ msgPerSec: 10, kbps: 100 }`):
- msgPerSec: 10 + 10 = 20
- kbps: 50 + 100 = 150

### Spend Guardrails (from `server/services/entitlement-manager.ts`)

```typescript
const SPEND_GUARDRAILS = {
  perUpgradeMax: 0.5,      // No single plan can cost more than 0.5 SOL
  dailyMaxSol: 2.0,        // Max 2 SOL total spend in 24 hours
  cooldownMinutes: 15,     // Must wait 15 min before re-purchasing same plan
};
```

### Seed Data (4 Plans)

```typescript
[
  { code: "bandwidth_boost", name: "Bandwidth Boost", priceSol: 0.1, durationHours: 24,
    stackable: true, maxStack: 3, limitsDelta: { msgPerSec: 10, kbps: 100 } },

  { code: "sub_expansion", name: "Subscription Expansion", priceSol: 0.2, durationHours: 48,
    stackable: false, maxStack: 1, limitsDelta: { maxSubscriptions: 3, maxConnections: 1 } },

  { code: "topic_unlock", name: "Topic Unlock", priceSol: 0.15, durationHours: 72,
    stackable: false, maxStack: 1, limitsDelta: { maxSubscriptions: 5 } },

  { code: "pro_trader", name: "Pro Trader Pack", priceSol: 0.3, durationHours: 24,
    stackable: false, maxStack: 1, limitsDelta: { maxPositionUsd: 500, maxDailyNotionalUsd: 2000, maxDailyLossUsd: 200 } },
]
```

### Purchase Flow

1. Validate wallet exists and has sufficient SOL balance
2. Check spend guardrails (per-upgrade max, daily total, cooldown)
3. If plan is not stackable, check if an active instance already exists
4. Deduct SOL from wallet balance
5. Create entitlement record with `expiresAt = NOW() + durationHours`
6. Broadcast WebSocket event `{ channel: "entitlements", event: "purchased" }`

### API Routes

**`GET /api/entitlements/plans`**
```
Response: EntitlementPlan[]
```

**`POST /api/entitlements/purchase`**
```
Request:  { walletId: number, planCode: string }
Response: { entitlement: Entitlement, newBalanceLamports: number }
Errors:
  - { code: "WALLET_NOT_FOUND", message: "Wallet not found" }
  - { code: "VALIDATION_ERROR", message: "Insufficient balance" }
  - { code: "VALIDATION_ERROR", message: "Plan not found" }
  - { code: "VALIDATION_ERROR", message: "Cooldown period..." }
  - { code: "VALIDATION_ERROR", message: "Daily spend limit..." }
```

---

## 2.5 Dashboard (Frontend)

**In simple terms**: Right now there's no way for a human to see what the agent is doing without reading logs or making API calls. The dashboard is a web page that shows everything at a glance: how much money is in the wallet, what positions are open, what trades happened, which trades got blocked by safety rules and why, and what the agent's current strategy looks like. It updates in real time — when a trade executes, you see it on screen immediately without refreshing.

There are 5 pages: the main overview, a detailed positions view, a trade history/risk denial log, a page to buy and manage subscription boosts, and a settings page with system diagnostics.

### Tech Stack to Adopt

- React 18 + TypeScript
- Vite (build tool)
- Tailwind CSS (styling)
- shadcn/ui (component library — buttons, cards, badges, tables, tabs, dialogs, progress bars, switches, etc.)
- wouter (lightweight routing)
- TanStack Query v5 (data fetching + caching)
- WebSocket (real-time updates)
- lucide-react (icons)

### Page Structure

```
/                → Dashboard (main monitoring view)
/positions       → Position management
/trade-log       → Trade history + risk denials
/entitlements    → Plan marketplace
/settings        → Configuration + diagnostics
```

### Component Files to Port

```
client/src/App.tsx                      — Router + layout wrapper
client/src/components/app-sidebar.tsx   — Navigation sidebar
client/src/components/header.tsx        — Top bar (kill switch, balance, connection)
client/src/hooks/use-websocket.ts       — WebSocket connection hook
client/src/hooks/use-toast.ts           — Toast notification hook
client/src/lib/queryClient.ts           — TanStack Query config + apiRequest helper
client/src/pages/dashboard.tsx          — Main dashboard page
client/src/pages/positions.tsx          — Positions page
client/src/pages/trade-log.tsx          — Trade log page
client/src/pages/entitlements.tsx       — Entitlements page
client/src/pages/settings.tsx           — Settings page
```

### WebSocket Integration

The dashboard connects to `/ws` and listens for real-time events:

```typescript
// client/src/hooks/use-websocket.ts
const ws = new WebSocket(`ws://${host}/ws`);

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  // msg.channel, msg.event, msg.data, msg.timestamp
  
  // Auto-invalidate React Query caches based on channel:
  if (msg.channel === "trades") queryClient.invalidateQueries({ queryKey: ["/api/trades"] });
  if (msg.channel === "positions") queryClient.invalidateQueries({ queryKey: ["/api/wallet/positions"] });
  if (msg.channel === "risk-events") queryClient.invalidateQueries({ queryKey: ["/api/risk-denials"] });
  if (msg.channel === "entitlements") queryClient.invalidateQueries({ queryKey: ["/api/entitlements/plans"] });
};
```

### API Endpoints The Dashboard Calls

| Page | Endpoints Used |
|---|---|
| Dashboard | `GET /api/capital/status`, `GET /api/wallet/positions`, `POST /api/killswitch`, `POST /api/thesis/build`, `POST /api/scan/*`, `POST /api/market/regime`, `GET /api/system/status` |
| Positions | `GET /api/wallet/positions?status=open`, `GET /api/wallet/positions?status=closed` |
| Trade Log | `GET /api/trades`, `GET /api/risk-denials` |
| Entitlements | `GET /api/entitlements/plans`, `GET /api/capital/status` (for effective limits), `POST /api/entitlements/purchase` |
| Settings | `GET /api/system/status`, `GET /api/strategy/state`, `POST /api/killswitch` |

---

## 2.6 Risk Engine Alignment

**In simple terms**: Both systems have safety checks that run before every trade. They check the same things — is there enough liquidity? Is the developer holding too much of the token? Has the agent lost too much today? After the merge, only one set of checks should run (theirs). This section documents our checks so they can compare and make sure nothing is missed.

One feature worth noting: our engine has "soft denials" — instead of blocking a trade entirely, it can reduce the trade size. For example, if the top 10 holders own too much of a token, the engine cuts the trade size in half instead of blocking it. **Their engine does NOT have this — all their checks are hard denials.** This soft denial logic needs to be added to their `PolicyEngine.evaluateTrade()` method.

### Side-By-Side Comparison (Our Checks vs Their Checks)

| Check | Our Code | Their Code | Same Threshold? | Their Severity | Our Severity |
|---|---|---|---|---|---|
| Kill Switch | `RISK_KILLSWITCH_ENABLED` | `RISK_KILLSWITCH_ENABLED` | ✅ Yes | Hard | Hard |
| Deny List | `RISK_DENYLIST` | ❌ Not implemented | — | — | Hard |
| Min Liquidity | `RISK_LIQUIDITY_TOO_LOW` | `RISK_LIQUIDITY_TOO_LOW` | ✅ $50k | Hard | Hard |
| Dev Holding | `RISK_DEV_HOLDING` | `RISK_DEV_HOLDING_TOO_HIGH` | ✅ 10% | Hard | Hard |
| Daily Notional | `RISK_DAILY_NOTIONAL_EXCEEDED` | `RISK_DAILY_NOTIONAL_EXCEEDED` | ✅ $5k | Hard | Hard |
| Daily Loss | `RISK_DAILY_LOSS_EXCEEDED` | `RISK_DAILY_LOSS_EXCEEDED` | ✅ $500 | Hard | Hard |
| Max Slippage | `RISK_SLIPPAGE_TOO_HIGH` | `RISK_SLIPPAGE_TOO_HIGH` | ✅ 2000bps | Hard | Hard |
| Concentration | `RISK_TOP10_CONCENTRATION` | `RISK_TOP10_TOO_HIGH` | ✅ 40% | **Hard** | **Soft (cap 50%)** |
| Max Position | `RISK_POSITION_TOO_LARGE` | `RISK_MAX_POSITION_EXCEEDED` | ✅ $1k | **Hard** | **Soft (cap to max)** |

**Key Differences**:
1. **Deny list**: We have it, they don't. Needs to be added to their `evaluateTrade()`.
2. **Soft denials**: They return `deny()` for ALL violations. We return `approved: true` with `cappedSizeSol` for concentration and position size. This soft denial logic needs to be added.
3. **Code names differ** for 3 checks (see table above). After merge, use their names as canonical.
4. **SOL price**: Their mock `$180` (`config.js` line 146), ours `$170` (`BASE_DEFAULTS`). Needs alignment.

### Their Risk Check Order (from `policy-engine.js` `evaluateTrade()`)

```javascript
// 1. Kill switch (per-wallet)
if (killSwitch?.enabled) return deny(RISK_KILLSWITCH_ENABLED);
// 2. Slippage
if (intent.slippageBps > limits.maxSlippageBps) return deny(RISK_SLIPPAGE_TOO_HIGH);
// 3. Liquidity
if (marketIntel.liquidity.liquidityUsd < limits.minLiquidityUsd) return deny(RISK_LIQUIDITY_TOO_LOW);
// 4. Top 10 concentration
if (marketIntel.holders.top10ConcentrationPct > limits.maxTop10ConcentrationPct) return deny(RISK_TOP10_TOO_HIGH);
// 5. Dev holding
if (marketIntel.holders.devHoldingPct > limits.maxDevHoldingPct) return deny(RISK_DEV_HOLDING_TOO_HIGH);
// 6. Max position
if (sizeUsd > limits.maxPositionUsd) return deny(RISK_MAX_POSITION_EXCEEDED);
// 7. Daily notional
if (wallet.dailyNotionalUsd + sizeUsd > limits.maxDailyNotionalUsd) return deny(RISK_DAILY_NOTIONAL_EXCEEDED);
// 8. Daily loss
if (wallet.dailyRealizedLossUsd > limits.maxDailyLossUsd) return deny(RISK_DAILY_LOSS_EXCEEDED);
```

Note: They short-circuit on the first failure (returns immediately). Our engine collects all reasons before deciding. Their approach is simpler but loses the "multiple reasons" detail. For soft denial support, they'll need to continue checking after a soft violation to collect the capped size.

### What They Need to Add

1. **Deny list check** (add before liquidity check):
   ```javascript
   if (denyList.includes(intent.tokenAddress)) return deny('RISK_DENYLIST', 'Token is on deny list');
   ```

2. **Soft denial logic** for concentration and position size (modify these checks to cap instead of deny):
   ```javascript
   let cappedSizeSol = intent.sizeSol;
   // Instead of: return deny(RISK_TOP10_TOO_HIGH)
   if (marketIntel.holders.top10ConcentrationPct > limits.maxTop10ConcentrationPct) {
     cappedSizeSol = cappedSizeSol * 0.5; // Cap by 50%
     softReasons.push({ code: 'RISK_TOP10_TOO_HIGH', severity: 'soft' });
   }
   // Instead of: return deny(RISK_MAX_POSITION_EXCEEDED)
   const maxPositionSol = limits.maxPositionUsd / solPriceUsd;
   if (cappedSizeSol > maxPositionSol) {
     cappedSizeSol = maxPositionSol;
     softReasons.push({ code: 'RISK_MAX_POSITION_EXCEEDED', severity: 'soft' });
   }
   ```

3. **Return format update** to include `cappedSizeSol` and `reasons[]`:
   ```javascript
   return {
     approved: true,
     code: 'OK',
     cappedSizeSol,
     reasons: softReasons, // Array of { code, severity, message }
     metadata: { sizeUsd }
   };
   ```

### Our Risk Code Map (from `server/errors.ts`)

```typescript
export const RISK_CODE_MAP: Record<string, string> = {
  KILL_SWITCH: "RISK_KILLSWITCH_ENABLED",
  DENYLIST: "RISK_DENYLIST",
  LOW_LIQUIDITY: "RISK_LIQUIDITY_TOO_LOW",
  HIGH_CONCENTRATION: "RISK_TOP10_CONCENTRATION",
  HIGH_DEV_HOLDING: "RISK_DEV_HOLDING",
  MAX_POSITION: "RISK_POSITION_TOO_LARGE",
  MAX_DAILY_NOTIONAL: "RISK_DAILY_NOTIONAL_EXCEEDED",
  MAX_DAILY_LOSS: "RISK_DAILY_LOSS_EXCEEDED",
  MAX_SLIPPAGE: "RISK_SLIPPAGE_TOO_HIGH",
};
```

### Risk Check Result Format

```typescript
interface RiskResult {
  approved: boolean;
  cappedSizeSol: number;
  reasons: Array<{
    code: string;      // e.g. "HIGH_CONCENTRATION"
    severity: string;  // "hard" or "soft"
    message: string;   // Human-readable reason
  }>;
}
```

### Risk Denial Logging

When a trade is denied, we persist a record to a `risk_denials` table:

```typescript
await storage.createRiskDenial({
  walletId,
  tokenAddress,
  reason: r.message,
  ruleCode: RISK_CODE_MAP[r.code] || r.code,
  severity: r.severity,
});
```

Their system already logs denials to `openclaw_policy_events` via `storage.logPolicyEvent()`. After the merge, they can either:
- Add a dedicated `risk_denials` table (our approach — cleaner for dashboard queries), or
- Continue using `openclaw_policy_events` and filter by `decision='deny'` + `endpoint='/api/trade/*'` (less work but mixes risk denials with auth/usage denials)

We also broadcast a WebSocket event:
```json
{ "channel": "risk-events", "event": "trade-denied", "data": { "walletId": "uuid-here", "tokenAddress": "...", "reasons": [...] } }
```

---

## 2.7 Kill Switch Alignment

**In simple terms**: Both systems have an emergency stop button that instantly halts all trading. Their version has a global switch (stops everything for everyone) plus per-wallet switches. They **already have** our `mode` concept (`TRADES_ONLY` / `TRADES_AND_STREAMS`) — this was discovered in their actual source code.

### Our Model

- Per-wallet (keyed by `wallet_id`)
- Two modes:
  - `TRADES_ONLY` — blocks buy/sell execution, data queries still work
  - `TRADES_AND_STREAMS` — blocks everything including data streams
- Toggle via `POST /api/killswitch`
- Checked first in risk engine (hard denial)
- WebSocket broadcast on change: `{ channel: "system-status", event: "killswitch-updated" }`

### Their Model (Verified From Code)

- Per-wallet + global kill switch (`policy.globalKillSwitch` in config)
- **Already supports `mode` field**: `z.enum(['TRADES_ONLY', 'TRADES_AND_STREAMS']).default('TRADES_ONLY')` (in `killSwitchSchema`, `public-routes.js` line 17)
- Stored in `openclaw_killswitch` table with `wallet_id`, `enabled`, `mode`, `updated_at`
- Error code: `RISK_KILLSWITCH_ENABLED` (not `KILLSWITCH_ACTIVE` as initially documented)
- Global kill switch checked in `evaluateEndpointAccess()` before any endpoint access
- Per-wallet kill switch checked in `evaluateTrade()` before trade-specific risk checks

### Recommendation (Updated — Less Work Than Expected)

Their kill switch already has everything we need. The `mode` field is already in their schema and validation. The only additions needed are:
1. **Use the `mode` value in trade blocking logic** — Currently their `evaluateTrade()` checks `killSwitch?.enabled` but doesn't differentiate between `TRADES_ONLY` and `TRADES_AND_STREAMS`. They need to add mode-aware blocking for data endpoints.
2. **Add WebSocket broadcast** on kill switch toggle — they currently don't broadcast kill switch changes.

---

## 2.8 Trade Execution Flow Gap (Critical Finding From Source Code)

**In simple terms**: Their system can execute trades (buy/sell on-chain), but it doesn't keep any record of what happened. After a trade, there's no way to ask "show me my last 10 trades" or "what positions do I have open." The trade result is returned to the caller and then forgotten. For an autonomous trading agent, this is a major gap — the agent needs a trade history to learn from and a position tracker to manage SL/TP/trailing stops.

### What Their Trade Execute Does (from `public-routes.js` line 304 + `trade-orchestrator.js`)

1. Validates request body (Zod schema: `walletId, tokenAddress, side, sizeSol, slippageBps` + optional `symbol, tpLevels, slPct, trailingStopPct`)
2. Checks idempotency key — if present and cached, returns cached response
3. Checks risk via `policyEngine.evaluateTrade()` — deny if any check fails
4. Calls `tradeOrchestrator.execute()`:
   - **Mock mode**: Returns `{ tradeId (UUID), status: 'filled', mode: 'mock', txSignature: 'mock-{tradeId}', priceUsd, feesUsd }`
   - **Live mode**: Calls `buyTokenWebApp()` or `sellToken()` from SpyFly, returns result with real `txSignature`
5. Updates wallet: `dailyNotionalUsd += sizeSol * solPriceUsd`, `balanceSol -= sizeSol` (buy) or `+= sizeSol` (sell)
6. Logs policy event: `{ code: 'OK', decision: 'allow', metadata: { tradeId, mode } }`
7. Caches response in idempotency table
8. **RETURNS RESULT AND FORGETS IT** — no trade table, no position table

### What's Missing

1. **No `openclaw_trades` table**: The trade result is never persisted. The only traces are:
   - `openclaw_policy_events` row with `decision: 'allow'` and `tradeId` in metadata
   - `openclaw_idempotency` row (only if idempotency key was sent)
   
   Neither is queryable as a trade history. No PnL, no fees, no fill price in a structured format.

2. **No `openclaw_positions` table**: After a buy, nothing tracks:
   - Entry price (the price at which we bought)
   - Current price (for unrealized PnL calculation)
   - SL/TP/trailing stop levels (the `executeSchema` accepts these but they're ignored)
   - Position status (open/closed)
   - Management mode (LOCAL_MANAGED vs SERVER_MANAGED)
   
   The `tpLevels`, `slPct`, and `trailingStopPct` fields are accepted in the request body but **completely ignored** by `TradeOrchestratorService.execute()`. There is no SL/TP monitoring logic anywhere in their code.

3. **No daily loss tracking**: `wallet.dailyRealizedLossUsd` exists as a column but is **never incremented**. The trade execute handler only updates `dailyNotionalUsd` and `balanceSol`. The `RISK_DAILY_LOSS_EXCEEDED` check in their policy engine compares against `wallet.dailyRealizedLossUsd`, which is always 0. This safety check is effectively dead code.

### What Needs to Be Added

```javascript
// After successful execution in /api/trade/execute handler:
const trade = await storage.createTrade({
  walletId: wallet.id,
  tokenAddress: parsed.value.tokenAddress,
  symbol: parsed.value.symbol || execution.symbol || 'UNKNOWN',
  side: parsed.value.side,
  sizeSol: parsed.value.sizeSol,
  price: execution.priceUsd || 0,
  slippageBps: parsed.value.slippageBps,
  txSignature: execution.txSignature,
  status: execution.status, // 'filled' or 'failed'
  feesSol: execution.feesUsd ? execution.feesUsd / config.mock.solPriceUsd : 0,
});

// Position tracking:
if (parsed.value.side === 'buy' && execution.status === 'filled') {
  await storage.createPosition({
    walletId: wallet.id,
    tokenAddress: parsed.value.tokenAddress,
    symbol: parsed.value.symbol || 'UNKNOWN',
    side: 'long',
    sizeSol: parsed.value.sizeSol,
    entryPrice: execution.priceUsd || 0,
    currentPrice: execution.priceUsd || 0,
    slPct: parsed.value.slPct || null,
    tpLevels: parsed.value.tpLevels || [],
    trailingStopPct: parsed.value.trailingStopPct || null,
    status: 'open',
  });
}
```

---

# Part 3: Migration Checklist

Step-by-step for the other team to integrate our features:

### Phase 1: Database Schema (1-2 days)
- [ ] Add `openclaw_memory_entries` table to Supabase (new — they have nothing like this)
- [ ] ~~Add `strategy_state` table~~ — **NOT NEEDED**: `strategy_state` is already a JSONB column in `openclaw_wallets`. Just add `POST /api/strategy/update` endpoint that calls `storage.updateWallet(walletId, { strategyState: {...} })`.
- [ ] **Update `makeWallet()` default `strategyState`** in `storage.js` — change from 5 camelCase features (equal 0.2) to 7 snake_case SKILL v4 features: `{ volume_momentum: 0.20, buy_pressure: 0.18, liquidity_depth: 0.18, holder_quality: 0.15, flow_divergence: 0.12, token_maturity: 0.10, risk_inverse: 0.07 }`. Add `mode: "HARDENED"` to the default `strategyState`.
- [ ] Add `openclaw_entitlement_plans` table to Supabase (catalog of purchasable time-limited boosts)
- [ ] Add `openclaw_entitlements` table to Supabase (active purchased boosts with `expires_at`)
- [ ] Add `openclaw_positions` table to Supabase — **CRITICAL**: they currently have NO position tracking at all. After a trade, nothing records the entry price, current price, SL/TP, PnL, or management mode. Our schema has 18 columns.
- [ ] Add `openclaw_trades` table to Supabase — **CRITICAL**: trades are NOT persisted in their system. The only record is in `openclaw_policy_events` (decision log) and `openclaw_idempotency` (replay cache). Need a proper trade history table for the agent's journal and dashboard.
- [ ] ~~Add risk_denials table~~ — **OPTIONAL**: They already log denials to `openclaw_policy_events`. Can filter by `decision='deny'` or add a dedicated table.
- [ ] ~~Add `mode` column to kill switch table~~ — **ALREADY EXISTS**: `openclaw_killswitch` already has `mode` column.
- [ ] Seed `openclaw_entitlement_plans` with plan catalog
- [ ] **Migrate existing wallets' `strategyState` JSONB** from camelCase to snake_case feature names (one-time SQL update)

### Phase 2: Storage / Data Access Layer (2-3 days)
Add these methods to `OpenClawStorage` class (in `services/storage.js`):
- [ ] Memory CRUD: `createMemoryEntry(entry)`, `getMemoryEntries(walletId)`, `getMemoryEntriesByToken(walletId, tokenAddress)`, `searchMemoryEntries(walletId, query)`, `getMemoryStats(walletId, lookbackDays)`
- [ ] Strategy update: `updateStrategyState(walletId, featureWeights, strategyVersion, mode)` — wraps `updateWallet(walletId, { strategyState: {...} })`. Add validation guardrails (weight floor 0.01, cap 0.50, sum 0.95–1.05, max delta ±0.20, semver format, version increment).
- [ ] Entitlement plan CRUD: `getEntitlementPlans()`, `getEntitlementPlan(code)`, `getActiveEntitlements(walletId)`, `createEntitlement(walletId, planCode)`, `getRecentPurchases(walletId, hours)`
- [ ] Position tracking: `createPosition(pos)`, `updatePosition(id, patch)`, `getPositions(walletId, status)` — **their current system has NO position tracking at all**. Their `updateWallet()` only mutates aggregate `dailyNotionalUsd` and `balanceSol`. Need full position lifecycle.
- [ ] Trade history: `createTrade(trade)`, `getTrades(walletId, options)` — **their current execution returns results but never persists them**. Need a proper trade table.

**Important pattern to follow**: Their storage uses dual-mode (in-memory Map + Supabase). Every new method should write to BOTH: `this.someMap.set(key, value)` AND `supabase.from('table').insert(...)`. See any existing method for the pattern.

**Code pattern reference** (from their `createWallet()`):
```javascript
// 1. Build object
const wallet = makeWallet({ ... });
// 2. Write to in-memory Map
this.wallets.set(wallet.id, wallet);
// 3. Write to Supabase if available
if (this.mode === 'supabase') {
  await supabase.from('openclaw_wallets').insert({ ... });
}
return wallet;
```

**Constructor additions needed** — add Maps to the `OpenClawStorage` constructor:
```javascript
this.memoryEntries = new Map();    // walletId -> MemoryEntry[]
this.positions = new Map();        // walletId -> Position[]
this.trades = new Map();           // walletId -> Trade[]
this.entitlementPlans = new Map(); // planCode -> Plan
this.entitlements = new Map();     // walletId -> Entitlement[]
```

**Note on Supabase SQL**: Their `recordUsage()` and `logUsageEvent()` use `supabase.rpc('exec_sql', { sql_query })` for raw SQL. This requires a custom Supabase function. For new methods, prefer the standard `.from().insert()` / `.from().select()` pattern used elsewhere in their code.

### Phase 3: Service Layer (2-3 days)
- [ ] Port `MemoryStore` service logic (write, search, getByToken, getJournalSummary) — add as methods on existing services or create `services/memory-service.js`
- [ ] Port `EntitlementManager` service — `getEffectiveLimits(walletId)` (merges tier limits + active time-limited boosts), `purchasePlan(walletId, planCode)` with guardrails (daily spending limit, cooldown, balance check)
- [ ] Upgrade thesis builder in `/api/thesis/build` route handler — currently at line 222 of `public-routes.js`, returns `strategyContext: wallet.strategyState` (good start, line 260). Needs to add `memoryContext` (recent journal entries for the token, win rate stats from new `memory_entries` table). Also add `mode` to `strategyContext`.
- [ ] Add soft denial support to `PolicyEngine.evaluateTrade()` — modify concentration and position checks to cap size instead of deny (see Section 2.6 for exact code). Currently at `policy-engine.js` lines 89-119.
- [ ] Add deny list support to `PolicyEngine.evaluateTrade()` — new check before liquidity (line 98)
- [ ] Add kill switch `mode`-aware blocking — their `evaluateTrade()` (line 90) checks `killSwitch?.enabled` but doesn't use `mode`; data endpoints should still work when `mode='TRADES_ONLY'`
- [ ] **Add trade persistence to `/api/trade/execute`** — currently at `public-routes.js` line 304. After execution (line 354), the response is returned but never saved. Need to insert into new `openclaw_trades` table.
- [ ] **Add position creation/update in trade execute** — after a buy, create a position record. After a sell, find and close the matching position with PnL calculation.
- [ ] **Add market scan endpoints** — their system has NO equivalents to our `/api/scan/new-launches`, `/api/scan/hot-pairs`, `/api/market/regime`. Two options: (a) add new routes that call their Bitquery proxy with appropriate templates, or (b) extend `MarketIntelService` in `services/market-intel.js` (currently 81 lines, all mock data).

### Phase 4: API Routes (2-3 days)
Add to `routes/public-routes.js` (or create separate route files):

**Memory routes** (new — no equivalents in their system):
- [ ] Add `POST /api/memory/write` — requires `wallet:write` scope
- [ ] Add `POST /api/memory/search` — requires `wallet:read` scope
- [ ] Add `POST /api/memory/by-token` — requires `wallet:read` scope
- [ ] Add `POST /api/memory/journal-summary` — requires `wallet:read` scope
- [ ] Add `POST /api/trade/review` — requires `trade:read` scope (writes review to memory, links to trade)

**Strategy routes** (new — their wallet stores weights but has no update/read endpoint):
- [ ] Add `GET /api/strategy/state` — requires `wallet:read` scope (reads from `wallet.strategyState`)
- [ ] Add `POST /api/strategy/update` — requires `wallet:write` scope (validates guardrails, updates `wallet.strategyState` via `updateWallet()`)

**Entitlement routes** (partially exists — expand with plan-based system):
- [ ] Add `GET /api/entitlements/plans` — requires `entitlement:read` scope (lists plan catalog — their existing `/api/entitlements/costs` only shows tier pricing)
- [ ] Add `POST /api/entitlements/purchase` — requires `entitlement:write` scope (purchase with guardrails — different from their `/api/entitlements/upgrade` which is tier-based)

**Data/query routes** (new — no equivalents):
- [ ] Add `GET /api/risk-denials` — requires `wallet:read` scope (filter `openclaw_policy_events` by `decision='deny'`)
- [ ] Add `GET /api/trades` — requires `trade:read` scope (paginated trade history from new trades table)
- [ ] Add `GET /api/wallet/positions` — requires `wallet:read` scope (with `?status=open|closed` from new positions table)

**Market scan routes** (new — they have Bitquery proxy but no scan endpoints):
- [ ] Add `POST /api/scan/new-launches` — requires `trade:read` scope
- [ ] Add `POST /api/scan/hot-pairs` — requires `trade:read` scope
- [ ] Add `POST /api/market/regime` — requires `trade:read` scope
- [ ] Add `POST /api/token/snapshot` — requires `trade:read` scope
- [ ] Add `POST /api/token/holders` — requires `trade:read` scope
- [ ] Add `POST /api/token/flows` — requires `trade:read` scope
- [ ] Add `POST /api/token/liquidity` — requires `trade:read` scope
- [ ] Add `POST /api/token/risk` — requires `trade:read` scope

**Existing route updates**:
- [ ] Update `POST /api/thesis/build` (line 222 of `public-routes.js`) to include `memoryContext` in response (strategy context already there via `wallet.strategyState`)
- [ ] Update `POST /api/trade/execute` (line 304) to persist trade record and create/update position

**Middleware updates** (required for new routes):
- [ ] Update `middleware/policy-guard.js` `scopeByRoute` Map (line 4) with all new route → scope mappings
- [ ] Update `services/policy-engine.js` `tierAllowedEndpoints` (line 27) — add new routes to appropriate tiers:
  - `starter`: memory read, strategy state read, positions read, trades read, scan endpoints
  - `pro`: everything starter has + memory write, strategy update, token analysis
  - `enterprise`: everything
- [ ] Add Zod schemas for all new request bodies (follow existing `parseBody()` pattern from line 76)

### Phase 5: WebSocket Events (1 day)
- [ ] Add WebSocket server on `/ws` path (Express + `ws` package, or Socket.io)
- [ ] Broadcast `trade-executed` on successful trades (from `/api/trade/execute` handler)
- [ ] Broadcast `trade-denied` / `precheck-denied` on risk denials
- [ ] Broadcast `position-updated` after trades affect positions
- [ ] Broadcast `killswitch-updated` on `/api/killswitch` toggle
- [ ] Broadcast `strategy-updated` on `/api/strategy/update`
- [ ] Broadcast `purchased` on entitlement purchase

### Phase 6: Dashboard Frontend (3-5 days)
- [ ] Set up React + Vite + Tailwind + shadcn/ui (can be served alongside their Express app)
- [ ] Port 5 pages: dashboard, positions, trade-log, entitlements, settings
- [ ] Port sidebar navigation + header
- [ ] Port WebSocket hook for real-time updates
- [ ] Port TanStack Query configuration
- [ ] Connect all pages to their API endpoints
- [ ] **Important**: All `walletId` values in the dashboard are UUID strings (not integers)

### Phase 7: Plugin Update (1 day)
- [ ] Update plugin base URL to their API
- [ ] Update all `walletId` parameters to expect UUID strings (not integers)
- [ ] Map any risk code differences (e.g. `RISK_TOP10_TOO_HIGH` vs `RISK_TOP10_CONCENTRATION`)
- [ ] Verify all 26 tools work against their endpoints
- [ ] Update health service to check their `/healthz`

### Phase 7.5: Non-Regression Requirements (ongoing)
- [ ] **Preserve response-byte metering**: `policy-guard.js` monkey-patches `res.write()` and `res.end()` to count response bytes for bandwidth metering. Any middleware changes must not break this interception.
- [ ] **Replace `exec_sql` RPC calls**: `storage.js` `recordUsage()` and `logUsageEvent()` use `supabase.rpc('exec_sql', { sql_query })`. This requires a custom Supabase function. If migrating to standard Postgres, replace with parameterized queries or ORM calls.
- [ ] **Fix dead daily loss tracking**: `wallet.dailyRealizedLossUsd` is never incremented after trade execution. Add loss tracking to the sell side of `/api/trade/execute` so `RISK_DAILY_LOSS_EXCEEDED` actually works.

### Phase 8: Testing & Cutover (2-3 days)
- [ ] Test all memory endpoints (write, search, by-token, summary)
- [ ] Test strategy state read/update (via `wallet.strategyState`)
- [ ] Test entitlement purchase flow with guardrails (daily limit, cooldown, balance)
- [ ] Test thesis builder returns full package (market + strategy + memory)
- [ ] Test soft denials return `approved: true` with `cappedSizeSol`
- [ ] Test risk denials are logged and queryable
- [ ] Test WebSocket events broadcast correctly
- [ ] Test dashboard loads and shows real data
- [ ] Test plugin works end-to-end (agent → plugin → their API → execution)
- [ ] Test HMAC auth works with memory/strategy/entitlement endpoints
- [ ] Test tier access gates for new endpoints (add to `tierAllowedEndpoints` + `scopeByRoute`)

**Estimated total**: 14-22 days. Increased from previous estimate because source code review revealed:
- **No trade history table** — trades are not persisted, need full implementation (+2-3 days)
- **No position tracking** — no position lifecycle at all, need full implementation (+2-3 days)
- **No scan/market endpoints** — 8 endpoints to add (+1-2 days)
- **Feature weight naming migration** — camelCase → snake_case reconciliation (+0.5 day)

Savings from things already in place:
- Strategy state JSONB column already exists in wallet (save ~1 day)
- Kill switch `mode` already exists in schema (save ~0.5 day)
- Their error format already matches our needs (save ~0.5 day)
- Their capital/status already returns strategy state + kill switch (save ~0.5 day)

---

# Part 4: What Gets Removed From Our Side

After the merge is complete, the following from our codebase becomes obsolete:

| Component | File(s) | Why It's Removed |
|---|---|---|
| Upstream Client | `server/services/upstream-client.ts` | No longer calling their API — they ARE the API |
| Risk Engine | `server/services/risk-engine.ts` | Their risk engine handles this |
| Trade Executor | `server/services/trade-executor.ts` | Their execution path handles this |
| Bitquery Client | `server/services/bitquery-client.ts` | Their Bitquery proxy handles this |
| Entitlement Manager | `server/services/entitlement-manager.ts` | Moved to their codebase |
| Memory Store | `server/services/memory-store.ts` | Moved to their codebase |
| Market Intel | `server/services/market-intel.ts` | Their Bitquery + market data handles this |
| Thesis Builder | `server/services/thesis-builder.ts` | Upgraded version lives in their codebase |
| All API Routes | `server/routes.ts` | Their endpoints replace ours |
| Database | `shared/schema.ts`, `server/storage.ts` | Tables moved to their Supabase |
| Dashboard | `client/src/pages/*` | Moved to their codebase (or served from theirs) |
| Errors | `server/errors.ts` | They already have structured errors |
| WebSocket | `server/websocket.ts` | Moved to their codebase |
| Seed Data | `server/seed.ts` | Adapted for their DB |

**What we keep**:
- `openclaw-plugin/index.ts` — The plugin, updated to point to their API (walletId changed to UUID string)
- `openclaw-plugin/skills/solana-trader/SKILL.md` — The trading skill v4 (mode system, 7-feature weights, confidence scoring, evolution guardrails), unchanged
- `ORCHESTRATOR_CHANGES_FOR_SKILL_V4.md` — Recommendations for the other team to support SKILL v4 features

---

# Part 5: Post-Merge Architecture

### Clean Request Flow (Single Orchestrator)

```
OpenClaw Agent (autonomous brain)
  │
  ▼
OpenClaw Plugin (26 tools)
  │  (HTTP calls with walletId)
  ▼
Unified API Layer (their codebase + our features merged in)
  ├── HMAC Auth (theirs)
  ├── Rate Limiting + Metering (theirs)
  ├── Risk Engine (one check, not two)
  │   ├── Kill switch (per-wallet + global, with mode)
  │   ├── Entitlement check (their tiers + our plans)
  │   ├── Slippage, liquidity, concentration, dev, daily limits
  │   └── Hard deny (block) or soft deny (cap size)
  ├── Memory System (ported from us)
  │   ├── Journal write/search/by-token/summary
  │   └── Feeds into thesis builder
  ├── Strategy Weights (ported from us)
  │   ├── Feature weights read/update
  │   └── Feeds into thesis builder
  ├── Enhanced Thesis Builder (upgraded)
  │   └── Market data + wallet context + strategy + memory + risk
  ├── Entitlement Plans (ported from us)
  │   └── Time-limited stackable boosts on top of their tiers
  ├── Dashboard (ported from us)
  │   └── 5 pages + WebSocket real-time updates
  ├── Idempotency (theirs)
  ├── Execution Mode toggle (theirs)
  │
  ▼
SpyFly / Bitquery (actual execution)
  ├── Jito bundles (on-chain trades)
  ├── Bitquery GraphQL (market data)
  ├── KMS wallet ops
  └── TP/SL monitoring
```

### Benefits of This Architecture

1. **Single risk check** — no more double latency
2. **Single entitlement gate** — tiers (scope access) + plans (limit boosts) in one place
3. **Single kill switch** — global + per-wallet with modes
4. **Memory + strategy** — agent learns and evolves (was missing from their side)
5. **Full thesis** — agent gets complete intelligence (market + memory + strategy)
6. **Dashboard** — operational visibility (was missing from their side)
7. **Auth stays** — HMAC, idempotency, metering all preserved
8. **One hop** — Plugin → API → SpyFly (not Plugin → Us → Them → SpyFly)

---

# Appendix: File Reference Quick-Lookup

For the other team to find any specific piece of code:

| What You Need | File | Lines |
|---|---|---|
| All database table definitions | `shared/schema.ts` | 192 |
| All TypeScript types + Zod schemas | `shared/schema.ts` | 192 |
| All storage methods (35 methods) | `server/storage.ts` | 251 |
| All API route handlers | `server/routes.ts` | 472 |
| Memory store service | `server/services/memory-store.ts` | 53 |
| Strategy state (part of storage) | `server/storage.ts` (lines ~230-250) | — |
| Thesis builder with full assembly | `server/services/thesis-builder.ts` | 148 |
| Entitlement manager + guardrails | `server/services/entitlement-manager.ts` | 114 |
| Risk engine + all checks | `server/services/risk-engine.ts` | 123 |
| Error codes + RISK_CODE_MAP | `server/errors.ts` | 52 |
| WebSocket manager | `server/websocket.ts` | 67 |
| Seed data (demo wallet, positions, trades, plans) | `server/seed.ts` | 193 |
| Dashboard main page | `client/src/pages/dashboard.tsx` | — |
| Positions page | `client/src/pages/positions.tsx` | — |
| Trade log page | `client/src/pages/trade-log.tsx` | — |
| Entitlements page | `client/src/pages/entitlements.tsx` | — |
| Settings page | `client/src/pages/settings.tsx` | — |
| Sidebar navigation | `client/src/components/app-sidebar.tsx` | — |
| Header (kill switch + balance) | `client/src/components/header.tsx` | — |
| WebSocket hook | `client/src/hooks/use-websocket.ts` | — |
| Query client config | `client/src/lib/queryClient.ts` | — |
| Plugin (26 tools) | `openclaw-plugin/index.ts` | — |
| Bitquery query templates | `server/services/bitquery-queries.ts` | 153 |
| Market intel aggregation | `server/services/market-intel.ts` | 382 |
