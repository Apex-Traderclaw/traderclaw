# Trading Heartbeat

**Installer:** `traderclaw install --wizard` and `traderclaw setup` copy this file into your OpenClaw **agent workspace root** (default `~/.openclaw/workspace/HEARTBEAT.md`). OpenClaw only loads `HEARTBEAT.md` from that directory (next to `AGENTS.md`), not from a nested `.openclaw` folder or from the plugin package alone. If you already have a non-empty `HEARTBEAT.md` there, the installer leaves it unchanged.

Execute your full trading cycle from your solana-trader skill on every heartbeat. Never skip. Never reply HEARTBEAT_OK.

## First: Check Startup State

Read MEMORY.md (auto-loaded). If it is empty or missing your wallet/tier/strategy info, you have NOT completed the Mandatory Startup Sequence yet. Run it now before doing anything else (see SKILL.md § Mandatory Startup Sequence).

If startup is already complete (MEMORY.md has your wallet, tier, mode, strategy version), proceed to the trading cycle below.

## Memory Context Load (every cycle, before trading)

1. **Layer 1 — MEMORY.md** (already in context): Read your durable state — tier, wallet, mode, strategy version, watchlist, regime canary, permanent learnings.
2. **Layer 2 — Daily log**: Check today's `memory/YYYY-MM-DD.md` (auto-loaded) to know what scans, trades, and analysis already happened today. Do not repeat work already done this cycle.
3. **Layer 3 — Server-side memory**: Call `solana_memory_search` for:
   - `"source_reputation"` — know which alpha sources to trust before processing signals
   - `"strategy_drift_warning"` — any recent drift alerts to be aware of
   - `"pre_trade_rationale"` — your last few trade decisions for strategy integrity check
   - `"meta_rotation"` — current hot vs cooling narratives

## Trading Cycle

Run the full fast loop from your skill:
- Step 0: Interrupt check — positions, kill switch, capital, strategy integrity, dead money
- Step 1: Scan for opportunities
- Step 1.5: Poll alpha signals buffer, check subscriptions for new events
- Step 2: Analyze candidates (token snapshot, holders, flows, liquidity, risk, social/community enrichment if X credentials configured)
- Step 3: Risk assessment and scoring
- Step 4: Decision — apply strategy weights, check memory for past outcomes on this token
- Step 5: Execute trade (pre-trade journal FIRST, then execute)
- Step 6: Monitor open positions for SL/TP triggers, social exhaustion check on held positions (if X configured)
- Step 7: Exit management — execute exits, post-trade review

## Memory Write-Back (after trading)

1. **Layer 1**: `solana_state_save` if any durable state changed (strategy weights, watchlist, regime, counters)
2. **Layer 2**: `solana_daily_log` with session summary (what you scanned, signals processed, trades made, positions monitored)
3. **Layer 3**: `solana_memory_write` for any new lessons, reputation observations, pre-trade rationale, or trade reviews

## Report to User

After every cycle, send a brief summary to the user:
- What you scanned and how many candidates were found
- Any alpha signals processed and their scores
- Trades executed (entries/exits) with token, size, and rationale
- Open position status (PnL, any SL/TP approaching)
- If nothing qualified for a trade, say what you checked and why nothing passed

Never run a silent cycle. Always communicate what you did.
