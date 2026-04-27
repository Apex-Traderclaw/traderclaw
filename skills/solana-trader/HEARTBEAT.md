# Trading Heartbeat

Execute your full trading cycle on every heartbeat. Never skip. Never reply HEARTBEAT_OK.

## Startup Check

Read MEMORY.md (auto-loaded). If empty or missing wallet/tier/strategy → run Mandatory Startup Sequence (SKILL.md § Mandatory Startup Sequence) before anything else. If startup complete, proceed.

## Memory Context Load

1. **MEMORY.md** (already in context): tier, wallet, mode, strategy version, watchlist, regime canary
2. **Daily log** (`memory/YYYY-MM-DD.md`, auto-loaded): what already happened today — don't repeat work
3. **Context engine** (automatic): `[TraderClaw Trading Context]` injected into system prompt at session start with current state, last 3 decisions, and entitlement limits. Just read it when present.
4. **Server-side memory** — call `solana_memory_search` for: `"source_reputation"`, `"strategy_drift_warning"`, `"pre_trade_rationale"`, `"meta_rotation"`
5. **QMD recall** — before analyzing any candidate, call `memory_search` with the token symbol or contract address. If seen before, use prior analysis to: skip repeat work, apply re-entry penalties, catch repeat rug patterns, reference prior confidence scores.

## User Preferences Override (apply before any other step)

If MEMORY.md contains a **User Preferences** section, those values override defaults in this document for this entire session.

| Preference key | What it overrides |
|---|---|
| `volumeMinUsd` | Min 24h volume filter in STEP 1 SCAN and alpha_scan cron (default: 50000) |
| `marketCapMinUsd` | Min market cap filter (default: 10000) |
| `maxPositionSizeSol` | Max position size in SOL (overrides entitlement cap if lower) |
| `scanMode` | `"conservative"` / `"standard"` / `"aggressive"` — adjusts confidence thresholds |
| `slPct` | Default stop-loss % for new positions (default: 20 HARDENED, 40 DEGEN) |
| `minConfidence` | Min confidence score to enter a trade (default: 0.65) |
| `narrativeFilter` | Comma-separated narrative clusters to focus on (e.g. `"AI,Gaming"`) |

Apply immediately. Durable — persists until user explicitly changes them.

---

## STEP 0: INTERRUPT CHECK

Call `solana_positions`, `solana_killswitch_status`, `solana_capital_status`.

**Position balance verification:** For any position where reported balance seems off, call `solana_wallet_token_balance` with the token mint to verify actual on-chain SPL `uiAmount` as source of truth.

**Kill switch active → halt all trading. No exceptions.**

**Deployer reputation check:** For each open position, call `solana_deployer_trust_get({ address: "<deployer_address>" })`. If trust score dropped significantly since entry (e.g., they launched another token that rugged), flag for immediate review.

**Dead money check — apply ALL four criteria:**
- Loss > 40%
- Held 90+ min AND still down 5%+
- 24h volume < $5,000
- Price flat (±5%) for 4+ hours

If ALL four true → exit immediately. Do NOT hold hoping for recovery. A position at -40% after 90 min with dead volume is NOT coming back.

**Strategy integrity:** Compare last 3 trade decisions (from memory) against feature weights. If actual decisions diverge from what weights would predict, log `strategy_drift_warning` via `solana_memory_write`.

## STEP 1: SCAN

Call `solana_scan_launches` for new launches and `solana_scan_hot_pairs` for hot pairs.

**Bitquery subscription events:** Check `solana_bitquery_subscriptions` for active streams. Process buffered events from real-time subscriptions. If no subscriptions active and first heartbeat of session, call `solana_bitquery_templates` to discover available templates and cache in memory.

## STEP 1.5: ALPHA SIGNALS

Call `solana_alpha_signals` to poll the buffer. Score and classify each signal by priority. Check `calledAgainCount` — multiple independent callers on same token = high conviction.

**Ingestion health:** If the buffer stays empty but the session should be live, check `solana_runtime_status` (alpha `stats.lastEventTs`, `subscribed`). When the WebSocket looks subscribed but signals stopped arriving, call `solana_alpha_subscribe({ force: true })` or unsubscribe then subscribe again.

**Source trust check (mandatory before acting on any signal):**
```
solana_source_trust_get({ name: "<signal source>" })
solana_alpha_sources()
```
If trust score < 30 or win rate < 25%, downgrade signal priority by one tier. Do NOT skip low-trust signals entirely — still log them — but reduce their weight.

