# Bitquery Query Catalog Reference

This document lists all available template paths for use with `solana_bitquery_catalog`. Use `solana_bitquery_templates` to get this list programmatically.

Template paths follow the format: `category.key`

---

## Category: pumpFunCreation

| Template Path | Description | Variables |
|---|---|---|
| `pumpFunCreation.trackNewTokens` | Track newly created Pump.fun tokens | `since: DateTime!, limit: Int!` |
| `pumpFunCreation.getCreationTimeAndDev` | Get creation time and dev address for token | `token: String!` |
| `pumpFunCreation.trackLaunchesRealtime` | Track new token launches in real-time via query polling | `since: DateTime!, limit: Int!` |
| `pumpFunCreation.getTokensByCreatorAddress` | Get all Pump.fun tokens created by creator wallet | `creator: String!, limit: Int!` |
| `pumpFunCreation.getTokensByCreatorHistorical` | Historical token creations by wallet | `creator: String!, since: DateTime!, till: DateTime!` |

---

## Category: pumpFunMetadata

| Template Path | Description | Variables |
|---|---|---|
| `pumpFunMetadata.tokenMetadataByAddress` | Get token metadata plus dev and creation time | `token: String!` |
| `pumpFunMetadata.trackMayhemModeRealtime` | Track Mayhem Mode enabled tokens in real-time | `since: DateTime!, limit: Int!` |
| `pumpFunMetadata.currentMayhemModeStatus` | Check current Mayhem mode status for token | `token: String!` |
| `pumpFunMetadata.historicalMayhemModeStatus` | Historical mayhem mode changes for token | `token: String!, since: DateTime!, till: DateTime!` |
| `pumpFunMetadata.latestPrice` | Latest price for Pump.fun token | `token: String!` |

---

## Category: pumpFunPriceMomentum

| Template Path | Description | Variables |
|---|---|---|
| `pumpFunPriceMomentum.streamTokenPrice` | Price stream query for polling mode | `token: String!, since: DateTime!` |
| `pumpFunPriceMomentum.top10PriceChange5m` | Top 10 by short-term price change | `since: DateTime!` |
| `pumpFunPriceMomentum.tokenOHLC` | OHLC data for Pump.fun token | `token: String!, since: DateTime!` |
| `pumpFunPriceMomentum.athMarketCapWindow` | ATH market cap in window | `token: String!, since: DateTime!, till: DateTime!` |
| `pumpFunPriceMomentum.priceChangeDeltaFromMinutesAgo` | Price-change delta from X minutes back | `token: String!, since: DateTime!` |

---

## Category: pumpFunTradesLiquidity

| Template Path | Description | Variables |
|---|---|---|
| `pumpFunTradesLiquidity.realtimeTrades` | Get real-time trades on Pump.fun | `since: DateTime!, limit: Int!` |
| `pumpFunTradesLiquidity.latestTradesByToken` | Latest trades by token | `token: String!, limit: Int!` |
| `pumpFunTradesLiquidity.tradingVolume` | Get trading volume for token | `token: String!, since: DateTime!` |
| `pumpFunTradesLiquidity.detailedTradeStats` | Detailed trade stats (volume/buys/sells/makers/buyers/sellers) | `token: String!, since: DateTime!` |
| `pumpFunTradesLiquidity.lastTradeBeforeMigration` | Last Pump.fun trade before migration to PumpSwap | `token: String!` |

---

## Category: pumpFunHoldersRisk

| Template Path | Description | Variables |
|---|---|---|
| `pumpFunHoldersRisk.first100Buyers` | Get first 100 buyers | `token: String!` |
| `pumpFunHoldersRisk.first100StillHolding` | Check whether first 100 buyers still hold | `holders: [String!], token: String!` |
| `pumpFunHoldersRisk.devHoldings` | Get developer holdings for token | `devWallet: String!, token: String!` |
| `pumpFunHoldersRisk.topHoldersTopTradersTopCreators` | Get top holders/top traders/top creators | `token: String!, since: DateTime!` |
| `pumpFunHoldersRisk.phishyAndMarketCapFilters` | Phishy check + market cap filter scaffolding | `since: DateTime!, minCap: String!, maxCap: String!` |

---

## Category: pumpSwapPostMigration

| Template Path | Description | Variables |
|---|---|---|
| `pumpSwapPostMigration.newPoolsRealtime` | Get newly created PumpSwap pools | `since: DateTime!, limit: Int!` |
| `pumpSwapPostMigration.trackMigratedPools` | Track pools migrated to PumpSwap | `since: DateTime!, limit: Int!` |
| `pumpSwapPostMigration.latestTrades` | Get latest trades on PumpSwap | `since: DateTime!, limit: Int!` |
| `pumpSwapPostMigration.latestTradesByToken` | Latest PumpSwap trades for token | `token: String!, limit: Int!` |
| `pumpSwapPostMigration.pumpSwapSubscriptionScaffold` | Query mirror for PumpSwap realtime subscription | `since: DateTime!` |

---

## Category: pumpSwapPriceTrader

| Template Path | Description | Variables |
|---|---|---|
| `pumpSwapPriceTrader.trackTokenPriceRealtime` | Track PumpSwap token price realtime | `token: String!, since: DateTime!` |
| `pumpSwapPriceTrader.latestPrice` | Get latest price for PumpSwap token | `token: String!` |
| `pumpSwapPriceTrader.ohlc` | OHLC for PumpSwap token | `token: String!, since: DateTime!` |
| `pumpSwapPriceTrader.latestTradesByTrader` | Get latest trades by trader | `wallet: String!, since: DateTime!` |
| `pumpSwapPriceTrader.topTradersAndStats` | Top traders and token trade stats | `token: String!, since: DateTime!` |

