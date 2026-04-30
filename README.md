# solana-traderclaw (Public V1)

Public release of TraderClaw’s Solana trading skill — built on the OpenClaw framework.

This is the open execution layer of an autonomous trading system: a composable, agent-driven architecture wired directly into server-side tooling for market data, execution, risk enforcement, deterministic compute, memory, episodic logging, and intelligence workflows.

At its core, this repository exposes a fully operational trading framework with 97 integrated tools spanning the entire lifecycle of Solana memecoin trading — from discovery to execution to risk management and post-trade evaluation.

TraderClaw is evolving toward a multi-agent trading desk architecture, where specialized agents operate across strategy, execution, token discovery, social intelligence, smart money tracking, and adaptive learning.

This release gives builders direct access to the underlying system primitives — and the ability to build, extend, and deploy their own agentic trading logic on top of the OpenClaw stack.

## Architecture

```
OpenClaw Agent (brain: reasoning, decisions, strategy evolution)
       │
       │ calls 97 typed tools (94 trading + 3 X read-only)
       ▼
Plugin (this package)
  ├── HTTP ──→ Orchestrator (data + risk + execution)
  │                  │              │
  │              Bitquery        SpyFly Bot
  │              (market data)   (on-chain execution)
  │
  ├── Local persistence (state, decisions, bulletin, patterns)
  │     └── .traderclaw-v1-data/
  │
  └── OpenClaw native memory (auto-loaded every session)
        ├── MEMORY.md (durable facts — always in context)
        └── memory/YYYY-MM-DD.md (daily logs — today + yesterday)
```

The plugin gives OpenClaw tools to interact with the Solana trading orchestrator. The orchestrator gathers market data, enforces risk rules, and proxies trades. OpenClaw does all reasoning, decision-making, and strategy evolution. The plugin also manages a 3-layer memory system that eliminates amnesia between sessions.

## Prerequisites