**Multi-source conflict detection:** If 2+ signals reference same token with conflicting `kind` values:
```
solana_contradiction_check({ claims: [{ source: "src1", claim: "bullish", confidence: 0.8 }, { source: "src2", claim: "bearish", confidence: 0.7 }] })
```
Log contradiction. Default to more cautious signal (risk/exit > ca_drop).

**Historical context:** Check prior signal history:
`solana_alpha_history({ tokenAddress: "CA", limit: 10 })`
If called before and outcome was a loss, apply re-entry penalty (-0.15 confidence).

## STEP 2: ANALYZE

For top candidates, call ALL — no exceptions:
- `solana_token_snapshot` — price, volume, OHLC, trade count
- `solana_token_holders` — holder distribution, concentration, dev holdings
- `solana_token_flows` — buy/sell pressure, unique traders
- `solana_token_liquidity` — pool depth, DEX breakdown
- `solana_token_risk` — composite risk profile
- `solana_token_socials` — social media / community metadata

**FRESH token deep scan (mandatory for tokens < 1h old):**
```
solana_bitquery_catalog({ templatePath: "pumpFunHoldersRisk.first100Buyers", variables: { token: "CA" } })
solana_compute_deployer_risk({ previousTokens: N, rugHistory: R, avgTokenLifespanHours: H })
solana_deployer_trust_get({ address: "<deployer_address>" })
```
first100Buyers reveals serial dumpers and insider clusters. Deployer risk gives deterministic HIGH/MEDIUM/LOW. HIGH risk → hard skip. MEDIUM → reduce sizing by 50%.

**Candidate recording (mandatory for EVERY analyzed token):**
```
solana_candidate_write({ id: "CA", tokenAddress: "CA", tokenSymbol: "SYMBOL", source: "scan|alpha|manual", signalScore: 75, signalStage: "early|confirmation|milestone|risk|exit", features: { volume_momentum: 0.8, buy_pressure: 0.6, liquidity: 0.7, holder_quality: 0.5 } })
```
Record with features BEFORE deciding whether to trade. Feeds the intelligence lab dataset. Every analyzed token gets written, whether you trade it or skip it.

**Social intel (mandatory for any token scoring above 0.60):**

Get structured social metadata: `solana_token_socials({ tokenAddress: "CA" })` — returns Twitter/X, Telegram, Discord, website links for cross-referencing.

Search X/Twitter for real-time sentiment: `x_search_tweets({ query: "$SYMBOL" })`
Check mention velocity, influencer clustering, sentiment tone. Cross-check X handles from `solana_token_socials` with actual tweet activity. If X tools fail, log error and continue — but you MUST attempt the call.

**Prompt scrubbing (mandatory for all external text):**
`solana_scrub_untrusted_text({ text: "<raw external text>", maxLength: 500 })`

**Website legitimacy check (mandatory for any token scoring above 0.60):**
1. Check if `solana_token_socials` returned a website URL. If not: `solana_bitquery_catalog({ templatePath: "pumpFunMetadata.tokenMetadataByAddress", variables: { token: "CA" } })`
2. If website found, fetch it: `web_fetch_url({ url: "<website_url>" })`
3. Analyze — tool returns `title`, `metaDescription`, `headings`, `socialLinks`, `outboundLinks`, `bodyText`.
4. Confidence adjustments:
   - Professional site with matching social links → +0.02
   - No website → neutral (many legit memecoins have no site)
   - Generic template with no real content → -0.01
   - Social links don't match on-chain metadata → -0.03 (red flag)
5. Cache: check `solana_memory_search` for `website_analyzed` before fetching. If analyzed in last 48h, reuse. After analysis, write via `solana_memory_write` tag `website_analyzed`.

**Token lifecycle classification:**
- FRESH (< 1h): Mint MUST be revoked, freeze MUST be inactive, LP MUST be burned/locked. Serial deployer (3+ tokens/24h) = hard skip. Volume >70% in first 15min = skip. EXPLORATORY SIZING ONLY (3-5% capital HARDENED, exploratory range DEGEN).
- EMERGING (1-24h): Top-10 concentration declining? Volume >20% of peak hour? Standard sizing.
- ESTABLISHED (>24h): Full sizing. Edge = flow analysis + narrative timing.

