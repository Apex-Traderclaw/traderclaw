# Alpha Signal Processing — Full Reference

## How Alpha Signals Arrive

1. **Webhook push (high-priority):** The orchestrator POSTs high-priority signals directly to the OpenClaw Gateway webhook endpoint. The Gateway wakes you immediately. Webhook signals have already passed priority filters (high systemScore, clustering, risk/exit on held tokens). Process with urgency.

2. **Buffer poll (heartbeat cycle):** Call `solana_alpha_signals` every heartbeat to retrieve lower-priority signals buffered from the WebSocket stream. Merge into normal scan candidates alongside Step 1 scan results.

Both paths feed the same analysis pipeline. Difference is latency: webhook = seconds, buffer = up to 5 minutes.

## First-Time Setup

On first heartbeat cycle, call `solana_alpha_subscribe` with `agentId` to start receiving buffered signals. Subscription persists across heartbeat cycles. Webhook signals arrive regardless.

```
First heartbeat:
  → solana_alpha_subscribe({ agentId: "main" })
  → { subscribed: true, premiumAccess: false, tier: "pro" }

Subsequent heartbeats:
  → solana_alpha_signals({ unseen: true })
  → Returns only new signals since last check
```

Installer / Gateway preset **`alpha_stream_resubscribe`** (every 20 minutes) calls `solana_runtime_status` and re-invokes `solana_alpha_subscribe` when the subscription dropped or ingestion is stale. See refs/cron-jobs.md.

If buffered signals stay empty for multiple cycles:
```
solana_gateway_forward_probe({ agentId: "main", source: "heartbeat_recovery" })
solana_alpha_subscribe({ agentId: "main" })
```

## Signal Priority Classification

| Priority | Condition | Action |
|---|---|---|
| CRITICAL | `systemScore >= 85` | Immediate full analytic cycle |
| CRITICAL | `kind: "risk"` AND token in open positions | Risk warning — evaluate exit NOW |
| CRITICAL | `kind: "exit"` AND token in open positions | Sell signal — evaluate exit with urgency |
| HIGH | `systemScore >= 70 AND calledAgainCount >= 1` | Strong signal with multiple sources — prioritize |
| HIGH | `calledAgainCount >= 3` (any score) | Strong clustering — multiple sources converging |
| HIGH | `isPremium: true` (enterprise only) | Premium source = higher quality intel |
| MEDIUM | `systemScore 50–69, calledAgainCount 0` | Add to scan candidates alongside Step 1 results |
| LOW | `systemScore < 50` | Log for source tracking only |
| SKIP | `chain: "bsc"` | Not our chain |
| STALE | CRITICAL/HIGH >90 min, MEDIUM >60 min | Deprioritize or skip |

## Coordinated Shill Detection

High `calledAgainCount` has a dangerous edge case. When 5+ channels surface the same token within ~10 minutes with similar descriptions, this is likely a **coordinated promotion campaign**.

**Organic clustering:** Different callers, different angles, spread over 30+ minutes, varied language.
**Coordinated shill:** Many channels, similar/templated text, tight window (<10 min), same bullet points.

Detection response:
- Treat signal as **compromised** regardless of scores
- Downgrade to LOW or SKIP
- Journal with tag `coordinated_shill_detected`
- If `calledAgainCount >= 3` in HIGH priority, verify source independence

## Signal Kind Mapping

| Kind | What It Means | Action |
|---|---|---|
| `ca_drop` | New CA call from a source | Primary trigger — full analytic cycle |
| `milestone` | Price/mcap milestone hit | Informational — update watchlist |
| `update` | Updated info on previously called token | Refresh analysis if in position |
| `risk` | Risk warning about a token | Check positions immediately |
| `exit` | Sell signal from source | Check positions — evaluate exit |

## Signal Stage Interpretation

| signalStage | Meaning | Interpretation |
|---|---|---|
| `early` | Signal is fresh, token may be very new | Highest value — cross-check token age |
| `confirmation` | Multiple data points confirm | Good conviction — maps to EMERGING |
| `milestone` | Token reached notable level | Could be late — verify not chasing |
| `risk` | Risk indicators detected | Defensive — tighten stops |
| `exit` | Exit conditions met | Urgent for held positions |

## Price Movement Since Call

Compute staleness before running full analysis:
```
multiplierSinceCall = currentPrice / callPrice
```

