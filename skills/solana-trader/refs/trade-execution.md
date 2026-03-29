# Trade Execution — Steps 5, 5.5, 6

## Step 5: PRECHECK — Validate Before Trading

Call `solana_trade_precheck` with your intended trade parameters.

- **If `approved: false` with hard denials:** STOP. Do not trade. Journal the denial reason.
- **If approved with soft flags:** Reduce size to `cappedSizeSol`. Consider SERVER_MANAGED. Tighten stops.
- **If approved cleanly:** Proceed to execute.

**Non-negotiable:** Never override hard denials. Never argue with the policy engine.

## Step 5.5: DECISION JOURNAL — Write Rationale BEFORE Executing

> **The WAL Rule (Write-Ahead Log):** You MUST journal your decision rationale BEFORE placing a trade. Not after. Not "soon." BEFORE.

**Why:** After a trade is placed, hindsight bias distorts your memory. By writing first, you capture the true decision state — the most valuable data for strategy evolution.

### Mandatory Pre-Trade Journal Entry

Before every `solana_trade_execute`, write `solana_memory_write` with tag `pre_trade_rationale`:

```
Token: <symbol> (<mint address>)
Side: <buy/sell>
Size: <sizeSol> SOL (<X% of capital>)
Confidence: <score> (threshold was <threshold>)
Management: <LOCAL_MANAGED/SERVER_MANAGED>

WHY THIS TOKEN:
- <Discovery path — scan, alpha signal, subscription event?>
- <Lifecycle stage? FRESH/EMERGING/ESTABLISHED>
- <Key thesis: 1-2 sentence reason>

WHY THIS SIZE:
- <Base size from mode range>
- <Adjustments: risk cap, precheck cap, liquidity cap, reduction triggers>
- <Final size after all adjustments>

EXIT PLAN:
- SL: <X%> | TP levels: <[X, Y, Z]%> | Trailing: <X%>
- <What condition would make you exit early?>

WHAT COULD GO WRONG:
- <Top 1-2 risks you're accepting>
- <Red flags you noticed but decided to proceed despite>

FEATURE SCORES (from weighted model):
- volume_momentum: <raw score>
- buy_pressure: <raw score>
- liquidity_depth: <raw score>
- holder_quality: <raw score>
- flow_divergence: <raw score>
- token_maturity: <raw score>
- risk_inverse: <raw score>

ALPHA SOURCE (if applicable):
- Source: <name> | Score: <systemScore> | Reputation: <0-100>
```

### Pre-Exit Rationale (for sells)

Tag with `pre_exit_rationale`:
```
Token: <symbol> | Side: sell | Size: <sellPct>% of position
EXIT REASON: <stop-loss hit / take-profit / flow reversal / dead money / defense mode / manual>
CURRENT PnL: <X% / X SOL>
HELD FOR: <duration>
```

## Step 6: EXECUTE — Place the Trade

Call `solana_trade_execute` with:
- `tokenAddress`, `side` ("buy" or "sell"), `symbol`
- **For buy:** `sizeSol` (amount in SOL) — required
- **For sell:** `sellPct` (integer 1–100 where 100 = full exit) — required. Raw token amounts are not accepted on this endpoint. Do NOT send `sizeSol` for sells.
- `slippageBps` (REQUIRED — scaled to liquidity, hard cap 800bps)
- `slExits` (graduated partial stop-losses — see refs/api-reference.md § slExits Parameter)
- `tpExits` (partial take-profits)
- `trailingStopPct` (simple) or `trailingStop` object with `levels` array (structured — see refs/api-reference.md § Trailing Stop Parameter)
- `managementMode`

