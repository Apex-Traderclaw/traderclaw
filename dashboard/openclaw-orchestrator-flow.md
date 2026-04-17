# OpenClaw Orchestrator — Complete End-to-End Flow

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER ENVIRONMENT                            │
│                                                                     │
│  User installs OpenClaw plugin + skill                              │
│         ↓                                                           │
│  OpenClaw Agent (brain: reasoning, strategy, self-improvement,      │
│                  personality, local long-term memory)                │
│         ↓ calls 26 typed tools via plugin                           │
│                                                                     │
└─────────┬───────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     ORCHESTRATOR [THIS BUILD]                        │
│         (body: data assembly, risk enforcement,                      │
│          entitlements, wallet management, execution proxy)           │
│                                                                     │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────────┐     │
│  │  Risk    │ │Entitle-  │ │  Thesis    │ │  Trade Executor  │     │
│  │  Engine  │ │ment Mgr  │ │  Builder   │ │ (3 modes: mock/  │     │
│  │(RISK_*)  │ │          │ │            │ │  upstream/direct)│     │
│  └──────────┘ └──────────┘ └────────────┘ └──────────────────┘     │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────────┐     │
│  │  Memory  │ │ Kill     │ │  Market    │ │   Upstream       │     │
│  │  Store   │ │ Switch   │ │  Intel     │ │   Client (HMAC)  │     │
│  └──────────┘ └──────────┘ └────────────┘ └──────────────────┘     │
│  ┌──────────┐ ┌──────────────────────────────────────────────┐     │
│  │WebSocket │ │  Bitquery Client (direct or upstream proxy)  │     │
│  │ Manager  │ │                                              │     │
│  └──────────┘ └──────────────────────────────────────────────┘     │
│                        │                                            │
│                   PostgreSQL                                        │
│          (wallets, positions, trades, entitlements,                  │
│           risk_denials, memory, strategy_state)                     │
└─────────┬──────────────────────────────┬────────────────────────────┘
          │                              │
          ▼                              ▼
