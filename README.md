# solana-traderclaw (TraderClaw V1 — team features)

Team edition of the TraderClaw V1 plugin for autonomous Solana memecoin trading. Full V1 trading capabilities plus 5 X/Twitter tools for journaling and community engagement. Connects OpenClaw to a trading orchestrator that handles market data, risk enforcement, and trade execution. Includes a full memory layer with local persistence, episodic logging, deterministic compute tools, and OpenClaw-native memory integration.

## Architecture

```
OpenClaw Agent (brain: reasoning, decisions, strategy evolution)
       │
       │ calls 72 typed tools (67 trading + 5 X)
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
  └── OpenClaw workspace (default ~/.openclaw/workspace/, auto-loaded every session)
        ├── STATE.md (machine-written durable state from solana_state_save)
        ├── MEMORY.md (optional — your narrative notes; not overwritten by state save)
        └── memory/YYYY-MM-DD.md (daily logs — today + yesterday)
```

The plugin gives OpenClaw tools to interact with the Solana trading orchestrator. The orchestrator gathers market data, enforces risk rules, and proxies trades. OpenClaw does all reasoning, decision-making, and strategy evolution. The plugin also manages a 3-layer memory system that eliminates amnesia between sessions.

## Prerequisites

- OpenClaw v2026.1+ with Node >= 22
- An API key from [traderclaw.ai/register](https://traderclaw.ai/register)

## Quick Start

### 1. Install the plugin

Install the **npm package** **`solana-traderclaw`**. The **OpenClaw plugin id** in `openclaw.json` stays **`solana-trader`** (same as `openclaw.plugin.json`). The global CLI binary is **`traderclaw`**.

```bash
npm install -g solana-traderclaw@1.0.20
```

Or install directly into OpenClaw:

```bash
openclaw plugins install solana-traderclaw@1.0.20
```

**Names:** `solana-traderclaw` is the canonical npm package (this release includes X/Twitter journal tools). Older names may still resolve on npm for a time; prefer **`solana-traderclaw`**. OpenClaw may log a benign id hint if the npm package name and manifest `id` differ — config keys remain **`plugins.entries.solana-trader`**.

### 2. Run setup

```bash
traderclaw setup
```

The setup wizard will:
- Ask for your API key (from [traderclaw.ai/register](https://traderclaw.ai/register))
- Connect to the orchestrator and validate your key
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

This opens a localhost UI that runs prechecks, lane-aware setup, gateway validation, optional Telegram setup, and final verification. It also installs **`HEARTBEAT.md` into your OpenClaw agent workspace root** (default `~/.openclaw/workspace/HEARTBEAT.md`) from the packaged skill so heartbeats load the TraderClaw checklist without manual `cp`. `traderclaw setup` does the same.

### Optional: Run CLI prechecks directly

```bash
traderclaw precheck --dry-run --output linux-qa-dryrun.log
traderclaw precheck --allow-install --output linux-qa-install.log
```

Use `--dry-run` for non-mutating validation and `--allow-install` for guided dependency installs.

### 3. Run the mandatory startup sequence

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

Available config keys: `orchestratorUrl`, `walletId`, `apiKey`, `apiTimeout`, `refreshToken`, `walletPublicKey`, `walletPrivateKey`, `gatewayBaseUrl`, `gatewayToken`, `agentId`

Wallet proof note: if login/session challenge requires wallet ownership proof, provide the key at runtime with `--wallet-private-key` or `TRADERCLAW_WALLET_PRIVATE_KEY`. It is used for local signing only and is not stored in `~/.openclaw/openclaw.json`.

**Gateway process:** Telegram and other channels talk to the **OpenClaw gateway** process. That process must be able to read `TRADERCLAW_WALLET_PRIVATE_KEY` when the session refresh fails and a new challenge runs. Exporting the variable only in your SSH session does **not** set it for **systemd** (or Docker, etc.). Configure it in the gateway unit’s environment per the troubleshooting guide below.

**`traderclaw login`:** Uses the saved refresh token when valid (no wallet key needed). Use `traderclaw login --force-reauth` when you intentionally want a full API challenge (e.g. after `traderclaw logout`).

**Session / auth / startup issues:** follow the official guide — [Installation → Troubleshooting (session expired, auth, logged out)](https://docs.traderclaw.ai/docs/installation#troubleshooting-session-expired-auth-errors-or-the-agent-logged-out).

### `traderclaw --help`

Print all available commands and options.

### `traderclaw --version`

Print plugin version.

## Advanced: Manual Configuration

If you prefer to configure manually instead of using the CLI, add to `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
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

### Layer 1: Durable state (`STATE.md`) and narrative (`MEMORY.md`)

OpenClaw loads workspace markdown from the agent workspace root. **`STATE.md`** is updated by `solana_state_save` with a human-readable mirror of durable facts (tier, wallet, mode, strategy version, watchlist, permanent learnings, regime canary). **`MEMORY.md`** is for your own notes — the plugin does not overwrite it. JSON state still lives under `.traderclaw-v1-data/state/` as before.

### Layer 2: Episodic Memory (Daily Logs + Bootstrap Injection)

Two auto-loaded sources:
- **Daily logs** (`memory/YYYY-MM-DD.md`) — OpenClaw auto-loads today + yesterday's files. Written via `solana_daily_log`.
- **Bootstrap injection** — The `agent:bootstrap` hook auto-injects durable state, last 50 decisions, team bulletin (last 6h), context snapshot, and entitlements into agent context at session start.

### Layer 3: Deep Knowledge (Server-Side Memory)

Unlimited retention via the orchestrator API. `solana_memory_write` / `solana_memory_search` / `solana_memory_by_token` for storing and retrieving historical trades, lessons, and patterns.

### Memory Flush Hook

The `memory:flush` hook fires automatically when OpenClaw is about to trim context. It syncs **`STATE.md`** from the last persisted JSON state and writes a compaction marker to the daily log. This is an automatic safety net — no agent action needed.

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

Plus OpenClaw workspace paths (default `~/.openclaw/workspace/`):
```
STATE.md                    # Machine-written durable state mirror (from solana_state_save)
MEMORY.md                   # Optional agent narrative (not overwritten by the plugin)
memory/
├── 2026-03-19.md           # Today's daily log (auto-loaded by OpenClaw)
├── 2026-03-18.md           # Yesterday's daily log (auto-loaded by OpenClaw)
└── ...                     # Auto-pruned after 7 days
```

## X/Twitter Setup

The team edition includes 5 X/Twitter tools for trade journaling and community engagement. Setup requires an X Developer App.

### 1. Create an X Developer App

1. Go to [developer.x.com](https://developer.x.com) and sign in
2. Create a new App (Free tier is sufficient for posting — 1,500 tweets/month)
3. Note your **Consumer Key** and **Consumer Secret**
4. Under "User authentication settings", enable OAuth 1.0a with Read and Write permissions
5. Generate **Access Token** and **Access Token Secret** for the account that will post

### 2. Configure via Environment Variables

```bash
export X_CONSUMER_KEY="your-app-consumer-key"
export X_CONSUMER_SECRET="your-app-consumer-secret"
export X_ACCESS_TOKEN_MAIN="your-access-token"
export X_ACCESS_TOKEN_MAIN_SECRET="your-access-token-secret"
```

The installer will pick these up automatically during the `x_credentials` step.

### 3. Or Configure via Plugin Config

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
| Free | $0 | 1,500 posts/month (write-only) |
| Pay-as-you-go | Per-credit | Read access (mentions, search, threads) |
| Basic | $200/month | Higher limits, more read access |

Free tier is sufficient for daily trade journaling. Pay-as-you-go is recommended if you want to read mentions and search.

## Available Tools (72 — 67 trading + 5 X)

### Scanning
| Tool | Description |
|------|-------------|
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
| `solana_trade_execute` | Execute trade via SpyFly bot |

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
| `solana_killswitch` | Toggle emergency kill switch |
| `solana_killswitch_status` | Check kill switch state |

### Wallet
| Tool | Description |
|------|-------------|
| `solana_capital_status` | Balance, positions, PnL, limits |
| `solana_positions` | Current positions with PnL |
| `solana_funding_instructions` | Deposit instructions |
| `solana_wallets` | List all wallets |
| `solana_wallet_create` | Create a new wallet |

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
| `solana_alpha_subscribe` | Subscribe to alpha signal WebSocket feed |
| `solana_alpha_unsubscribe` | Unsubscribe from alpha feed |
| `solana_alpha_signals` | Retrieve buffered alpha signals |
| `solana_alpha_history` | Query historical alpha signals |
| `solana_alpha_sources` | Get source reputation statistics |

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
| `solana_runtime_status` | Get runtime status diagnostics |

### Local Durable State
| Tool | Description |
|------|-------------|
| `solana_state_save` | Save agent state to local JSON (also writes STATE.md under the workspace) |
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
| `solana_classify_deployer_risk` | Deployer wallet risk classification (LOW/MODERATE/HIGH/CRITICAL) |

### Deep Analysis
| Tool | Description |
|------|-------------|
| `solana_history_export` | Export decision logs + optionally server-side data (trades, memory, strategy) |
| `solana_pattern_store` | Read/write/list named trading patterns |

### OpenClaw Native Memory
| Tool | Description |
|------|-------------|
| `solana_daily_log` | Append to today's daily log (auto-loaded by OpenClaw next session, 7-day prune) |

### X/Twitter
| Tool | Description |
|------|-------------|
| `x_post_tweet` | Post a tweet from the agent's configured X profile (max 280 chars) |
| `x_reply_tweet` | Reply to a specific tweet |
| `x_read_mentions` | Read recent @mentions (pay-as-you-go tier) |
| `x_search_tweets` | Search recent tweets by keyword/hashtag |
| `x_get_thread` | Read a full conversation thread |

## Hooks (2)

| Hook | Trigger | What It Does |
|------|---------|--------------|
| `agent:bootstrap` | Every session start | Injects durable state, decisions, bulletin, snapshot, and entitlements into context |
| `memory:flush` | Before OpenClaw context compaction | Syncs STATE.md from persisted state, writes compaction marker to daily log |

## Skills

### solana-trader (Trading Skill v5)
The primary skill that teaches OpenClaw the complete trading lifecycle:

1. **SCAN** — Find opportunities with launch/hot-pair scanners
2. **ANALYZE** — Deep dive with 5 token analysis tools
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

## Session and file reload

- **Telegram:** use **`/new`** to start a fresh chat thread or **`/reset`** to reset session state with your provider, as supported by your Telegram bot integration.
- **After editing workspace files** (`HEARTBEAT.md`, `STATE.md`, `MEMORY.md`, skills): restart the gateway so changes are picked up consistently: `openclaw gateway restart`.
- **History:** OpenClaw may not ship `openclaw agents clear-history` on your build — do not rely on that subcommand; prefer Telegram session commands and gateway restart.
- **Heartbeats:** fresh installs set `heartbeat.target: "telegram"`, `isolatedSession: true`, `lightContext: true`, and `channels.defaults.heartbeat.showOk: true` so scheduled cycles deliver reliably (see installer `configureGatewayScheduling`).

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

**Wizard (`traderclaw install --wizard`) fails on `install_plugin_package` with `ENOENT` / `…/solana-traderclaw/package.json` / `file:solana-traderclaw`:**
- Older installers used `spawn` with `shell: true`, which on Linux could drop npm’s argv so npm treated the package as a **local folder** under cwd (`/root` or `/tmp`). Current installers use **`shell: false`**, explicit **`--registry https://registry.npmjs.org/`** for registry installs, **`solana-traderclaw@latest`**, and a temp **`cwd`**. Upgrade `solana-traderclaw` and retry. If a stray directory `./solana-traderclaw` exists under that cwd, remove it: `rm -rf /tmp/solana-traderclaw` (and under `/root` if present).

**Heartbeat not sending messages to Telegram:**
- **Fresh `traderclaw setup`:** the installer runs `configureGatewayScheduling`, which sets a custom `heartbeat.prompt` on the `main` agent (no `HEARTBEAT_OK` escape). You only need the manual `openclaw config set` command below if you are on an older install or overwrote `agents.list`.
- **`HEARTBEAT.md` must live in the agent workspace root** (default `~/.openclaw/workspace/HEARTBEAT.md`, next to `AGENTS.md`). A copy under `workspace/.openclaw/` or only inside the plugin package is **not** loaded as the heartbeat checklist. Copy from `skills/solana-trader/HEARTBEAT.md` in the installed package if needed. See [OpenClaw agent workspace](https://docs.openclaw.ai/concepts/agent-workspace).
- OpenClaw's default heartbeat prompt tells the model "If nothing needs attention, reply HEARTBEAT_OK" — which is stripped and never delivered. Run `traderclaw setup` again (v1.0.16+) to set a custom prompt, or apply manually:

```bash
openclaw config set agents.list '[{"id":"main","default":true,"heartbeat":{"every":"30m","target":"telegram","isolatedSession":true,"lightContext":true,"prompt":"Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Execute a full trading cycle: Steps 0 through 10. The cycle is NOT complete until all 10 steps are done including Step 8 (memory write-back), Step 9 (X post), and Step 10 (report). Do not stop early. Do not infer or repeat old tasks from prior chats. Never reply HEARTBEAT_OK. Never end your message with a question."}}]'
openclaw gateway restart
```

- Verify with `openclaw config get agents` — the `main` agent should have `heartbeat.prompt`, `target`, `isolatedSession`, and `lightContext`.
- Confirm Telegram is healthy: `openclaw channels status --probe`
- Prefer `target: "telegram"` over `"last"` so delivery does not depend on a prior channel contact.

**Scheduled cron jobs run but you never see Telegram/WhatsApp output:**
- The installer merges **six** prescriptive managed jobs (`alpha-scan`, `dead-money-sweep`, `source-reputation-recalc`, `meta-rotation-analysis`, `strategy-evolution`, `daily-performance-report`). Older templates such as `subscription-cleanup` or `whale-watch` are no longer in that managed set; re-run **`traderclaw setup`** to refresh `~/.openclaw/cron/jobs.json`, or edit jobs manually. User-defined cron jobs whose ids are not in the template set are preserved on merge.
- TraderClaw templates merged into `~/.openclaw/cron/jobs.json` use **`delivery.mode: "announce"`** with **`channel: "last"`** so each completed isolated job posts a summary to the same channel you last used (see [OpenClaw cron delivery](https://docs.clawd.bot/automation/cron-jobs)).
- If you installed before this behavior: run **`traderclaw setup`** again so the installer re-merges cron jobs, or stop the gateway and edit managed job entries in `~/.openclaw/cron/jobs.json` — set **`delivery`** to `{ "mode": "announce", "channel": "last", "bestEffort": true }` for each TraderClaw job (or remove `delivery` entirely; isolated jobs default to announce when omitted).
- The same **`last`** requirement as heartbeat applies: message the bot at least once so the gateway knows where to deliver.

**Tools returning errors:**
- Run `traderclaw status` to check system health
- Check if kill switch is enabled
- Verify your wallet has sufficient SOL balance

**Memory/state not persisting:**
- Check that the `dataDir` config points to a writable location
- Default is `<cwd>/.traderclaw-v1-data` — verify permissions
- Check **`STATE.md`** exists under `~/.openclaw/workspace/` after first `solana_state_save` call (not `process.cwd()` — required for systemd installs)
- Check `memory/` under the same workspace for daily log files

**X / Twitter posting:** with X credentials and skills aligned, `x_post_tweet` has been validated end-to-end in production installs after config + workspace updates.
