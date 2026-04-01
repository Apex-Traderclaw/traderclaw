# Cron Jobs — Full Reference

Cron jobs run in **isolated sessions** separate from the trading loop. Each job gets its own context window, runs independently, and produces outputs that persist in strategy state and memory.

If a cron job fails, the fast loop continues unaffected — failures are retried on the next scheduled run.

When you receive a `CRON_JOB:` message, execute ONLY the specified job. Do not run the trading loop.

## Memory Context Load (mandatory for every cron job)

Before executing any cron job:
1. **MEMORY.md** (auto-loaded): tier, wallet, mode, strategy version
2. **Daily log** (auto-loaded): today's activity, prior cron runs
3. **Server-side memory**: `solana_memory_search` for job-specific context

## Idempotency Rule

At start of every cron job, check whether sufficient new data exists since last run. If not, exit early.

---

## Job: `strategy_evolution`

**Schedule:** Every 4 hours (`0 */4 * * *`)

**Purpose:** Full self-improvement cycle — recurring pattern detection, drift investigation, ADL/VFM-validated weight adjustments, named pattern recognition, discovery filter evolution.

**Full details:** → refs/strategy-evolution.md

**Tools:** `solana_journal_summary`, `solana_strategy_state`, `solana_memory_search`, `solana_trades`, `solana_strategy_update`, `solana_memory_write`

**Report to user:** What weights changed (if any), key patterns detected, strategy trending direction.

---

## Job: `daily_performance_report`

**Schedule:** Daily at 04:00 UTC (`0 4 * * *`)

**Purpose:** Comprehensive daily performance summary.

**Gating:** Only if trading activity in past 24 hours. Check via `solana_journal_summary`.

**Context retrieval:**
- `solana_memory_search` with `"daily_report"` — yesterday's report for comparison
- `solana_memory_search` with `"strategy_evolution"` — most recent evolution cycle

**Tools:** `solana_journal_summary`, `solana_positions`, `solana_capital_status`, `solana_trades`, `solana_memory_search`, `solana_memory_write`

**Outputs:** Memory entry with: daily PnL, win/loss count, win rate, best/worst trades, avg hold time, capital utilization, regime summary, lessons. Tag: `daily_report`.

---

## Job: `source_reputation_recalc`

**Schedule:** Every 3 hours (`0 */3 * * *`)

**Purpose:** Analyze which alpha sources led to wins vs losses. Maintain per-source reputation scores.

**Gating:** New trade outcomes on alpha-sourced positions since last recalc.

**Workflow:**
1. Retrieve last recalc state from memory
2. Query recent alpha-sourced trade outcomes
3. Calculate per-source metrics (win rate, avg PnL, conversion rate)
4. Compute reputation score (0-100)
5. Historical analysis via `solana_alpha_history`
6. Store updated scores with tag `source_reputation`

**Tools:** `solana_memory_search`, `solana_trades`, `solana_alpha_history`, `solana_alpha_sources`, `solana_memory_write`

---

## Job: `dead_money_sweep`

**Schedule:** Every 2 hours (`0 */2 * * *`)

**Purpose:** Find and exit positions that are dead money.

**Criteria (ALL must be true):**
1. Loss > 40%
2. Held 90+ minutes AND still down 5%+
3. 24h volume < $5,000
4. Price flat (±5%) for 4+ hours

**Tools:** `solana_positions`, `solana_token_snapshot`, `solana_trade_execute` (for exits), `solana_trade_review`, `solana_memory_write`, `solana_sweep_dead_tokens` (sell losing positions below threshold — use `dryRun: true` first to preview, then without to execute)

**PnL check:** For Solana positions, use `unrealizedPnl` / `realizedPnl` from `solana_positions`. Those fields are SOL-native on that endpoint.

**Report to user:** List positions exited as dead money with hold duration and loss amount. Include any rent SOL recovered from sweep.

---

## Job: `subscription_cleanup`

**Schedule:** Every hour (`0 * * * *`)

**Purpose:** Manage Bitquery subscription lifecycle.

**Workflow:**
1. List active subscriptions via `solana_bitquery_subscriptions`
2. Reopen subscriptions nearing 24h expiry via `solana_bitquery_subscription_reopen`
3. Unsubscribe from tokens no longer held or monitored
4. Verify critical subscriptions (discovery streams) are healthy

**Tools:** `solana_bitquery_subscriptions`, `solana_bitquery_subscription_reopen`, `solana_bitquery_unsubscribe`, `solana_positions`

---

## Job: `meta_rotation_analysis`

**Schedule:** Every 3 hours, offset by 30 min (`30 */3 * * *`)

**Purpose:** Analyze which narrative metas are hot, cooling, or dead.

**Workflow:**
1. Review recent scan results and alpha signals for narrative patterns
2. Group tokens by narrative cluster (AI, animals, political, culture, etc.)
3. Compare volume/momentum trends across clusters
4. Identify hot metas (rising volume) and cooling metas (declining volume)
5. Log observations with tag `meta_rotation`

**Tools:** `solana_memory_search`, `solana_alpha_history`, `solana_memory_write`

---

## Job: `intelligence_lab_eval`

**Schedule:** Every 12 hours (`0 */12 * * *`)

**Purpose:** Run intelligence lab evaluation — compute model accuracy, compare champion vs challenger, generate replay reports.

**Workflow:**
1. Check candidate dataset size via `solana_candidate_get`
2. Run evaluation report: `solana_evaluation_report`
3. If challenger model exists, run replay: `solana_replay_run` + `solana_replay_report`
4. If challenger outperforms champion, promote: `solana_model_promote`
5. Refresh source/deployer trust scores: `solana_source_trust_refresh`, `solana_deployer_trust_refresh`

**Tools:** `solana_candidate_get`, `solana_evaluation_report`, `solana_replay_run`, `solana_replay_report`, `solana_model_promote`, `solana_source_trust_refresh`, `solana_deployer_trust_refresh`, `solana_memory_write`

---

## Job: `memory_trim`

**Schedule:** Daily at 03:00 UTC (`0 3 * * *`)

**Purpose:** Smart memory compaction — trims local memory footprint to the last 2 days while preserving all critical data (positions, rules, identity, strategy weights, permanent learnings).

**What gets trimmed:**
1. Daily logs (`memory/YYYY-MM-DD.md`) older than 2 days
2. Stale durable state keys — empty objects/arrays, null values, keys with timestamps older than 2 days. Protected keys (tier, walletId, mode, strategyVersion, featureWeights, permanentLearnings, namedPatterns, discoveryFilters, watchlist, consecutiveLosses, totalTrades, winCount, lossCount, peakCapital, etc.) are NEVER removed
3. Watchlist entries — stale timestamped entries removed, then capped to most recent 10
4. Decision log entries older than 2 days (trade_entry/trade_exit/position_update/killswitch entries retained for 7 days)
5. Team bulletin entries older than 2 days (minimum 20 entries always kept)
6. Stale context snapshots — only the newest snapshot file is kept, older ones are deleted

**Reports:** Summary includes `bytesFreed` and `bytesFreedMB` for all operations

**What is NEVER touched:** Identity state keys, skill files, server-side memory, permanentLearnings array, active position data

**Workflow:**
1. Call `solana_memory_trim` with `dryRun: true` to preview
2. Review summary — verify no critical data flagged
3. Call `solana_memory_trim` with `retentionDays: 2` to execute
4. Log results via `solana_memory_write` with tag `memory_trim`

**Tools:** `solana_memory_trim`, `solana_memory_write`