┌──────────────────────────────┐    ┌─────────────────────────┐
│  Other Team's API Layer      │    │   Direct (Dev Mode)     │
│  (upstream proxy mode)       │    │                         │
│                              │    │   SpyFly Bot (hands)    │
│  POST /api/trade/execute     │    │   Bitquery (eyes)       │
│    + side in body            │    │                         │
│    + x-idempotency-key       │    │   (fallback when no     │
│    + HMAC auth headers       │    │    UPSTREAM_API_URL)    │
│  POST /api/bitquery/query    │    │                         │
│    + walletId + query + vars │    └─────────────────────────┘
│                              │
│  GET /healthz (unsigned)     │
│                              │
│         ↓                    │
│  SpyFly Infra + Bitquery     │
└──────────────────────────────┘
```

---

## Phase 1: Setup

### Step 1 — User Installs OpenClaw

The user sets up OpenClaw (a powerful AI agent platform with large context window, long-term memory, and evolving task capabilities). OpenClaw runs locally or in their environment.

### Step 2 — User Installs the Trading Plugin

The plugin gives OpenClaw 20+ typed tools that all point to the Orchestrator's API endpoints. Each tool is a structured function call with defined inputs and outputs. Think of it like giving OpenClaw hands, eyes, and a body to interact with the crypto markets.

The plugin tools map to the orchestrator like this:

| Tool Category | What the Agent Calls | What the Orchestrator Does |
|---|---|---|
| **Scanning** | `scan_new_launches`, `scan_hot_pairs` | Queries Bitquery for new Solana token launches and high-volume pairs |
| **Analysis** | `token_snapshot`, `token_holders`, `token_flows`, `token_liquidity`, `token_risk` | Pulls structured market data per token from Bitquery |
| **Intelligence** | `build_thesis` | Assembles ThesisPackage: market data + wallet context + agent's own strategy weights + memory + risk pre-screen |
| **Trading** | `trade_precheck`, `trade_execute` | Enforces risk rules, then proxies the trade to SpyFly bot |
| **Reflection** | `trade_review`, `memory_write`, `memory_search`, `journal_summary`, `memory_by_token` | Stores outcomes, searches past trades, summarizes performance |
| **Strategy** | `strategy_update`, `strategy_state` | Agent persists evolved weights back to orchestrator |
| **Safety** | `killswitch`, `killswitch_status` | Emergency stop for all trading |
| **Wallet** | `capital_status`, `wallet_positions`, `funding_instructions` | Balance, positions, deposit info |
| **Entitlements** | `entitlement_plans`, `entitlement_current`, `entitlement_purchase` | Upgrade limits, buy resource packs |
| **System** | `market_regime`, `system_status` | Macro market conditions, system health |

### Step 3 — User Installs the Trading Skill

The skill is a set of instructions that teach OpenClaw how to be a Solana memecoin trader. It defines:

- The trading loop (scan → analyze → thesis → precheck → execute → review)
- When to scan for new tokens vs. monitor existing positions
- How to reason about risk flags
- When to journal and learn from outcomes
- How to evolve its own strategy weights over time
- Personality traits (aggressive vs. conservative, scalp vs. swing)

### Step 4 — User Creates a Wallet

The agent (or user) calls `POST /api/wallet/create` with a Solana public key. The orchestrator:

- Stores the wallet in the database
- Initializes default kill switch (off)
- Initializes default strategy weights (equal weighting across volume, momentum, liquidity, holders, flow, risk)
- The user funds the wallet on-chain by sending SOL to the public key

---

## Phase 2: The Autonomous Trading Loop

Once set up, the OpenClaw agent runs this loop continuously. Every user's agent runs independently with its own wallet, its own strategy weights, and its own memory.

```
┌─────────────────────────────────────────────────────────┐
│                    AGENT TRADING LOOP                     │
│                                                          │
│  1. SCAN ──→ 2. ANALYZE ──→ 3. THESIS ──→ 4. DECIDE    │
│                                               │          │
│                                          ┌────┴────┐     │
│                                          │ TRADE?  │     │
│                                          └────┬────┘     │
│                                      YES │    │ NO       │
│                                          ▼    ▼          │
│                                   5. PRECHECK  WATCH     │
│                                          │               │
│                                   6. EXECUTE             │
│                                          │               │
│                                   7. MONITOR             │
│                                          │               │
│                                   8. REVIEW + LEARN      │
│                                          │               │
│                                   9. EVOLVE STRATEGY     │
│                                          │               │
│                              └───────────┘               │
│                              (back to step 1)            │
└─────────────────────────────────────────────────────────┘
```

---

### Step 1: SCAN — Find Opportunities

The agent calls:

- `POST /api/scan/new-launches` → Orchestrator queries Bitquery for recent Pump.fun / PumpSwap / Raydium token launches
- `POST /api/scan/hot-pairs` → Orchestrator finds pairs with volume/price acceleration
- `POST /api/market/regime` → Orchestrator returns macro market state (bullish/bearish/neutral, total DEX volume, trending sectors)

**Data flow:**

```
Agent → Orchestrator → Bitquery GraphQL API → raw Solana DEX data
                    ← structured JSON (launches, pairs, regime)
Agent receives list of candidate tokens to investigate
```

OpenClaw uses its reasoning to pick which tokens look interesting based on the scan results, the current market regime, and what it remembers from past trades.

---

### Step 2: ANALYZE — Deep Dive on a Token

For each interesting token, the agent calls individual data endpoints:

- `POST /api/token/snapshot` → price, volume, 24h OHLC, trade count
- `POST /api/token/holders` → top 10 holder concentration, dev holding %, total holders
- `POST /api/token/flows` → buy/sell pressure ratio, net flow, unique trader count
- `POST /api/token/liquidity` → pool depth, locked %, DEX breakdown
- `POST /api/token/risk` → composite risk flags (concentration, dev holding, liquidity, etc.)

**Data flow:**

```
Agent → Orchestrator → Bitquery (5 parallel GraphQL queries per token)
                    ← 5 structured data objects