### BUY PAYLOAD:
{
    "walletId":"3ccb6f61-0256-466e-a01e-e9560d25bdbe",
    "tokenAddress":"So11111111111111111111111111111111111111112",
    "side":"buy",
    "sizeSol":0.05,
    "slippageBps":1000,
    "symbol":"WSOL",
    "tpExits":[
      {"percent":100,"amountPct":40},
      {"percent":200,"amountPct":55},
      {"percent":300,"amountPct":100}
    ],
    "slPct":30,
    "slExits":[
      {"percent":30,"amountPct":50},
      {"percent":50,"amountPct":100}
    ],
    "trailingStopPct":5,
    "trailingStop":{
      "levels":[
        {"percentage":15,"amount":20,"triggerAboveATH":100},
        {"percentage":30,"amount":100,"triggerAboveATH":120}
      ]
    }
  }

### SELL PAYLOAD

{
    "walletId":"3ccb6f61-0256-466e-a01e-e9560d25bdbe",
    "tokenAddress":"So11111111111111111111111111111111111111112",
    "side":"sell",
    "sellPct":100,
    "slippageBps":2000,
    "symbol":"WSOL",
  }

Record the returned `tradeId` and `positionId` for monitoring and review.

### Trade Announcement (IMMEDIATELY after execution)

**Entry format:**
```
🟢 ENTRY: SYMBOL (full_contract_address)
• Size: X.XX SOL
• Price: X.XXXXXX SOL
• Confidence: X.XX
• Source: [signal source]
• Thesis: [1 line]
• TX: https://solscan.io/tx/{txHash}
• Token: https://solscan.io/token/{CA}
```

**Exit format:**
```
🔴 EXIT: SYMBOL (full_contract_address)
• Size: X.XX SOL
• PnL: +/-X.XX% (+/-X.XXX SOL)
• Hold Duration: Xh Xm
• Exit Reason: [TP hit / SL hit / dead-money / trailing stop / flow reversal]
• TX: https://solscan.io/tx/{txHash}
• Token: https://solscan.io/token/{CA}
```

Partial exits: `🔴 PARTIAL EXIT (50%): SYMBOL (CA)`

**If trade fails, announce the failure with error reason. No silent trades. EVER.**

## Trailing Stop Level System

Use `trailingStop: { levels: [...] }` (structured) for new trades. As unrealized profit grows, tighten trailing stops to lock in gains. Apply the highest matching level:

| Profit Level | Trailing Stop `percentage` | Rationale |
|---|---|---|
| < +25% | Use original entry trailing stop level | Standard volatility buffer |
| +25% to +50% | Tighten to 10% (HARDENED) / 8% (DEGEN) | Lock partial gains |
| +50% to +100% | Tighten to 8% (HARDENED) / 6% (DEGEN) | Protect meaningful profit |
| +100% (house money) | Widen to 1.5× original trailing stop | Let house money ride |
| +200%+ | Tighten to 6% (HARDENED) / 5% (DEGEN) | Protect runner gains aggressively |

**Rules:**
- Trailing stops only tighten — never widen (except house money transition at +100%)
- Apply the level matching current unrealized PnL, not entry PnL
- If price retraces from +200% to +80%, use the +50-100% level (match current, not peak)
- Update trailing stop via `solana_trade_execute` with `side: "update"` if the position is SERVER_MANAGED
- For LOCAL_MANAGED: track mentally and execute sells when trailing level breached

**Structured trailing stop (preferred for staging):** Use the `trailingStop` object with `levels` array instead of `trailingStopPct` for new trades. 1–5 levels supported:
```json
{
  "trailingStop": {
    "levels": [
      { "percentage": 25, "amount": 50 },
      { "percentage": 35, "amount": 100, "triggerAboveATH": 100 }
    ]
  }
}
```
- `percentage` — trailing drawdown % from the armed high once that level is active.
- `amount` — % of position to sell at this level (1–100; server default `100`).
- `triggerAboveATH` — **optional.** Price must reach this % above the session ATH before this level arms. Default `100` (2× ATH). Use a smaller value (e.g. `25`) to arm earlier; use `trailingStopPct` for simpler single-level trailing without this gate.

Define multiple tiers matching the level table above. See refs/api-reference.md § Trailing Stop Parameter for full schema.