| Multiplier | Time Since Call | Interpretation |
|---|---|---|
| `> 2.0` | `< 60 min` | Likely late unless strong on-chain confirmation |
| `< 1.5` | `< 30 min` | Still early — ideal entry window |
| `< 1.0` | Any | Could be early OR bad call — check fundamentals |
| `> 3.0` | Any | Extreme move — almost certainly a chase entry |

## Processing Workflow

1. **Parse** — Extract tokenAddress, kind, signalStage, systemScore, calledAgainCount, sourceName, confidence, chain
2. **Chain filter** — If `chain !== "solana"`, discard
3. **Self-signal check** — Cross-reference against positions and recent trades. Own trade echoes are NOT confirmation.
4. **Priority classify** — Apply priority table
5. **Staleness check** — Compute multiplierSinceCall. >3x = downgrade. >2x and >60 min = extra caution.
6. **Source reputation lookup** — Search memory for sourceName reputation
   - Win rate >60%: boost confidence one tier
   - Win rate <30%: reduce confidence one tier
   - Unknown: use signal's confidence as-is
7. **Act on priority:**
   - CRITICAL/HIGH: Full analytic cycle immediately
   - MEDIUM: Queue alongside normal scan candidates
   - LOW: Log for source tracking only
   - SKIP/STALE: Discard

## Convergence Detection

Alpha signal + on-chain discovery independently surface same token = **convergence** = highest conviction.

When detected:
- Boost effective score significantly
- Fast-track to thesis build
- Log with tag `signal_convergence`
- Include both sources in thesis notes

Do NOT count alpha + buffer poll of same signal as convergence. Requires genuinely independent paths.

## Source Tracking

Every alpha signal interaction contributes to source reputation:
- Log which sources you received signals from
- Tag outcomes with `alpha_source_win` or `alpha_source_loss` including sourceName
- `source_reputation_recalc` cron uses this data for per-source win rates
- Search memory for source reputation before trusting a signal

## Historical Access

Use `solana_alpha_history` for:
- **Post-downtime catch-up**: Query recent pings, filter for high scores, check current vs call price
- **Source reputation analysis**: Query broad time ranges (up to 1 year)
- **Strategy learning**: Study timing patterns, market cap ranges, caller profiles
- **Milestone pattern learning**: Track how tokens behave at 2x, 3x, 4x milestones

## Alpha Signal Risk Rules

1. **Caller accuracy decays.** Check recent accuracy (last 7 days), not just overall stats.
2. **Paid groups are not inherently better.** Premium access is about speed, not accuracy.
3. **Alpha is supplementary.** On-chain data always trumps human calls. Alpha signals add candidates to your pipeline — they do not override your own analysis.
4. **Source diversity matters.** Don't over-concentrate on a single source.
5. **Signal volume ≠ quality.** A source that calls 50 tokens/day with 10% accuracy is worse than one that calls 5/day with 50% accuracy.

## Narrative/Meta Awareness (from Step 1 SCAN)

- Look for narrative clusters: multiple AI tokens pumping = AI meta is hot
- Concentrate scanning on the hot meta. Memecoins move in waves.
- Don't fight the meta.
- When hot meta starts cooling (volume declining across category), prepare to exit cluster positions
- Journal meta observations with tag `meta_rotation`

## Deployer Pattern Detection

- Same deployer across multiple launches = serial deployer. Extreme caution.
- One good token from a serial deployer does not validate them. Ratio is usually 1 in 20+.

## Alpha Submission (Cron → Heartbeat Pipeline)

Use `solana_alpha_submit` to queue a candidate token into the alpha buffer for evaluation on the next heartbeat (e.g. after deep research outside the fast loop). Launch and pair discovery runs in **STEP 1: SCAN** on each heartbeat — there is no separate alpha_scan cron in the default presets. Include: tokenAddress, symbol, thesis (volume, holders, risk, narrative), source, confidence.

## Firehose Configuration

Use `solana_firehose_config` to adjust real-time data stream parameters without unsubscribe/resubscribe cycles:
- `volumeMinUsd` — minimum 24h volume filter
- `buyerCountMin` — minimum unique buyer threshold
- `whaleDetection` — enable/disable whale movement detection
- `maxTokenAgeHours` — filter out tokens older than this
- `excludeDeployers` — blacklist deployer addresses

Use `solana_firehose_status` to check firehose health: connection state, throughput, filter config, buffer depth, and last event timestamp. Run this when signals seem stale or missing.