Agent now has full on-chain intelligence on the token
```

---

### Step 3: THESIS — Assemble Full Context

The agent calls `POST /api/thesis/build` with `walletId` + `tokenAddress`.

This is the key endpoint. The orchestrator assembles everything the agent needs to make a decision:

```
Agent calls /api/thesis/build
        │
        ▼
Orchestrator runs 9 parallel queries:
  ├── Bitquery: snapshot, holders, flows, liquidity, risk
  ├── Database: wallet balance, open positions, daily usage
  ├── Database: this agent's strategy weights (v1.2.3, volume_momentum=0.22, etc.)
  ├── Database: prior memory entries for THIS specific token
  ├── Database: journal summary (win rate, last 7 days)
  └── Risk engine: advisory pre-screen (flags + capped size, NO side effects)
        │
        ▼
Returns ThesisPackage:
{
  meta: { tokenAddress, symbol, timestamp },
  marketData: { snapshot, holders, flows, liquidity, risk },
  walletContext: { balanceSol: 5.0, openPositions: 3, dailyUsed, limits },
  strategyContext: { featureWeights: { volume_momentum: 0.22, ... }, version: "v1.2.3" },
  memoryContext: {
    priorTokenEntries: [ "Traded BONK 3 days ago, +30%, momentum play worked" ],
    journalSummary: { winRate: 33%, totalEntries: 3, recentNotes: [...] }
  },
  riskPreScreen: { approved: true, flags: ["HIGH_CONCENTRATION"], cappedSizeSol: 0.5 }
}
```

**Design principle**: The orchestrator assembled ALL the data. It did NOT decide whether to trade. That's OpenClaw's job.

---

### Step 4: DECIDE — Agent Reasons Over the Data

This happens entirely inside OpenClaw. No orchestrator call.

OpenClaw uses its LLM reasoning + its own strategy weights + its memory of past trades to:

- Weigh the market data against its learned feature weights
- Consider if it's traded this token before and what happened
- Factor in the risk pre-screen flags
- Check if its win rate is declining (maybe it should be more conservative)
- Decide: **BUY**, **WATCH**, or **AVOID**
- If buying: determine position size, stop-loss %, take-profit levels, hold horizon

Because OpenClaw has a huge context window and long-term memory, it can reason about patterns across dozens of past trades. It might say: "I've seen 3 tokens with similar holder concentration profiles this week, 2 of them rugged — I'm sizing down."

---

### Step 5: PRECHECK — Enforce Hard Risk Rules

If the agent decides to trade, it calls `POST /api/trade/precheck`:

```
Agent sends: { walletId: 1, tokenAddress: "...", sizeSol: 0.5, slippageBps: 300 }
        │
        ▼
Orchestrator Risk Engine checks (enforcing mode, writes denials):
  ├── Kill switch enabled? → HARD DENY
  ├── Token on denylist? → HARD DENY
  ├── Liquidity < $50k? → HARD DENY
  ├── Position value > $1k limit (adjusted by entitlements)? → SOFT CAP
  ├── Daily notional would exceed $5k? → HARD DENY
  ├── Daily loss already > $500? → HARD DENY
  ├── Slippage > 2000bps? → HARD DENY
  ├── Top 10 holders > 40%? → SOFT: size down 50%
  └── Dev holds > 10%? → HARD DENY
        │
        ▼
Returns: { approved: true/false, reasons: [...], cappedSizeSol: 0.25 }
```

If denied, the denial gets logged in the `risk_denials` table and broadcast via WebSocket to the dashboard. The agent sees why it was denied and can learn from it.

---

### Step 6: EXECUTE — Trade Through SpyFly

If precheck passes, the agent calls `POST /api/trade/execute`:

```
Agent sends: { walletId, tokenAddress, symbol: "BONK", side: "buy",
               sizeSol: 0.25, slippageBps: 300, slPct: 15,
               tpLevels: [25, 50], trailingStopPct: 10,
               managementMode: "LOCAL_MANAGED" }
        │
        ▼
