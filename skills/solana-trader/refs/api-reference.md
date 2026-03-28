# API Contract Reference

Base URL: `https://api.traderclaw.ai`

## Session Auth Flow

The **runtime** refreshes or completes the challenge flow automatically once `apiKey` exists in local plugin config. For wallet-proof challenges, the wallet private key is supplied at runtime via `--wallet-private-key` or `TRADERCLAW_WALLET_PRIVATE_KEY`. **Signup is not performed by the agent.**

1. **Signup (human/CLI only)** — `POST /api/auth/signup` with `{ externalUserId }` → returns `apiKey`. Status `201`.
2. **Challenge** — `POST /api/session/challenge` with `{ apiKey, clientLabel }` → returns `{ challengeId, walletProofRequired }`. Status `201`.
3. **Start** — `POST /api/session/start` with `{ apiKey, clientLabel }` (+ proof fields if required) → returns `{ accessToken, refreshToken }`. Status `201`.
4. **Refresh** — `POST /api/session/refresh` with `{ refreshToken }` → returns new tokens. Status `200`.
5. **Logout** — `POST /api/session/logout` with `{ refreshToken }` → revokes session. Status `200`.

All authenticated endpoints use `Authorization: Bearer <accessToken>`.

## Error Codes

| HTTP Status | Code | Meaning |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Missing or invalid required fields |
| `401` | `UNAUTHORIZED` | Token expired or revoked |
| `403` | `TIER_REQUIRED` / `SCOPE_DENIED` / `INSUFFICIENT_TIER` | Rate limit exceeded — report and continue |
| `404` | `WALLET_NOT_FOUND` | walletId does not exist |
| `403` | (trade/precheck denied) | Policy denial with `approved: false`, `code`, reason |

## Complete Endpoint Map

> **ALL ENDPOINTS ARE ACCESSIBLE ON ALL TIERS.** The only difference is rate limits. Never refuse to call an endpoint because of tier.

