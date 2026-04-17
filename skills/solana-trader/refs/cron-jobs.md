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

## Job: `alpha_scan`

**Schedule:** Every 3 hours (`0 */3 * * *`) — 8 runs/day

**Purpose:** Scan new token launches, filter candidates, score quality, log alpha signals.

**Tools:** `solana_scan_launches`, `solana_token_snapshot`, `solana_token_holders`, `solana_token_risk`, `solana_alpha_log`, `solana_memory_write`

**Workflow:** Scan launches → filter (vol>30K, mcap>10K, liq>5K) → snapshot survivors → quality filter (top10 <50%, deployer <3 abandoned, has social) → score 0-100 → log 65+ via alpha_log.

**Configuration:**
- Model: Sonnet (judgment — scoring candidates, filtering quality signals)
- Thinking: off
- lightContext: on
- Delivery: announce/last/bestEffort

---

## Job: `portfolio_health`

**Schedule:** Every 4 hours (`0 */4 * * *`) — 6 runs/day

**Purpose:** Combined dead-money sweep + whale activity scan + portfolio risk audit. Replaces the old separate `dead_money_sweep`, `whale_watch`, and `risk_audit` jobs.

**Tools:** `solana_capital_status`, `solana_positions`, `solana_token_snapshot`, `solana_token_holders`, `solana_trade_execute` (defensive exits), `solana_trade_review`, `solana_memory_write`, `solana_killswitch_status`

**Workflow:** Capital + positions → per-position snapshot → dead money exit (loss>40% or 90min+down+low vol) → whale flags (>5% supply moves) → risk checks (concentration/drawdown/exposure) → sell if CRITICAL → write tag 'portfolio_health'.

**Configuration:**
- Model: Sonnet (judgment — dead money exits, whale flags, risk assessment)
- Thinking: off
- lightContext: on
- Delivery: announce/last/bestEffort

---

## Job: `trust_refresh`

**Schedule:** Every 8 hours (`0 */8 * * *`) — 3 runs/day

**Purpose:** Combined source reputation recalculation + deployer trust refresh. Replaces the old separate `source_reputation_recalc` and `source_trust_refresh` jobs.

**Tools:** `solana_source_trust_refresh`, `solana_deployer_trust_refresh`, `solana_alpha_sources`, `solana_trades`, `solana_source_trust_get`, `solana_deployer_trust_get`, `solana_memory_write`

**Workflow:** Run both refresh functions → read source/deployer scores → flag any below 30 → write tag 'trust_refresh'.

**Configuration:**
- Model: Haiku (mechanical — run refresh functions, read/flag scores)
- Thinking: off
- lightContext: on
- Delivery: none

---

## Job: `meta_rotation_analysis`

**Schedule:** Every 8 hours, offset by 30 min (`30 */8 * * *`) — 3 runs/day

**Purpose:** Analyze which narrative metas are hot, cooling, or dead.

**Tools:** `x_search_tweets`, `solana_scan_launches`, `solana_memory_search`, `solana_memory_write`

**Workflow:** Search X/Twitter trending → scan launches → categorize by narrative cluster → per-cluster metrics → compare vs prior rotation → declare hot/fading → write tag 'meta_rotation'.

**Configuration:**
- Model: Sonnet (judgment — categorize narratives, detect rotation)
- Thinking: off
- lightContext: on
- Delivery: announce/last/bestEffort

---

## Job: `strategy_evolution`

**Schedule:** Daily at 06:00 UTC (`0 6 * * *`) — 1 run/day

**Purpose:** Full self-improvement cycle — recurring pattern detection, drift investigation, ADL/VFM-validated weight adjustments, named pattern recognition, discovery filter evolution.

**Full details:** → refs/strategy-evolution.md

**Tools:** `solana_journal_summary`, `solana_strategy_state`, `solana_memory_search`, `solana_trades`, `solana_strategy_update`, `solana_memory_write`

**Workflow:** Journal summary → gate on 10+ closed trades → bucket by confidence tier → current weights → analyze tier performance → conservative adjustments (max 10% per weight per cycle) → write tag 'strategy_evolution'.

**Configuration:**
- Model: Sonnet (deep reasoning — weight adjustments, pattern detection)
- Thinking: **on** (multi-step reasoning chain benefits from extended thinking)
- lightContext: **off** (needs full strategy state, historical patterns, workspace context)
- Delivery: announce/last/bestEffort

---

## Job: `subscription_cleanup`

**Schedule:** Every 8 hours, offset by 15 min (`15 */8 * * *`) — 3 runs/day

**Purpose:** Manage Bitquery subscription lifecycle — remove orphaned subscriptions, reopen expiring ones.