Orchestrator:
  1. Checks kill switch one more time
  2. Runs risk engine one more time (enforcing mode, RISK_* codes)
  3. Creates "pending" trade record in DB
  4. Routes to execution (3 modes):
     │
     ├── MOCK MODE (default, no config needed):
     │     Simulates price/fees/tx, returns mock result
     │
     ├── UPSTREAM MODE (when UPSTREAM_API_URL is set):
     │     POST /api/trade/execute to upstream API with:
     │       - side in body (not URL path)
     │       - x-idempotency-key: trade_{id}
     │       - HMAC auth headers (x-openclaw-key/signature/timestamp/nonce)
     │     Their layer → SpyFly → on-chain execution
     │
     └── DIRECT MODE (legacy, when BOT_API_BASE_URL is set):
           POST /api/trade/{side} to SpyFly directly
     │
     ▼
  5. Updates trade record to "filled"
  6. Creates position record (open, long, entry price, SL/TP params)
  7. Broadcasts via WebSocket: "trades" + "positions" channels
        │
        ▼
Returns: { success: true, tradeId: 15, positionId: 4, txSignature: "5xK..." }
```

The dashboard updates in real-time via WebSocket — position appears in the table, balance adjusts.

---

### Step 7: MONITOR — Watch the Position

While positions are open, the agent periodically:

- Calls `GET /api/wallet/positions?walletId=1` to check current prices and unrealized PnL
- Calls `GET /api/capital/status?walletId=1` to track overall portfolio
- Decides whether to hold, sell, or adjust parameters

For sells, the same flow: `precheck → execute` with `side: "sell"`. The orchestrator finds the matching open position, closes it, computes realized PnL.

---

### Step 8: REVIEW — Journal the Outcome

After a trade closes, the agent calls `POST /api/trade/review`:

```
Agent sends: { tradeId: 15, walletId: 1, outcome: "win",
               notes: "BONK momentum play. Entry at strong buy pressure (72%).
                       Exited +30% in 2 hours. Key signal: flow divergence was
                       high and holder concentration was acceptable at 38%.",
               actualPnlSol: 0.075 }
        │
        ▼
Orchestrator:
  1. Updates trade PnL in DB
  2. Creates memory entry with notes, outcome, tags, strategy version
  3. This memory is now searchable and will appear in future ThesisPackages
     when the agent encounters BONK (or similar tokens) again
```

The agent also uses:

- `POST /api/memory/write` for general notes ("Market feels euphoric today, reducing size on new entries")
- `POST /api/memory/search` to recall past lessons ("What happened last time I traded a token with >60% top 10 concentration?")
- `POST /api/memory/by-token` to look up history on a specific token
- `POST /api/memory/journal-summary` to get stats ("Over the last 7 days: 33% win rate, 3 entries")

---

### Step 9: EVOLVE — Update Strategy Weights

After reviewing several trades, OpenClaw reflects on its performance. It uses its reasoning + journal summary to decide:

"My win rate on high-volume momentum plays is 60%, but on low-liquidity plays it's 10%. I should increase the weight on volume_momentum and decrease liquidity_depth."

The agent calls `POST /api/strategy/update`:

```
Agent sends: { walletId: 1,
               featureWeights: {
                 volume_momentum: 0.30,   // was 0.22, agent learned this matters more
                 buy_pressure: 0.20,      // was 0.18
                 liquidity_depth: 0.10,   // was 0.16, agent learned to deprioritize
                 holder_distribution: 0.15,
                 flow_divergence: 0.12,
                 risk_adjusted_return: 0.08,
                 social_signal: 0.05      // was 0.08, unreliable
               },
               strategyVersion: "v1.3.0" }
        │
        ▼