## STEP 3: RISK & SCORING

**Freshness decay (mandatory):**
`solana_compute_freshness_decay({ signalAgeMinutes: N, halfLifeMinutes: 30 })`
Apply returned decay factor to alpha signal scores.

**Use `solana_compute_confidence` — NEVER do manual math.** The tool returns deterministic results.

**Champion model scoring (if model exists):**
`solana_model_score_candidate({ modelId: "champion", features: { volume_momentum: 0.8, buy_pressure: 0.6, ... } })`
If score diverges from `compute_confidence` by >0.15, log via `solana_memory_write` tag `model_divergence`. Use the more conservative score.

**FOMO check BEFORE computing confidence:**
- Already moved +500% in <4h → skip
- Moved +200% from recent low → exploratory sizing only
- Seen 3+ cycles without entering → don't chase
- Just took a loss → that's revenge trading, slow down

**Confidence penalties (applied automatically by compute tool, but verify):**
- Risk flags: -0.05 to -0.15 per soft flag
- Top-10 > 25%: -(concentration% − 25) × 0.005
- Liquidity < $100K: -(100K − liquidity) / 1M
- 2+ losses in last 3: -0.10
- Lost on this token before: -0.15
- Token moved +200%: -0.15
- Serial deployer: -0.20

## STEP 4: DECIDE

**Use `solana_compute_position_limits` for sizing — NEVER calculate manually.**

**Hard caps (non-negotiable):**
- Position ≤ 2% of pool depth in USD. Pool < $50K → max $1,000 SOL equivalent.
- Mint authority active OR freeze authority active → HARD SKIP.
- Max 40% capital across same narrative cluster.

**Sizing reduction triggers (stack multiplicatively):**
- Win rate < 40% (last 10) → ×0.6
- DailyNotionalUsed > 70% → ×0.5
- 2+ consecutive losses → ×0.7
- 3+ open positions → ×0.8
- Concentration > 30% → ×0.5
- Token moved +200% → ×0.5
- Floor: 0.75% capital (HARDENED) / 1.25% (DEGEN)

**Exit plan (define BEFORE executing):**

| | HARDENED | DEGEN |
|---|---|---|
| Stop loss (`slExits`) | -20% on every position | -40% on every position |
| Take-profit exits (`tpExits`) | +100–300% (multiple) | +200–500% (multiple) |
| Trailing stop (`trailingStop`) | Structured levels with `triggerAboveATH` | Structured levels |

**CRITICAL:** Every `solana_trade_execute` call MUST include `tpExits` with multiple levels:
```
tpExits: [
  { percent: 100, amountPct: 30 },
  { percent: 200, amountPct: 100 }
]
```
HARDENED range: +100–300%. DEGEN range: +200–500%. `percent` = price increase from entry, `amountPct` = % of position to sell.

**Structured `trailingStop` with `levels` array** (preferred over legacy `trailingStopPct`):
- `percentage` — trailing drawdown % from armed high once level is active.
- `amount` — % of position to sell (1–100; server default `100`).
- `triggerAboveATH` — **optional.** Price must reach this % above session ATH before level arms. Default `100` (2× ATH). Use `trailingStopPct` for simpler single-level trailing.

**`slExits`** — e.g., `[{ percent: 20, amountPct: 100 }]` (HARDENED) or `[{ percent: 40, amountPct: 100 }]` (DEGEN). `percent` = price decrease from entry, `amountPct` = % of remaining position to sell.

**Slippage:** >$500K pool = 100-200bps, $100-500K = 200-400bps, $50-100K = 300-500bps, <$50K = 400-800bps (cap). Exit = 1.5× entry.

**House money:** At +100%, take initial capital out. Remaining = house money. Widen stops 50%, trailing only, no fixed TP.

## STEP 5: EXECUTE + ANNOUNCE

**Pre-trade journal FIRST** — call `solana_memory_write` with tag `pre_trade_rationale` BEFORE executing. Also call `solana_decision_log` to record the decision with confidence, sizing rationale, and risk factors.

**Source attribution (mandatory):** The `pre_trade_rationale` MUST include `source: "<how you found this token>"` — one of: `alpha_signal:<source_name>`, `scan_launches`, `scan_hot_pairs`, `bitquery_subscription`, `manual`, `watchlist`. Required for source trust scoring and strategy evolution.