---

## Category: launchpadsRaydiumLetsBonk

| Template Path | Description | Variables |
|---|---|---|
| `launchpadsRaydiumLetsBonk.latestRaydiumLaunchpadPools` | Track latest pools created on Raydium Launchpad | `since: DateTime!, limit: Int!` |
| `launchpadsRaydiumLetsBonk.trackMigrationsToRaydium` | Track migrations to Raydium DEX/CPMM across launchpads | `since: DateTime!, limit: Int!` |
| `launchpadsRaydiumLetsBonk.bondingCurveProgress` | Compute bonding curve progress from latest pool/liquidity snapshot | `token: String!, since: DateTime!` |
| `launchpadsRaydiumLetsBonk.tokensAbove95Progress` | Track launchpad tokens above 95% bonding curve progress | `since: DateTime!, limit: Int!` |
| `launchpadsRaydiumLetsBonk.top100AboutToGraduate` | Top 100 launchpad tokens near migration | `since: DateTime!` |

---

## Category: launchpadsTokenLevel

| Template Path | Description | Variables |
|---|---|---|
| `launchpadsTokenLevel.latestLaunchpadTrades` | Get latest launchpad trades | `since: DateTime!, limit: Int!` |
| `launchpadsTokenLevel.latestPriceForToken` | Get latest price for launchpad token | `token: String!` |
| `launchpadsTokenLevel.latestTradesByUser` | Get latest trades by user | `wallet: String!, since: DateTime!` |
| `launchpadsTokenLevel.topBuyersAndSellers` | Get top buyers and top sellers for token | `token: String!, since: DateTime!` |
| `launchpadsTokenLevel.ohlcPairAndLiquidity` | Get OHLC, pair address and latest liquidity | `token: String!, since: DateTime!` |

---

## Category: exchangeSpecific

| Template Path | Description | Variables |
|---|---|---|
| `exchangeSpecific.raydiumSuite` | Raydium: pools, pair create time, latest price, trades, LP changes, OHLC | `token: String!, since: DateTime!` |
| `exchangeSpecific.bonkSwapSuite` | BonkSwap: latest trades, top traders, trader feed, OHLC | `token: String!, wallet: String!, since: DateTime!` |
| `exchangeSpecific.jupiterSuite` | Jupiter swaps and order lifecycle query suite | `since: DateTime!` |
| `exchangeSpecific.jupiterStudioSuite` | Jupiter Studio token trades, prices, OHLC, launches, migrations | `since: DateTime!, token: String` |

---

## Category: genericDexAnalytics

| Template Path | Description | Variables |
|---|---|---|
| `genericDexAnalytics.latestSolanaTrades` | Subscribe/query latest Solana trades | `since: DateTime!, limit: Int!` |
| `genericDexAnalytics.priceVsWsolUsdMultiMarket` | Token price vs WSOL/USD and multi-market | `token: String!, since: DateTime!` |
| `genericDexAnalytics.pressureTopsAndDexs` | Buy/sell pressure and top-bought/top-sold/pairs/dexs | `since: DateTime!, limit: Int!` |
| `genericDexAnalytics.dexMarketsPairsTokenDetails` | DEX markets/pairs/token details | `token: String!, since: DateTime!` |
| `genericDexAnalytics.ohlcHistoryAthTrendSearch` | OHLC history, ATH, first-24h, trend, search | `token: String!, since: DateTime!` |

---

## Subscriptions (Managed via WebSocket)

Subscriptions are real-time WebSocket streams managed by the orchestrator. **Do not use these via the REST `POST /api/bitquery/query` endpoint** — subscription operations sent through REST will be rejected with `BITQUERY_SUBSCRIPTION_MANAGED_ONLY`.

Instead, use the `solana_bitquery_subscribe` plugin tool (or WebSocket `bitquery_subscribe` message) to create managed subscriptions. The orchestrator handles upstream WebSocket connections, multiplexing, and policy enforcement.

Use these template keys (not dot-path format) with `solana_bitquery_subscribe`:

| Template Key | Description | Variables |
|---|---|---|
| `realtimeTokenPricesSolana` | Real-time token prices on Solana | `token: String!` |
| `ohlc1s` | 1-second OHLC stream | `token: String!` |
| `dexPoolLiquidityChanges` | DEXPool liquidity changes stream | `token: String!` |
| `pumpFunTokenCreation` | Pump.fun token creation stream | (none) |
| `pumpFunTrades` | Pump.fun trades stream | `token: String` |
| `pumpSwapTrades` | PumpSwap trades stream | `token: String` |
| `raydiumNewPools` | Raydium v4/Launchpad/CLMM new pools stream | (none) |

Subscription management tools:
```
solana_bitquery_subscribe({ templateKey: "pumpFunTrades", variables: { token: "MINT_ADDRESS" } })
solana_bitquery_unsubscribe({ subscriptionId: "sub_abc123" })
solana_bitquery_subscriptions()
```

See `websocket-streaming.md` for full message contract, auth flow, subscription lifecycle, and policy enforcement details.

---

## Usage

To run a catalog template:
```
solana_bitquery_catalog({
  templatePath: "pumpFunHoldersRisk.first100Buyers",
  variables: { token: "TOKEN_MINT_ADDRESS" }
})
```

To discover available templates programmatically:
```
solana_bitquery_templates()
```

For custom queries not covered by templates, use `solana_bitquery_query` and consult `bitquery-schema.md` for correct schema usage.