**Tools:** `solana_positions`, `solana_bitquery_subscriptions`, `solana_bitquery_unsubscribe`, `solana_bitquery_subscription_reopen`, `solana_memory_write`

**Workflow:** List open position CAs → list active subs (if AUTH_SCOPE_MISSING, log and stop) → match subs to positions → unsubscribe orphans → write tag 'subscription_cleanup'.

**Configuration:**
- Model: Haiku (mechanical — match subs to positions, unsubscribe orphans)
- Thinking: off
- lightContext: on
- Delivery: announce/last/bestEffort

---

## Job: `daily_performance_report`

**Schedule:** Daily at 04:00 UTC (`0 4 * * *`) — 1 run/day

**Purpose:** Comprehensive daily performance summary.

**Gating:** Only if trading activity in past 24 hours. Check via `solana_journal_summary`.

**Tools:** `solana_journal_summary`, `solana_positions`, `solana_capital_status`, `solana_trades`, `solana_strategy_state`, `solana_memory_search`, `solana_memory_write`

**Outputs:** Memory entry with: daily PnL, win/loss count, win rate, best/worst trades, avg hold time, capital utilization, regime summary, lessons. Tag: `daily_report`.

**Configuration:**
- Model: Sonnet (judgment — compile narrative report with recommendations)
- Thinking: off
- lightContext: **off** (needs complete workspace context for comprehensive report)
- Delivery: announce/**telegram**

---

## Job: `intelligence_lab_eval`

**Schedule:** Daily at 16:00 UTC (`0 16 * * *`) — 1 run/day

**Purpose:** Run intelligence lab evaluation — compute model accuracy, compare champion vs challenger, generate replay reports.

**Tools:** `solana_candidate_get`, `solana_evaluation_report`, `solana_model_registry`, `solana_replay_run`, `solana_replay_report`, `solana_model_promote`, `solana_memory_write`

**Workflow:** Check candidate count (gate on 20+) → evaluation report → check for challengers → replay eval if challenger exists → promote if >5% F1 improvement → write tag 'intelligence_lab'.

**Configuration:**
- Model: Sonnet (deep reasoning — model comparison, promotion decisions)
- Thinking: **on** (requires careful reasoning about statistical significance)
- lightContext: **off** (needs full model registry context and evaluation history)
- Delivery: none

---

## Job: `memory_trim`

**Schedule:** Daily at 03:00 UTC (`0 3 * * *`) — 1 run/day

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

**Configuration:**
- Model: Haiku (mechanical — prune old entries, simple retention logic)
- Thinking: off
- lightContext: on
- Delivery: none

---

## Job: `balance_watchdog`

**Schedule:** Every 2 hours (`0 */2 * * *`) — 12 runs/day

**Purpose:** Context snapshot drift correction — compare real wallet/position state against believed state, correct mismatches.

**Tools:** `solana_capital_status`, `solana_positions`, `solana_context_snapshot_read`, `solana_context_snapshot_write`

**Workflow:** Read real state (capital + positions) → read believed state (context snapshot) → compare → if mismatch: write corrected snapshot, summarize changes → if match: reply WATCHDOG_OK.

**Configuration:**
- Model: Haiku (mechanical — compare real vs believed state, correct drift)
- Thinking: off
- lightContext: on
- Delivery: announce/**telegram**

---

## Schedule Summary

| # | Job ID | Cron Expression | Runs/Day | Model | Thinking | lightContext | Delivery |
|---|--------|----------------|----------|-------|----------|-------------|----------|
| 1 | `alpha-scan` | `0 */3 * * *` | 8 | Sonnet | off | on | announce/last |
| 2 | `portfolio-health` | `0 */4 * * *` | 6 | Sonnet | off | on | announce/last |
| 3 | `trust-refresh` | `0 */8 * * *` | 3 | Haiku | off | on | none |
| 4 | `meta-rotation` | `30 */8 * * *` | 3 | Sonnet | off | on | announce/last |
| 5 | `strategy-evolution` | `0 6 * * *` | 1 | Sonnet | **on** | **off** | announce/last |
| 6 | `subscription-cleanup` | `15 */8 * * *` | 3 | Haiku | off | on | announce/last |
| 7 | `daily-performance-report` | `0 4 * * *` | 1 | Sonnet | off | **off** | announce/telegram |
| 8 | `intelligence-lab-eval` | `0 16 * * *` | 1 | Sonnet | **on** | **off** | none |
| 9 | `memory-trim` | `0 3 * * *` | 1 | Haiku | off | on | none |
| 10 | `balance-watchdog` | `0 */2 * * *` | 12 | Haiku | off | on | announce/telegram |
| | **Total** | | **39** | | | | |