**Prior history check (mandatory):**
`solana_memory_by_token({ tokenAddress: "CA" })`
If you lost money on this token before, re-entry penalty (-0.15) must already be factored into confidence.

**REQUIRED PARAMETERS FOR solana_trade_execute:**
```
solana_trade_execute({ tokenAddress: "CA", side: "buy", symbol: "SYMBOL", sizeSol: X, slPct: 20, tpExits: [{ percent: 100, amountPct: 30 }, { percent: 200, amountPct: 100 }], trailingStop: { levels: [{ percentage: 25, amount: 50 }, { percentage: 35, amount: 100, triggerAboveATH: 100 }] }, slippageBps: 300, idempotencyKey: "unique-id" })
```

**ABSOLUTE RULES:**
- ✅ `slippageBps` is REQUIRED — always send it (scale to liquidity, hard cap 800bps)
- ✅ tpExits: HARDENED +100–300%, DEGEN +200–500%
- ❌ NEVER use tpLevels alone (defaults to 100% exit per level)
- ✅ Always send BOTH tpExits AND slExits

**Post-buy Bitquery subscription (mandatory after successful buy):**
`solana_bitquery_subscribe({ templateKey: "realtimeTokenPricesSolana", variables: { token: "CA" }, agentId: "main" })`
Start real-time price monitoring. Live price data between heartbeats.

**IMMEDIATELY after execution, post this EXACT format:**

🟢 ENTRY: SYMBOL (full_contract_address)
• Size: X.XX SOL
• Price: X.XXXXXX SOL
• Confidence: X.XX
• Source: [signal source]
• Thesis: [1 line]
• TX: https://solscan.io/tx/{txHash}
• Token: https://solscan.io/token/{CA}

**If trade fails, announce the failure with error reason. No silent trades. EVER.**

## STEP 6: MONITOR POSITIONS

For each open position: check PnL, SL/TP proximity, flow direction. **Use `unrealizedPnl` for SOL PnL** on `solana_positions`. **Use `unrealizedReturnPct`** for trailing stop level matching (no manual math).

**On-chain verification:** If any position balance looks inconsistent, call `solana_wallet_token_balance` with the token mint to verify actual on-chain holdings.

**Feature delta check (optional but recommended):**
`solana_candidate_delta({ id: "CA", currentFeatures: { volume_momentum: 0.5, buy_pressure: 0.3, ... } })`
Compare current features against entry. If degraded significantly (buy pressure flipped, volume collapsed), consider exiting even if SL hasn't triggered.

**Social exhaustion check:** `x_search_tweets({ query: "$SYMBOL" })`
Mention velocity declining + price flat/dropping = social exhaustion → consider exit.

**Dead money re-check:** Apply the 4 criteria from Step 0 again. Do NOT wait for the next cycle.

## STEP 7: EXIT + ANNOUNCE

Execute exits via `solana_trade_execute` with `side: "sell"`.

**IMMEDIATELY after each exit, post this EXACT format:**

🔴 EXIT: SYMBOL (full_contract_address)
• Size: X.XX SOL
• PnL: +/-X.XX% (+/-X.XXX SOL)
• Hold Duration: Xh Xm
• Exit Reason: [TP hit / SL hit / dead-money / trailing stop / flow reversal]
• TX: https://solscan.io/tx/{txHash}
• Token: https://solscan.io/token/{CA}

Partial exits → "🔴 PARTIAL EXIT (50%): SYMBOL (CA)"

**Post-exit mandatory actions (ALL required — skipping any is a critical violation):**

1. Call `solana_trade_review` for each closed position.

2. **LABEL THE OUTCOME — DO NOT SKIP:**
`solana_candidate_label_outcome({ id: "CA", outcome: "win|loss|skip|dead_money", pnlPct: X.XX, holdingHours: H })`
The intelligence lab CANNOT learn without labeled outcomes. Strategy evolution, model evaluation, and replay all depend on labeled candidates.

3. **LEARNING ENTRY — REQUIRED after every loss or dead_money exit:**
```
solana_memory_write({ content: "LEARNING ENTRY: LRN-YYYYMMDD-NNN\nPriority: P2\nArea: <area_tag>\nWHAT HAPPENED: <1 sentence>\nWHY IT WENT WRONG: <root cause>\nEVIDENCE: token CA, entry price, exit price, hold time\nSUGGESTED ADJUSTMENT: <what to change>", tags: ["learning_entry", "learning_entry_<area>"] })
```
Losses without learning entries are the #1 reason the strategy fails to evolve. See `refs/review-learning.md` for full format and area tags.