| Method | Path | Required Params | Notes |
|---|---|---|---|
| `POST` | `/api/auth/signup` | `externalUserId` | CLI/human only. Returns `apiKey`. Status `201` |
| `POST` | `/api/session/challenge` | `apiKey` | Returns `challengeId`, `walletProofRequired` |
| `POST` | `/api/session/start` | `apiKey` | Returns `accessToken`, `refreshToken` |
| `POST` | `/api/session/refresh` | `refreshToken` | Rotates tokens |
| `POST` | `/api/session/logout` | `refreshToken` | Revokes session |
| `GET` | `/api/wallets` | — | List all wallets. Optional `?refresh=true` |
| `POST` | `/api/wallet/create` | — | Create wallet. Optional: `label`, `publicKey`, `chain`, `ownerRef`, `includePrivateKey`. Status `201` |
| `GET` | `/api/capital/status` | `?walletId=<uuid>` | Wallet capital and daily limits. **PnL:** `totalUnrealizedPnl` / `totalRealizedPnl` are **USD** (stored); `totalUnrealizedPnlSol` / `totalRealizedPnlSol` / `totalPnlSol` are **SOL** derived with `solPriceUsd` (agent-safe). |
| `GET` | `/api/wallet/positions` | `?walletId=<uuid>` | Positions. For **Solana wallets**, **`realizedPnl` / `unrealizedPnl` are SOL-native** on this endpoint. `unrealizedReturnPct` = ROI vs cost (for sweep). Optional `?status=` |
| `GET` | `/api/funding/instructions` | `?walletId=<uuid>` | Deposit instructions |
| `GET` | `/api/killswitch/status` | `?walletId=<uuid>` | Kill switch state |
| `POST` | `/api/killswitch` | `walletId`, `enabled` | Toggle kill switch. Optional: `mode` |
| `GET` | `/api/strategy/state` | `?walletId=<uuid>` | Current strategy weights and mode |
| `POST` | `/api/strategy/update` | `walletId`, `featureWeights` | Update weights. Optional: `strategyVersion`, `mode` |
| `POST` | `/api/thesis/build` | `walletId`, `tokenAddress` | Build full thesis package |
| `POST` | `/api/trade/precheck` | `walletId`, `tokenAddress`, `side`, `slippageBps` (REQUIRED) | Risk/policy check. Buy: `sizeSol` required, do NOT send `sellPct`. Sell: `sellPct` only (1–100) (NOT `sizeSol` or raw token amounts). |
| `POST` | `/api/trade/execute` | `walletId`, `tokenAddress`, `side`, `slippageBps` (REQUIRED), `symbol` | Execute trade. Optional: `tpLevels[]`, `tpExits[]`, `slPct`, `slLevels[]`, `slExits[]`, `trailingStopPct` (simple) or `trailingStop` object. Header: `x-idempotency-key` |
| `POST` | `/api/trade/review` | `walletId`, `outcome`, `notes` | Post-trade review. Optional: `tradeId`, `tokenAddress`, `pnlSol`, `tags[]`, `strategyVersion`. Status `201` |
| `POST` | `/api/memory/write` | `walletId`, `notes` | Journal entry. Optional: `tokenAddress`, `outcome`, `tags[]`, `strategyVersion`. Status `201` |
| `POST` | `/api/memory/search` | `walletId`, `query` | Search memory entries |
| `POST` | `/api/memory/by-token` | `walletId`, `tokenAddress` | Memory for specific token |
| `GET` | `/api/memory/journal-summary` | `?walletId=<uuid>` | Performance summary. Optional: `?lookbackDays=` |
| `GET` | `/api/trades` | `?walletId=<uuid>` | Trade history. Optional: `?limit=` (max 200), `?offset=` |
| `GET` | `/api/risk-denials` | `?walletId=<uuid>` | Risk denial log. Optional: `?limit=` (max 200) |
| `GET` | `/api/entitlements/costs` | — | Tier costs and capabilities |
| `GET` | `/api/entitlements/plans` | — | Available monthly plans |
| `GET` | `/api/entitlements/current` | `?walletId=<uuid>` | Current tier and limits |
| `POST` | `/api/entitlements/purchase` | `walletId`, `planCode` | Buy plan (deducts SOL). Status `201` |
| `POST` | `/api/scan/new-launches` | `walletId` | New launches (Pump.fun, Raydium, PumpSwap) |
| `POST` | `/api/scan/hot-pairs` | `walletId` | High-volume/momentum pairs |
| `POST` | `/api/market/regime` | `walletId` | Macro market state |
| `POST` | `/api/token/snapshot` | `tokenAddress` | Price, volume, OHLC, trade count |
| `POST` | `/api/token/holders` | `tokenAddress` | Holder distribution and dev holdings |
| `POST` | `/api/token/flows` | `tokenAddress` | Buy/sell pressure and net flow |
| `POST` | `/api/token/liquidity` | `tokenAddress` | Pool depth and DEX breakdown |
| `POST` | `/api/token/risk` | `tokenAddress` | Composite risk profile |
| `POST` | `/api/token/socials` | `tokenAddress` | Social media / community metadata (Twitter/X, Telegram, Discord, website) |
| `POST` | `/api/bitquery/catalog` | `walletId`, `templatePath` | Run pre-built Bitquery template |
| `POST` | `/api/bitquery/query` | `walletId`, `query` | Run raw GraphQL query |
| `POST` | `/api/entitlements/upgrade` | `walletId`, `targetTier` | Upgrade account tier |
| `POST` | `/api/wallet/token-balance` | `walletId`, `tokenAddress` | On-chain SPL `uiAmount` (source of truth) for a specific mint in wallet. Use to verify actual holdings. |
| `POST` | `/api/wallet/sweep-dead-tokens` | `walletId` | Sells **100%** of each **open** position with `unrealizedReturnPct ≤ -maxLossPct`. Optional: `maxLossPct` (default **80**), `slippageBps`, `dryRun`. **`trade:execute` scope.** |
| `GET` | `/api/system/status` | — | System health and connectivity |

## Key Contract Notes