Orchestrator:
  1. Persists new weights to strategy_state table
  2. Broadcasts via WebSocket → dashboard Strategy panel updates
  3. Next time the agent calls /api/thesis/build, these NEW weights
     are included in the ThesisPackage.strategyContext
```

The agent's strategy literally evolves over time. Each walletId has its own independent weights.

---

## Phase 3: Entitlements & Limits

The orchestrator manages resource limits that the agent can upgrade:

```
Base limits:
  maxPositionUsd: $1,000
  maxDailyNotionalUsd: $5,000
  maxDailyLossUsd: $500
  maxSlippageBps: 2000
  msgPerSec: 10
  kbps: 100

Agent calls GET /api/entitlements/plans:
  ┌──────────────────────┬──────────┬───────┬────────────────────────────┐
  │ Plan                 │ Price    │ Hours │ Limits Boost               │
  ├──────────────────────┼──────────┼───────┼────────────────────────────┤
  │ Bandwidth Boost      │ 0.1 SOL  │ 24    │ +10 msg/s, +100 kbps      │
  │ Subscription Exp.    │ 0.2 SOL  │ 48    │ +3 subs, +1 connection    │
  │ Topic Unlock         │ 0.15 SOL │ 72    │ +5 subscriptions          │
  │ Pro Trader Pack      │ 0.3 SOL  │ 24    │ +$500 position, +$2k daily│
  └──────────────────────┴──────────┴───────┴────────────────────────────┘

Agent calls POST /api/entitlements/purchase { walletId: 1, planCode: "pro_trader" }:

  Orchestrator:
    1. Checks wallet balance (5 SOL >= 0.3 SOL ✓)
    2. Checks spend guardrails:
       - Daily max: 2 SOL
       - Per-upgrade max: 0.5 SOL
       - Cooldown: 15 minutes between same plan
    3. Deducts 0.3 SOL from wallet balance
    4. Creates active entitlement (expires in 24h)
    5. Broadcasts via WebSocket

  New effective limits:
    maxPositionUsd: $1,000 + $500 = $1,500
    maxDailyNotionalUsd: $5,000 + $2,000 = $7,000

Risk engine automatically uses the new limits on the next trade.
```

---

## Phase 4: Safety — Kill Switch

At any point, the user (or agent) can call `POST /api/killswitch`:

```
{ walletId: 1, enabled: true, mode: "TRADES_AND_STREAMS" }

This immediately:
  1. Persists to DB
  2. Broadcasts via WebSocket → dashboard shows red indicator
  3. ALL subsequent trade/execute calls return 403: "Kill switch enabled"
  4. Risk engine's first check is kill switch → hard deny

Modes:
  - TRADES_ONLY: blocks trade execution, data streams continue
  - TRADES_AND_STREAMS: blocks everything
```

---

## The Multi-Agent Picture

Every user gets their own:

- **Wallet(s)** — isolated balance and positions
- **Strategy weights** — their agent evolves independently
- **Memory entries** — their agent's own trade journal
- **Entitlements** — their own purchased limit upgrades
- **Kill switch** — per-wallet emergency stop
- **Risk limits** — adjusted by their specific entitlements

Multiple users with multiple OpenClaw agents all call the same orchestrator. Each agent is identified by `walletId`. The orchestrator serves them all independently — it never mixes data between wallets.

```
User A's OpenClaw Agent (walletId: 1, aggressive, v2.1.0)  ──┐
User A's OpenClaw Agent (walletId: 2, conservative, v1.0.0) ──┤
User B's OpenClaw Agent (walletId: 3, scalper, v3.5.0)     ──┤──→ Orchestrator ──→ SpyFly
User C's OpenClaw Agent (walletId: 4, swing, v1.8.0)       ──┘          ↕
                                                                    Bitquery