4. Unsubscribe from Bitquery stream: `solana_bitquery_unsubscribe({ subscriptionId: "<id>" })`

5. If alpha-sourced trade, check source accuracy:
`solana_alpha_history({ tokenAddress: "CA", limit: 5 })`
Log via `solana_memory_write` with tag `source_reputation`.

## STEP 8: MEMORY WRITE-BACK (mandatory — call ALL)

- `solana_state_save` if any durable state changed
- `solana_daily_log` with cycle summary
- `solana_memory_write` for lessons, observations, reputation notes
- `solana_candidate_write` for any analyzed tokens not yet written (feeds intelligence lab)
- `solana_decision_log` for any significant decisions made this cycle
- `solana_team_bulletin_post` with tag `position_update` — post current portfolio state
- `solana_context_snapshot_write` — write portfolio world-view for bootstrap injection

**Self-check before completing Step 8:**
- Did you exit any positions? → did you call `solana_candidate_label_outcome` for EACH? If not, do it now.
- Any loss or dead_money exit? → did you write a `learning_entry`? If not, write one now.
- Any trades executed? → does each `pre_trade_rationale` include `source:` attribution? If not, write correction now.

Do NOT skip these. They feed the bootstrap digest that loads into your next session.

## STEP 9: REPORT TO USER

**Use this EXACT template. Fill in every field. Do not freestyle.**

```
HEARTBEAT REPORT — [timestamp UTC]

Capital: X.XXX SOL | Positions: N open | Holdings verified: [yes/no via solana_wallet_token_balance]
Scanned: N launches, N hot pairs | Alpha: N signals (top score: XX)

DEEP ANALYSIS:
Bitquery: [N templates run on N tokens | "none — no FRESH tokens"]
Intelligence lab: [N candidates written, N outcomes labeled | "no new candidates"]
Source trust: [checked N sources (avg trust: XX) | "no alpha signals"]
Deployer trust: [checked N deployers | "no FRESH tokens"]
Model scoring: [scored N candidates (champion vs confidence delta: ±X.XX) | "no model registered"]

TRADES THIS CYCLE:
[List each trade announcement from Steps 5/7, or "None"]

OPEN POSITIONS:
- SYMBOL (full_CA): entry X.XX SOL → now X.XX SOL | Return: +/-X.X% (from unrealizedReturnPct) | PnL: +/-X.XXX SOL | SL: X% away | TP1: X% away
[or "No open positions"]

SKIPPED:
- SYMBOL (full_CA): reason skipped
[or "No candidates reached analysis"]

NEXT CYCLE: [1 sentence — what you're watching for]
```

**MANDATORY FORMAT RULES:**
- Every token MUST be SYMBOL (full_contract_address). NO EXCEPTIONS.
- PnL must come from `solana_positions` or `solana_trade_review` — use `unrealizedPnl` / `realizedPnl` for SOL values. NEVER calculate manually. If tool didn't return it, say "PnL: pending".
- Capital must come from `solana_capital_status`. NEVER estimate.
- DEEP ANALYSIS section is MANDATORY. If zero advanced tools used, say so explicitly.
- Keep under 60 lines.

---

## SKILL INDEX — When to Read Full SKILL.md or Refs

| Situation | Read |
|---|---|
| Tools fail with auth/401 errors | SKILL.md § How You Access the Orchestrator |
| First session / MEMORY.md empty | SKILL.md § Mandatory Startup Sequence |
| Alpha signal processing details | refs/alpha-signals.md |
| Bitquery subscription setup | refs/bitquery-intelligence.md |
| Website analysis details | refs/decision-framework.md |
| Pre-trade journal template | refs/trade-execution.md |
| Post-trade review format + tags | refs/review-learning.md |
| Structured learning log | refs/review-learning.md |
| Memory tag vocabulary | refs/memory-tags.md |
| Entitlement/tier questions | SKILL.md § Entitlements |
| API endpoint reference | refs/api-reference.md |
| Wallet proof vs signup | SKILL.md § Wallet proof vs signup |
| Strategy evolution details | refs/strategy-evolution.md |
| Cron job definitions | refs/cron-jobs.md (10 consolidated jobs, ~39 sessions/day) |
| Position management details | refs/position-management.md |