- **walletId** is always a UUID string
- **Wallet creation** path is `POST /api/wallet/create` (not `POST /api/wallets`)
- **`side`** is required on precheck — must be `"buy"` or `"sell"`
- **`outcome`** enum: `win`, `loss`, `neutral` (not `breakeven`)
- **`x-idempotency-key`** header on trade/execute: optional, recommended UUID per trade attempt
- **Signup returns 201** (not 200)
- **Session challenge/start return 201** (not 200)
- **`strategyVersion`** must be strict semver or server returns 400
- **Sells** use `sellPct` only (integer 1–100, share of the open position). Do not send `sizeTokens` or `sizeSol` for sells.
- **`tpLevels` alone** — each level sells 100% of position. Use `tpExits` for partial sells.
- **`trailingStop` object** — structured alternative to `trailingStopPct` with `levels` array. If both are sent, the object takes precedence. `triggerAboveATH` is a number (default `100` = 2× ATH), NOT a boolean.
- **`slLevels`** — array of stop-loss % levels (simple, each triggers 100% exit). Use `slExits` for partial sells.
- **`slExits`** — multi-level stop-loss with partial exits. Takes precedence over `slPct` if both sent. See § slExits Parameter.
- **`slippageBps`** — **REQUIRED** on both precheck and execute. Positive integer, basis points (e.g. 300 = 3%).

## Trailing Stop Parameter

The `/api/trade/execute` endpoint accepts trailing stop configuration in two forms:

**Simple (legacy):** `trailingStopPct` — single trailing stop (% drawdown from session high once active). Legacy/simple path on the server. Keys off ATH without a gate.

**Structured (preferred for staging):** `trailingStop` — `{ levels: [ ... ] }` with **1–5** levels:

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

Each level has these fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `percentage` | number | Yes | Trailing drawdown % from the armed high once that level is active |
| `amount` | number | No | % of position to sell at this level (1–100; server default `100`) |
| `triggerAboveATH` | number | No | **Optional.** Price must reach this **% above the session ATH** before this level arms (e.g. `50` → 1.5× ATH). **If omitted, the API defaults to `100` (2× ATH).** Use a smaller value (e.g. `25`) to arm earlier; use `trailingStopPct` instead if you want the simpler single-level trailing that keys off ATH without this gate. |

If both `trailingStop` (object) and `trailingStopPct` (simple) are sent, the object takes precedence.

## slExits Parameter

The `/api/trade/execute` endpoint supports multi-level stop-losses with partial exits via the `slExits` array:

```json
{
  "slExits": [
    { "percent": 15, "amountPct": 50 },
    { "percent": 25, "amountPct": 100 }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `percent` | number | Stop-loss trigger: % drawdown from entry |
| `amountPct` | number | % of position to close at this SL level (1–100) |

Use `slExits` when you want graduated stop-losses (e.g., sell 50% at -15%, remaining 50% at -25%). Use `slPct` for a single full exit at one level. If both are sent, `slExits` takes precedence.

## unrealizedReturnPct Field

The `/api/wallet/positions` endpoint returns `unrealizedReturnPct` on each position — the percentage return since entry (e.g., `25.5` means +25.5% from entry price). Use this for trailing stop level matching and FOMO checks instead of manually calculating from entry/current price.

## PnL Field Clarification (USD vs SOL)

The positions and trades endpoints do **not** use the same PnL contract:

| Field | Currency | Use Case |
|---|---|---|
| `/api/wallet/positions` → `realizedPnl` | **SOL** | Solana realized profit/loss for position monitoring |
| `/api/wallet/positions` → `unrealizedPnl` | **SOL** | Solana unrealized profit/loss for position monitoring |
| `/api/trades` → `pnlSol` | **SOL** | Trade-level realized profit/loss |
| `/api/capital/status` → `totalUnrealizedPnl` / `totalRealizedPnl` | **SOL** | Wallet-level aggregate capital overview |

**CRITICAL:** For Solana position monitoring, read `realizedPnl` / `unrealizedPnl` directly from `/api/wallet/positions`. Do **not** expect `realizedPnlSol` / `unrealizedPnlSol` on that endpoint.