```

---

## Dashboard — Monitoring All of This

The orchestrator includes a real-time monitoring dashboard at the web root that shows:

| Panel | What It Shows |
|---|---|
| Wallet Balance | SOL + USD value |
| PnL Cards | Unrealized, realized, and total PnL |
| Open Positions | Token, side, size, entry/current price, PnL, SL/TP, management mode |
| Kill Switch | Toggle + mode selector |
| Quick Actions | Token thesis builder, scan launches, hot pairs, market regime |
| Thesis Package View | Structured market data, risk flags, memory context, strategy weights |
| Entitlements | Active bundles with expiry countdown |
| Usage vs Limits | Daily notional, throughput, msg/s gauges |
| Kafka Throughput | Messages/s, kbps, active topics |
| Strategy Weights | Agent's evolving feature weights (visual bars) |

All panels update in real-time via WebSocket when trades execute, positions change, risk denials occur, or the agent updates its strategy.

---

## Complete API Reference

### Wallet & Capital
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/wallet/create` | Create wallet |
| GET | `/api/wallets` | List wallets |
| GET | `/api/capital/status?walletId=` | Capital view + limits |
| GET | `/api/funding/instructions?walletId=` | Deposit info |
| GET | `/api/wallet/positions?walletId=` | Positions (filterable by status) |

### Kill Switch
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/killswitch` | Toggle kill switch |
| GET | `/api/killswitch/status?walletId=` | Kill switch state |

### Market Intelligence (Bitquery)
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/scan/new-launches` | New token launches |
| POST | `/api/scan/hot-pairs` | High-volume trading pairs |
| POST | `/api/market/regime` | Macro market state |
| POST | `/api/token/snapshot` | Token price/volume |
| POST | `/api/token/holders` | Holder concentration |
| POST | `/api/token/flows` | Buy/sell flow profile |
| POST | `/api/token/liquidity` | Liquidity pool profile |
| POST | `/api/token/risk` | Composite risk flags |

### Trade Flow
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/thesis/build` | Assemble ThesisPackage (data + context, no decisions) |
| POST | `/api/trade/precheck` | Pre-trade risk check (enforcing) |
| POST | `/api/trade/execute` | Execute trade via SpyFly |
| POST | `/api/trade/review` | Post-trade review + journal |

### Entitlements
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/entitlements/plans` | Available plans |
| GET | `/api/entitlements/current?walletId=` | Active entitlements + effective limits |
| POST | `/api/entitlements/purchase` | Purchase plan |

### Memory & Learning
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/memory/write` | Write memory entry |
| POST | `/api/memory/search` | Search memories by text |
| POST | `/api/memory/by-token` | Search memories by token address |
| POST | `/api/memory/journal-summary` | Journal summary stats |

### Strategy
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/strategy/state?walletId=` | Read strategy state |
| POST | `/api/strategy/update` | Agent persists evolved weights |

### System
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/trades?walletId=` | Trade history (paginated) |
| GET | `/api/risk-denials?walletId=` | Risk denial log |
| GET | `/api/system/status` | System health status |

---

## Key Design Principles

1. **Orchestrator = Body, OpenClaw = Brain**: The orchestrator never makes trading decisions. It gathers data, enforces rules, manages state, and executes. OpenClaw reasons, decides, learns, and evolves.

2. **Per-Wallet Isolation**: Every walletId has its own strategy weights, memory, entitlements, kill switch, and positions. Multiple agents share the orchestrator without data leaking between them.

3. **Advisory vs. Enforcing Risk**: The thesis builder runs risk checks in advisory mode (no side effects). The precheck and execute endpoints run in enforcing mode (writes denials, blocks trades).

4. **Agent Evolution**: Strategy weights are owned by the agent. The orchestrator stores them, includes them in ThesisPackages, and lets the agent update them after learning. The orchestrator never modifies them on its own.

5. **Graceful Degradation**: When Bitquery API key is not set, market data endpoints return realistic mock data. When SpyFly bot URL is not set, trade execution runs in mock mode. The system is always functional for development and testing.