- OpenClaw v2026.1+ with Node >= 22
- An API key from [traderclaw.ai/register](https://traderclaw.ai/register)

## Quick Start

### 1. Install the plugin (OpenClaw)

```bash
openclaw plugins install solana-traderclaw
```

The `solana-traderclaw` tarball is the **plugin only** (no global `traderclaw` binary), so OpenClaw’s install scanner stays clean.

### 2. Install the global CLI (optional)

For `traderclaw --version`, `traderclaw install --wizard`, `traderclaw setup`, etc., install the companion package (it depends on `solana-traderclaw` and wires paths correctly):

```bash
npm install -g traderclaw-cli
```

That publishes the command name **`traderclaw`** on your PATH. From a git checkout you can also run `node bin/traderclaw.cjs …` at the repo root.

Install name and config id are intentionally different:
- npm plugin package: `solana-traderclaw`
- global CLI package: `traderclaw-cli` (command: `traderclaw`)
- OpenClaw plugin id in `openclaw.json`: `solana-trader`
- OpenClaw allowlist entry: `plugins.allow: ["solana-trader"]`

### 3. Run setup

```bash
traderclaw setup
```

The setup wizard will:
- Ask for your API key (leave blank if any)
- Connect to the orchestrator and validate your key (or create new one)
- Create or select a trading wallet
- Write the plugin configuration automatically

That's it. Restart the gateway and start trading:

```bash
openclaw gateway restart
```

### Optional: Simple localhost installer wizard (Linux-first)

```bash
traderclaw install --wizard
```

This opens a localhost UI that runs prechecks, lane-aware setup, gateway validation, optional Telegram setup, and final verification.

### Optional: Run CLI prechecks directly

```bash
traderclaw precheck --dry-run --output linux-qa-dryrun.log
traderclaw precheck --allow-install --output linux-qa-install.log
```

Use `--dry-run` for non-mutating validation and `--allow-install` for guided dependency installs.

### 4. Run the mandatory startup sequence

Send this prompt to your bot after startup:

```text
Run mandatory startup sequence and report pass/fail for each:
1) solana_system_status
2) solana_gateway_credentials_get (set if missing)
3) solana_alpha_subscribe(agentId: "main")
4) solana_capital_status
5) solana_positions
6) solana_killswitch_status
```

If alpha signals stop but the gateway looks healthy, call `solana_alpha_subscribe({ force: true })` or inspect `solana_runtime_status` (alpha `stats.lastEventTs`, `subscribed`). The plugin also runs a background watchdog for stale ingestion and gateway forward probes.

### Non-interactive setup

```bash
traderclaw setup --api-key sk_live_abc123 --url https://api.traderclaw.ai
```

## CLI Commands

### `traderclaw setup`

Interactive setup wizard. Validates API key, connects to orchestrator, sets up wallet, writes config.

Options:
- `--api-key, -k` — API key (skip prompt)
- `--url, -u` — Orchestrator URL (skip prompt, default: `https://api.traderclaw.ai`)

### `traderclaw status`

Check connection health and wallet status at a glance:

```
OpenClaw Solana Trader - Status
=============================================
  Orchestrator:     CONNECTED
  Execution mode:   live
  Upstream:         configured
  System status:    OK
  WS connections:   1

  Wallet:           ACTIVE
  Wallet ID:        1
  Balance:          5.0 SOL
  Open positions:   3
  Unrealized PnL:   0.062 SOL
  Kill switch:      disabled
  Strategy version: v1.2.3
  Mode:             HARDENED
=============================================
```

### `traderclaw config`

View and manage configuration:

```bash
traderclaw config show          # View current config (API key masked)
traderclaw config set <key> <v> # Update a value
traderclaw config reset         # Remove all plugin config
```

Available config keys: `orchestratorUrl`, `walletId`, `apiKey`, `apiTimeout`, `refreshToken`, `recoverySecret`, `walletPublicKey`, `walletPrivateKey`, `gatewayBaseUrl`, `gatewayToken`, `agentId`

### `traderclaw --help`

Print all available commands and options.

### `traderclaw --version`

Print plugin version.

## Advanced: Manual Configuration

If you prefer to configure manually instead of using the CLI, add to `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    allow: ["solana-trader"],
    entries: {
      "solana-trader": {
        enabled: true,
        config: {
          orchestratorUrl: "https://api.traderclaw.ai",
          walletId: 1,
          apiKey: "sk_live_your_key_here",
          apiTimeout: 30000,  // optional, default 30s
          dataDir: "/path/to/data"  // optional, default: <cwd>/.traderclaw-v1-data
        }
      }
    }
  }
}
```

Restart the gateway after configuration:

```bash
openclaw gateway restart
```

## Memory & Context System

The plugin implements a 3-layer memory architecture that uses OpenClaw's native infrastructure plus custom tools to eliminate amnesia between sessions.

### Layer 1: Durable Facts (`MEMORY.md`)

OpenClaw automatically loads `MEMORY.md` into agent context at every session start — zero tool calls needed. When `solana_state_save` is called, it writes both a JSON state file AND updates `MEMORY.md` with curated durable facts: tier, wallet, mode, strategy version, watchlist, permanent learnings, and regime canary.

### Layer 2: Episodic Memory (Daily Logs + Bootstrap Injection)

Two auto-loaded sources:
- **Daily logs** (`memory/YYYY-MM-DD.md`) — OpenClaw auto-loads today + yesterday's files. Written via `solana_daily_log`.
- **Bootstrap injection** — The `agent:bootstrap` hook auto-injects durable state, last 50 decisions, team bulletin (last 6h), context snapshot, and entitlements into agent context at session start.

### Layer 3: Deep Knowledge (Server-Side Memory)

Unlimited retention via the orchestrator API. `solana_memory_write` / `solana_memory_search` / `solana_memory_by_token` for storing and retrieving historical trades, lessons, and patterns.

### Memory Flush Hook

The `memory:flush` hook fires automatically when OpenClaw is about to trim context. It syncs `MEMORY.md` from the last persisted state and writes a compaction marker to the daily log. This is an automatic safety net — no agent action needed.

### Bootstrap Hook (`agent:bootstrap`)

Fires at every agent session start before the first prompt. Injects via `context.bootstrapFiles`:

| File Injected | Source | Content |
|---|---|---|
| `<agentId>-durable-state.json` | `state/<agentId>.json` | Full durable state from last session |
| `<agentId>-decision-log.jsonl` | `logs/<agentId>/decisions.jsonl` | Last 50 decision log entries |
| `team-bulletin.jsonl` | `logs/shared/team-bulletin.jsonl` | Bulletin entries from last 6 hours |
| `context-snapshot.json` | `state/context-snapshot.json` | Latest portfolio world-view snapshot |
| `active-entitlements.json` | 4-step fallback chain | Entitlement tier, limits, expiration |

Entitlement fallback chain: live API fetch → cached file → durable state → conservative defaults (starter tier).

### Local Data Directory

```
.traderclaw-v1-data/
├── state/                  # Durable agent state, snapshot, entitlement cache, patterns
├── logs/
│   ├── <agentId>/          # Per-agent decision logs (JSONL)
│   └── shared/             # Team bulletin (JSONL)
```

Plus OpenClaw-native paths at project root:
```
MEMORY.md                   # Curated durable facts (auto-loaded by OpenClaw)
memory/
├── 2026-03-19.md           # Today's daily log (auto-loaded by OpenClaw)
├── 2026-03-18.md           # Yesterday's daily log (auto-loaded by OpenClaw)
└── ...                     # Auto-pruned after 7 days
```

## X/Twitter Setup (Read-Only Social Intel)

The public edition includes 3 read-only X/Twitter tools for social intelligence gathering (search tweets, read mentions, get threads). X posting is not included in the public edition.

### Configure via Environment Variables

```bash
export X_CONSUMER_KEY="your-app-consumer-key"
export X_CONSUMER_SECRET="your-app-consumer-secret"
export X_ACCESS_TOKEN_MAIN="your-access-token"
export X_ACCESS_TOKEN_MAIN_SECRET="your-access-token-secret"
```

### Or Configure via Plugin Config

Add to `~/.openclaw/openclaw.json` under the plugin entry:

```json
{
  "x": {
    "consumerKey": "your-app-consumer-key",
    "consumerSecret": "your-app-consumer-secret",
    "profiles": {
      "main": {
        "accessToken": "your-access-token",
        "accessTokenSecret": "your-access-token-secret"
      }
    }
  }
}
```

### X API Tiers

| Tier | Cost | Capabilities |
|------|------|-------------|
| Pay-as-you-go | Per-credit | Read access (mentions, search, threads) |
| Basic | $200/month | Higher limits, more read access |

Pay-as-you-go or Basic tier is required for the read-only social intel tools.

## Available Tools (97 — 94 trading + 3 X read-only)

### Scanning
| Tool | Description |
|------|-------------|
| `solana_scan` | Broad market scan — launches + hot pairs combined |
| `solana_scan_launches` | Find new Solana token launches |
| `solana_scan_hot_pairs` | Find high-volume trading pairs |
| `solana_market_regime` | Get macro market state (bullish/bearish/neutral) |

### Token Analysis
| Tool | Description |
|------|-------------|
| `solana_token_snapshot` | Price, volume, OHLC data |
| `solana_token_holders` | Holder concentration and distribution |
| `solana_token_flows` | Buy/sell pressure and flow data |
| `solana_token_liquidity` | Pool depth and liquidity profile |
| `solana_token_risk` | Composite risk assessment |

### Intelligence
| Tool | Description |
|------|-------------|
| `solana_build_thesis` | Full context package: market data + strategy weights + memory + risk pre-screen |

### Trading
| Tool | Description |
|------|-------------|
| `solana_trade_precheck` | Pre-trade risk validation |
| `solana_trade_execute` | Execute trade via SpyFly bot (full params) |
| `solana_trade` | Execute trade (shorthand) |

### Reflection & Server-Side Memory
| Tool | Description |
|------|-------------|
| `solana_trade_review` | Post-trade outcome review |
| `solana_memory_write` | Write journal entry to server |
| `solana_memory_search` | Search trading memories on server |
| `solana_memory_by_token` | Token-specific trade history from server |
| `solana_journal_summary` | Performance stats summary |

### Strategy
| Tool | Description |
|------|-------------|
| `solana_strategy_state` | Read current strategy weights |
| `solana_strategy_update` | Update weights after learning |

### Safety
| Tool | Description |
|------|-------------|
| `solana_killswitch_status` | Check kill switch state |

### Wallet
| Tool | Description |
|------|-------------|
| `solana_capital_status` | Balance, positions, PnL, limits |
| `solana_positions` | Current positions with PnL |
| `solana_funding_instructions` | Deposit instructions |
| `solana_wallets` | List all wallets |
| `solana_wallet_create` | Create a new wallet |
| `solana_wallet_token_balance` | Get SPL token balance for a specific mint |
| `solana_sweep_dead_tokens` | Sell losing positions below loss threshold to cut losses and reclaim SOL |

### Entitlements
| Tool | Description |
|------|-------------|
| `solana_entitlement_plans` | Available limit upgrades |
| `solana_entitlement_purchase` | Purchase upgrade plan |
| `solana_entitlement_current` | Current tier, limits, and expiration (also caches for bootstrap) |
| `solana_entitlement_upgrade` | Upgrade entitlement tier |
| `solana_entitlement_costs` | View upgrade cost breakdown |

### Trade History & Risk
| Tool | Description |
|------|-------------|
| `solana_trades` | Query trade history with filters |
| `solana_risk_denials` | View recent risk denial log |

### Alpha Signal Processing
| Tool | Description |
|------|-------------|
| `solana_alpha_subscribe` | Subscribe to alpha WebSocket feed (`force: true` reconnects if ingestion stalls) |
| `solana_alpha_unsubscribe` | Unsubscribe from alpha feed |
| `solana_alpha_signals` | Retrieve buffered alpha signals |
| `solana_alpha_history` | Query historical alpha signals |
| `solana_alpha_sources` | Get source reputation statistics |
| `solana_alpha_submit` | Submit candidate to alpha buffer for next heartbeat evaluation |

### Firehose
| Tool | Description |
|------|-------------|
| `solana_firehose_config` | Configure firehose filter parameters (volume, buyers, whale detection) |
| `solana_firehose_status` | Check firehose health, throughput, and connection state |

### Bitquery Deep Scans
| Tool | Description |
|------|-------------|
| `solana_bitquery_query` | Execute custom Bitquery GraphQL query |
| `solana_bitquery_catalog` | List available Bitquery datasets |
| `solana_bitquery_templates` | Pre-built query templates |
| `solana_bitquery_subscribe` | Create Bitquery streaming subscription |
| `solana_bitquery_unsubscribe` | Remove streaming subscription |
| `solana_bitquery_subscriptions` | List active subscriptions |
| `solana_bitquery_subscription_reopen` | Reopen a closed subscription |

### Gateway & System
| Tool | Description |
|------|-------------|
| `solana_system_status` | Orchestrator health check |
| `solana_gateway_credentials_get` | Get gateway API credentials |
| `solana_gateway_credentials_set` | Set gateway API credentials |
| `solana_gateway_credentials_delete` | Delete gateway credentials |
| `solana_gateway_forward_probe` | Probe gateway forwarding connectivity |
| `solana_agent_sessions` | View agent session diagnostics |
| `solana_startup_gate` | Run startup gate sequence |
| `solana_runtime_status` | Runtime diagnostics (startup gate, alpha stats / `lastEventTs`, last forward probe) |

### Local Durable State
| Tool | Description |
|------|-------------|
| `solana_state_save` | Save agent state to local JSON (also writes MEMORY.md) |
| `solana_state_read` | Read agent state from local JSON |

### Episodic Decision Log
| Tool | Description |
|------|-------------|
| `solana_decision_log` | Log structured decision entry (FIFO capped at 50) |

### Team Bulletin
| Tool | Description |
|------|-------------|
| `solana_team_bulletin_post` | Post discovery, alert, or status to shared bulletin |
| `solana_team_bulletin_read` | Read bulletin entries with time/type filters |

### Context Snapshot
| Tool | Description |
|------|-------------|
| `solana_context_snapshot_write` | Write portfolio world-view snapshot |
| `solana_context_snapshot_read` | Read latest portfolio snapshot |

### Deterministic Compute (Anti-Hallucination)
| Tool | Description |
|------|-------------|
| `solana_compute_confidence` | Weighted confidence score (on-chain, signal, social, smart money, risk penalty) |
| `solana_compute_freshness_decay` | Freshness decay factor by signal age |
| `solana_compute_position_limits` | Full position sizing ladder with reduction breakdown |
| `solana_compute_deployer_risk` | Deployer wallet risk classification (LOW/MEDIUM/HIGH) |
| `solana_classify_deployer_risk` | Backward-compatible alias for solana_compute_deployer_risk |

### Intelligence Lab (New in V1-Upgraded)
| Tool | Description |
|------|-------------|
| `solana_candidate_write` | Write a trading candidate for evaluation |
| `solana_candidate_get` | Get a trading candidate by ID |
| `solana_candidate_label_outcome` | Label a candidate with actual outcome |
| `solana_candidate_delta` | Compute prediction delta for a candidate |
| `solana_source_trust_refresh` | Refresh trust scores for intelligence sources |
| `solana_source_trust_get` | Get current trust score for a source |
| `solana_model_score_candidate` | Score a candidate using the active model |
| `solana_model_registry` | List registered scoring models |
| `solana_model_promote` | Promote a challenger model to active |
| `solana_contradiction_check` | Check for contradictions in signal data |
| `solana_dataset_export` | Export labeled dataset for analysis |
| `solana_deployer_trust_get` | Get deployer trust profile |
| `solana_deployer_trust_refresh` | Refresh deployer trust from on-chain data |
| `solana_evaluation_report` | Generate intelligence evaluation report |
| `solana_replay_run` | Run a replay of historical decisions |
| `solana_replay_report` | Get results of a replay run |
| `solana_scrub_untrusted_text` | Scrub untrusted text for prompt injection |

### Deep Analysis
| Tool | Description |
|------|-------------|
| `solana_history_export` | Export decision logs + optionally server-side data (trades, memory, strategy) |
| `solana_pattern_store` | Read/write/list named trading patterns |

### OpenClaw Native Memory
| Tool | Description |
|------|-------------|
| `solana_daily_log` | Append to today's daily log (auto-loaded by OpenClaw next session, 7-day prune) |

### X/Twitter (Read-Only Social Intel)
| Tool | Description |
|------|-------------|
| `x_search_tweets` | Search recent tweets by keyword/hashtag |
| `x_read_mentions` | Read recent @mentions (pay-as-you-go tier) |
| `x_get_thread` | Read a full conversation thread |

## Hooks (2)

| Hook | Trigger | What It Does |
|------|---------|--------------|
| `agent:bootstrap` | Every session start | Injects durable state, decisions, bulletin, snapshot, and entitlements into context |
| `memory:flush` | Before OpenClaw context compaction | Syncs MEMORY.md from persisted state, writes compaction marker to daily log |

## Skills

### solana-trader (Trading Skill v5)
The primary skill that teaches OpenClaw the complete trading lifecycle:

1. **SCAN** — Find opportunities with launch/hot-pair scanners
2. **ANALYZE** — Deep dive with 6 token analysis tools
3. **THESIS** — Assemble full context with build_thesis
4. **DECIDE** — Agent reasons over data using confidence scoring
5. **PRECHECK** — Validate against risk rules
6. **EXECUTE** — Place trade via SpyFly
7. **MONITOR** — Watch positions and capital
8. **REVIEW** — Journal outcomes honestly
9. **EVOLVE** — Update strategy weights based on performance

Includes: token lifecycle framework, anti-rug heuristics, volume pattern reading, FOMO detection, liquidity-relative sizing, house money exits, dead money rule, narrative awareness, 3-layer memory architecture, deterministic compute tools.

### social-intel (Alpha Feed & Social Intelligence)
Standalone skill for SpyFly alpha feed integration and social intelligence:

- **SpyFly Alpha Feed** — Query recent alpha calls, historical accuracy, price milestone pings
- **Token Social Metadata** — Resolve on-chain metadata to find Twitter/Telegram/Discord links
- **Twitter Community Stats** — Follower count, engagement, growth trajectory, MC-relative benchmarking
- **Twitter Trending** — Narrative/meta detection from viral crypto topics

This skill is designed to merge into the trading skill when both are ready.

## Example Conversation

```
User: Start scanning for opportunities

Agent: Let me check the current market conditions and scan for new tokens.

[calls solana_market_regime]
Market is in a bullish regime with high DEX volume.

[calls solana_scan_launches]
Found 5 new launches in the last hour. POPCAT at 0x7a... looks interesting — high initial volume.

[calls solana_build_thesis with POPCAT address]
Thesis package shows:
- Strong buy pressure (68% buy ratio)
- Adequate liquidity ($180k)
- Holder concentration at 35% (acceptable)
- My strategy weights favor volume_momentum (0.28) — this token scores well there
- No prior trades on this token in my memory
- Risk pre-screen: approved, capped at 0.5 SOL

Based on the thesis data and my learned weights, I'll enter a small position.

[calls solana_trade_precheck]
Approved. Capped size: 0.5 SOL.

[calls solana_trade_execute]
Trade executed. TradeId: 15, PositionId: 4, TX: 5xK...

I'll monitor this position and review after exit.
```

## Troubleshooting

**Plugin won't load:**
- Run `traderclaw status` to check connectivity
- Check `openclaw plugins list` for errors
- Verify `openclaw.plugin.json` exists in the plugin directory

**"apiKey is required" error:**
- Run `traderclaw setup` to configure your API key
- Or manually add `apiKey` to your config: `traderclaw config set apiKey sk_live_...`

**"Could not reach orchestrator" warning:**
- Run `traderclaw status` to diagnose
- Check your internet connection
- Verify the orchestrator URL: `traderclaw config show`

**"Wallet not found" errors:**
- Run `traderclaw setup` to create or select a wallet
- Verify the wallet ID: `traderclaw config show`

**Tools returning errors:**
- Run `traderclaw status` to check system health
- Check if kill switch is enabled
- Verify your wallet has sufficient SOL balance

**Memory/state not persisting:**
- Check that the `dataDir` config points to a writable location
- Default is `<cwd>/.traderclaw-v1-data` — verify permissions
- Check `MEMORY.md` exists at project root after first `solana_state_save` call
- Check `memory/` directory for daily log files
