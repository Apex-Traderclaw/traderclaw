# Decision Framework — Steps 2-4 Full Reference

## Step 2: DEEP ANALYSIS

For top candidates, call:
- `solana_token_snapshot` — price, volume, OHLC, trade count
- `solana_token_holders` — holder distribution, concentration, dev holdings
- `solana_token_flows` — buy/sell pressure, unique traders
- `solana_token_liquidity` — pool depth, DEX breakdown
- `solana_token_risk` — composite risk profile
- `solana_token_socials` — social media / community metadata (Twitter/X, Telegram, Discord, website)

### Social Intel (mandatory for any token scoring above 0.60)

First, get structured social metadata from the API:
```
solana_token_socials({ tokenAddress: "CA" })
```
This returns Twitter/X handle, Telegram, Discord, website links. Use these for cross-referencing with X search results and website checks.

Then search X/Twitter for real-time sentiment:
```
x_search_tweets({ query: "$SYMBOL" })
```

Check mention velocity, influencer clustering, sentiment tone. Cross-check any X handles found via `solana_token_socials` with actual tweet activity. If X tools fail, log the error and continue — but you MUST attempt the call.

### Website Legitimacy Check (mandatory for tokens scoring above 0.60)

1. Check if `solana_token_socials` already returned a website URL. If yes, use that directly. Otherwise, get on-chain metadata: `solana_bitquery_catalog({ templatePath: "pumpFunMetadata.tokenMetadataByAddress", variables: { token: "CA" } })`
2. If a website URL is available (from either source), fetch it: `web_fetch_url({ url: "<website_url>" })`
3. Analyze: title, metaDescription, headings, socialLinks, outboundLinks, bodyText
4. Confidence adjustments:
   - Professional site with consistent social links → +0.02
   - No website at all → neutral
   - Generic template with no real content → -0.01
   - Website social links don't match on-chain metadata → -0.03 (red flag)
5. Cache rule: check memory for `website_analyzed` before fetching. Reuse if same URL analyzed in last 48h.

### Token Lifecycle Classification

- **FRESH (< 1h):** Mint MUST be revoked, freeze MUST be inactive, LP MUST be burned/locked. Serial deployer (3+ tokens/24h) = hard skip. Volume >70% in first 15min = skip. EXPLORATORY SIZING ONLY.
- **EMERGING (1-24h):** Top-10 concentration declining? Volume >20% of peak hour? Standard sizing.
- **ESTABLISHED (>24h):** Full sizing. Edge = flow analysis + narrative timing.

### Enforcement Rule

If a REQUIRED tool is not called:
→ The decision is INVALID

---

### Failure Handling

If tool fails:
- Treat as increased risk
- Reduce position size OR skip trade

## Step 3: SCORE & RANK

**Use `solana_compute_confidence` — NEVER do manual math.** The tool returns deterministic results.

### FOMO Check (BEFORE computing confidence)

- Already moved +500% in <4h → skip
- Moved +200% from recent low → exploratory sizing only
- Seen 3+ cycles without entering → don't chase
- Just took a loss → that's revenge trading, slow down

### Confidence Penalties (applied automatically by compute tool, but verify)

- Risk flags: -0.05 to -0.15 per soft flag
- Top-10 > 25%: -(concentration% − 25) × 0.005
- Liquidity < $100K: -(100K − liquidity) / 1M
- 2+ losses in last 3: -0.10
- Lost on this token before: -0.15
- Token moved +200%: -0.15
- Serial deployer: -0.20

### Regime Modulation (applied to weights before scoring)

- Bull market: Boost `volume_momentum` and `buy_pressure` by mode percentage (+10% HARDENED, +20% DEGEN)
- Bear market: Boost `liquidity_depth` and `holder_quality` by mode percentage (+10% HARDENED, +15% DEGEN)
- Re-normalize weights to sum to 1.0 after regime boost

### Entry Decision

- `confidenceScore > entry_threshold` AND `riskPreScreen.approved` → proceed to sizing
- Confidence borderline → WATCH (add to watchlist, re-evaluate next cycle)
- Confidence low OR hard deny flags → AVOID

### Micro-Timing

- Prefer entries on pullbacks within an uptrend
- If price just made a sharp move up (+20%+ in minutes), wait for a retrace
- Exception in DEGEN: momentum entries acceptable if volume confirms continuation
- Never enter during a sharp red candle

## Step 4: DECIDE — Position Sizing

**Use `solana_compute_position_limits` for sizing — NEVER calculate manually.**

### Hard Caps (non-negotiable)

- Position ≤ 2% of pool depth in USD. Pool < $50K → max $1,000 SOL equivalent.
- Mint authority active OR freeze authority active → HARD SKIP.
- Max 40% capital across same narrative cluster.

### Base Sizing by Confidence

- High confidence: Use mode's high-confidence range (10–20% HARDENED, 12–25% DEGEN)
- Moderate confidence (exploratory): Use mode's exploratory range (3–8% HARDENED, 5–10% DEGEN)

### Lifecycle Adjustment

- FRESH: Cap at exploratory range regardless of confidence
- EMERGING: Standard sizing
- ESTABLISHED: Full range available

### Deterministic Decision Constraints

All decisions MUST:

1. Use SOL-denominated performance only
2. Use validated exit configuration (see Exit Configuration Validation)
3. Conform to Position Execution Model

If any constraint is violated → ABORT decision

### Size Reduction Triggers (stack multiplicatively)

- Win rate < 40% (last 10) → ×0.6
- DailyNotionalUsed > 70% → ×0.5
- 2+ consecutive losses → ×0.7
- 3+ open positions → ×0.8
- Concentration > 30% → ×0.5
- Token moved +200% → ×0.5
- Floor: 0.75% capital (HARDENED) / 1.25% (DEGEN)

### Choose Management Mode

**SERVER_MANAGED when:** Position >10% capital, extreme volatility, 3+ concurrent positions, exit reliability needed, liquidity risk elevated, >1% pool depth.

**LOCAL_MANAGED when:** Experimental trade, small position, custom exit logic, actively monitoring.

### Define Exit Plan (BEFORE executing)

| | HARDENED | DEGEN |
|---|---|---|
| Stop loss (`slExits`) | -20% on every position | -40% on every position |
| Take-profit exits (`tpExits`) | +100–300% (multiple) | +200–500% (multiple) |
| Trailing stop (`trailingStop`) | Structured levels with `triggerAboveATH` | Structured levels |

### Trailing Stop Levels (tighten as profit grows)

Use `trailingStop` (structured levels) for new trades. Set via `trailingStop: { levels: [...] }` on buy. Tighten levels via position update as profit grows.

| Profit Level | Trailing Stop `percentage` | Rationale |
|---|---|---|
| < +25% | Original entry trailing stop level | Standard buffer |
| +25% to +50% | 10% (HARDENED) / 8% (DEGEN) | Lock partial gains |
| +50% to +100% | 8% (HARDENED) / 6% (DEGEN) | Protect meaningful profit |
| +100% (house money) | 1.5× original trailing stop | Let house money ride |
| +200%+ | 6% (HARDENED) / 5% (DEGEN) | Protect runner gains aggressively |

Trailing stops only tighten — never widen (except house money transition at +100%). Match current unrealized PnL, not peak.

### Slippage

- >$500K pool = 100-200bps
- $100-500K = 200-400bps
- $50-100K = 300-500bps
- <$50K = 400-800bps (cap)
- Exit = 1.5× entry

### House Money Rule

- At +100%, take initial capital out. Remaining = house money.
- Widen stops 50%, trailing only, no fixed TP.
- House money positions are how you catch 5x-10x+ runners.
