# SKILL: Bitquery v2 EAP GraphQL Schema Reference

## Overview

This skill covers the Bitquery v2 EAP (Early Access Program) GraphQL schema for Solana, specifically the two trade cubes and their differences. Use this before writing or reviewing any query in `bitQuery.js`.

**Endpoint:** `https://streaming.bitquery.io/graphql` (HTTP and WebSocket)
**Auth header:** `Authorization: Bearer <BITQUERY_API_KEY>`

---

## Catalog vs Live Schema — Why 400s Happen

A query path being registered in `OPENCLAW_QUERY_TEMPLATES` (e.g. `pumpFunHoldersRisk.first100Buyers`) only means the **path string** resolves to a GraphQL operation. It does **not** guarantee the operation is schema-valid.

When `runCatalogQuery` returns `ok: false` with HTTP 400 (or HTTP 200 with `errors[]`), the stored GraphQL text has a schema violation. Fix it in `SpyFly/Contexts/openClawAPI/bitQuery.js`.

The most common root causes are using `DEXTrades`-only fields (`Trade.Currency`, `Trade.Buyer`, `Trade.PriceInUSD`, `Trade.Side`, `Trade.AmountInUSD`) on the wrong cube, or using `groupBy` on `DEXTradeByTokens`.

---

## The Two Trade Cubes

Bitquery v2 has two Solana trade cubes with **fundamentally different `Trade` shapes**. Mixing them up causes `Cannot query field "X" on type "Solana_DEXTrade_Fields_Trade"` errors.

### `DEXTrades` — buy/sell pair per transaction

The `Trade` object exposes **nested** Buy and Sell sub-objects. There is **no** direct `Trade.Currency`, `Trade.Side`, `Trade.PriceInUSD`, `Trade.AmountInUSD`, or `Trade.Buyer`.

```graphql
DEXTrades(...) {
  Block { Time }
  Transaction { Signature Signer }
  Trade {
    Buy {
      Currency { MintAddress Symbol Name Decimals }
      Account { Address }
      Amount
      Price
      PriceInUSD
    }
    Sell {
      Currency { MintAddress Symbol Name Decimals }
      Account { Address }
      Amount
      Price
      PriceInUSD
    }
    Dex { ProtocolName ProtocolFamily }
    Market { MarketAddress }
  }
}
```

**WHERE filters in DEXTrades:**
- Filter by Dex: `Trade: { Dex: { ProtocolName: { includes: "pump" } } }` ✓
- Filter by token (buy side): `Trade: { Buy: { Currency: { MintAddress: { is: $token } } } }` ✓
- Filter by signer: `Transaction: { Signer: { is: $wallet } }` ✓
- `Trade: { Currency: { MintAddress: ... } }` ✗ — **invalid on DEXTrades**
- `Trade: { Buyer: { is: $wallet } }` ✗ — **invalid on DEXTrades** — use `Transaction: { Signer: { is: $wallet } }`

**Aggregate keys for DEXTrades:**
- `sum(of: Trade_Buy_AmountInUSD)` — buy-side USD volume
- `sum(of: Trade_Sell_AmountInUSD)` — sell-side USD volume
- `count` — trade count

---

### `DEXTradeByTokens` — one row per token per trade

The `Trade` object exposes fields **directly** (Currency, Side, PriceInUSD, AmountInUSD). This is the correct cube for per-token analysis (price streams, volume, top traders, OHLC).

```graphql
DEXTradeByTokens(...) {
  Block { Time }
  Trade {
    Currency { MintAddress Symbol Name Decimals }
    Side { Type Currency { MintAddress Symbol } }
    Price
    PriceInUSD
    Amount
    AmountInUSD
    Account { Owner }
    Dex { ProtocolName ProtocolFamily }
  }
  volumeUsd: sum(of: Trade_Side_AmountInUSD)
  makers: count(distinct: Transaction_Signer)
}
```

**WHERE filters in DEXTradeByTokens:**
- Filter by token: `Trade: { Currency: { MintAddress: { is: $token } } }` ✓
- Filter by side: `Trade: { Side: { Type: { is: buy } } }` ✓
- Filter by Dex: `Trade: { Dex: { ProtocolName: { includes: "pump" } } }` ✓

**Aggregate keys for DEXTradeByTokens:**
- `sum(of: Trade_Side_AmountInUSD)` — total USD volume (use this, NOT `Trade_AmountInUSD`)
- `sum(of: Trade_Amount)` — native token amount
- `count(distinct: Transaction_Signer)` — unique traders (use this, NOT `Trade_Buyer`)
- `count(distinct: Transaction_Signer, if: {Trade: {Side: {Type: {is: buy}}}})` — unique buyers
- `groupBy` is **not supported** on this cube in our current v2 endpoint profile
- If `groupBy` is removed from a query, remove now-unused variables (e.g. `$intervalSeconds`) from the operation signature and `variableShape` too.

**OHLC without groupBy:** return raw time-series rows (limit 500) and compute candles client-side:
```graphql
DEXTradeByTokens(
  where: {Block: {Time: {since: $since}}, Trade: {Currency: {MintAddress: {is: $token}}}}
  orderBy: {ascending: Block_Time}
  limit: {count: 500}
) {
  Block { Time }
  Trade { PriceInUSD Amount AmountInUSD }
}
```

---

## Decision Guide: Which Cube to Use?

| Use case | Cube |
|---|---|
| Real-time trades for all tokens on a DEX (no token filter) | `DEXTrades` with Buy/Sell fields |
| Per-token price stream, OHLC, volume | `DEXTradeByTokens` |
| Per-token latest trades | `DEXTradeByTokens` |
| Per-token detailed stats (buys/sells/makers) | `DEXTradeByTokens` |
| Top traders for a token | `DEXTradeByTokens` |
| First N buyers of a token (ascending time) | `DEXTrades` with `Buy.Currency` filter |
| Trades by a specific wallet | `DEXTrades` with `Transaction.Signer` filter |
| Last trade before migration (graduation check) | `DEXTrades` with `Buy.Currency` + `Dex` filter |

---

## BalanceUpdates — Correct Patterns

`BalanceUpdate.Address` does **not** exist in v2. Use nested account paths.

**For SPL token balances (most use cases):**
```graphql
BalanceUpdates(
  where: {
    BalanceUpdate: {
      Account: { Token: { Owner: { is: $wallet } } }
      Currency: { MintAddress: { is: $token } }
    }
  }
  limitBy: { by: BalanceUpdate_Account_Token_Owner, count: 1 }
) {
  BalanceUpdate {
    Account { Token { Owner } }
    balance: PostBalance(maximum: Block_Slot)
  }
}
```

**For SOL native balance:**
```graphql
BalanceUpdates(
  where: {
    BalanceUpdate: {
      Account: { Owner: { is: $wallet } }
    }
  }
) {
  BalanceUpdate {
    Account { Owner }
    balance: PostBalance(maximum: Block_Slot)
  }
}
```

**Key points:**
- `PostBalance` requires aggregation modifier: `PostBalance(maximum: Block_Slot)` to get the latest balance
- `limitBy` key: use `BalanceUpdate_Account_Token_Owner` (not `BalanceUpdate_Address`)
- WHERE path: `BalanceUpdate: { Account: { Token: { Owner: { is: $wallet } } } }`
- For lists of wallets: `Account: { Token: { Owner: { in: $holders } } }`
- `orderBy` on balance alias: use `BalanceUpdate_balance_maximum` (not `"balance"`)

---

## TokenSupplyUpdates — Currency Metadata Fields

In `TokenSupplyUpdates`, the currency metadata field is `Uri` (camel-case), not `URI`.

Use:

```graphql
TokenSupplyUpdates(
  where: {
    TokenSupplyUpdate: { Currency: { MintAddress: { is: $token } } }
  }
  orderBy: { descending: Block_Time }
  limit: { count: 1 }
) {
  TokenSupplyUpdate {
    Currency { Name Symbol MintAddress Decimals Uri }
    PostBalance
  }
}
```

Avoid:
- `Currency { ... URI }` ✗ (unknown field)

---

## Common Schema Errors → Fix Map

| Error message | Root cause | Fix |
|---|---|---|
| `Cannot query field "Currency" on type "Solana_DEXTrade_Fields_Trade"` | Using `Trade.Currency` on `DEXTrades` | Use `Trade.Buy.Currency` / `Trade.Sell.Currency` |
| `Cannot query field "Side" on type "Solana_DEXTrade_Fields_Trade"` | Using `Trade.Side` on `DEXTrades` | Switch to `DEXTradeByTokens` or use `Trade.Buy`/`Trade.Sell` |
| `Cannot query field "PriceInUSD" on type "Solana_DEXTrade_Fields_Trade"` | Using `Trade.PriceInUSD` on `DEXTrades` | Use `Trade.Buy.PriceInUSD` or `Trade.Sell.PriceInUSD` |
| `Cannot query field "AmountInUSD" on type "Solana_DEXTrade_Fields_Trade"` | Using `Trade.AmountInUSD` on `DEXTrades` | Use `Trade.Buy.Amount` or switch to `DEXTradeByTokens` |
| `Cannot query field "Buyer" on type "Solana_DEXTrade_Fields_Trade"` | Using `Trade.Buyer` on `DEXTrades` | Use `Trade.Buy.Account.Address` for output; `Transaction.Signer` for WHERE |
| `In field "Trade": In field "Buyer": Unknown field` | `Trade: { Buyer: { is: $wallet } }` in WHERE on DEXTrades | Use `Transaction: { Signer: { is: $wallet } }` |
| `Cannot query field "Address" on type "Solana_BalanceUpdate"` | Using `BalanceUpdate.Address` | Use `BalanceUpdate.Account.Token.Owner` (SPL) or `BalanceUpdate.Account.Owner` (SOL) |
| `Cannot query field "URI" on type "Solana_TokenSupplyUpdate_Fields_TokenSupplyUpdate_Currency"` | Using uppercase `URI` in `TokenSupplyUpdate.Currency` | Use `Uri` |
| `In field "Instruction" -> "Accounts" -> "Address": Unknown field` | Using direct `Accounts.Address` in `Instructions.where` | Use `Accounts: { includes: { Address: { is: $token } } }` |
| `Unknown argument "groupBy" on field "DEXTradeByTokens" of type "Solana"` | Attempting interval grouping on `DEXTradeByTokens` | Remove `groupBy`; return raw rows and build candles client-side |
| `Variable "$intervalSeconds" is never used in operation ...` | Query signature still includes interval variable after removing groupBy | Remove `$intervalSeconds` from query args and `variableShape` |
| `Variable "$wallet" is never used in operation ...` | Variable declared in operation but no field references it | Remove `$wallet` from query args and `variableShape` |
| `Unexpected metric name or alias to order balance ...` | Ordering by non-existent alias like `"balance"` | Order by concrete metric name returned by engine (e.g. `BalanceUpdate_balance_maximum`) |
| `Variable "$minCap" of type "Float!" used ... expecting type "String"` | Comparator input type mismatch in token supply filters | Use `String` vars for `PostBalanceInUSD` bound filters in this endpoint profile |
| `This operation was aborted` / `context deadline exceeded` | Query exceeded request timeout budget — often an unbounded Instructions scan | Add `Block: { Time: { since: $since } }` to the WHERE clause; increase `options.timeoutMs` if needed |
| `Field "Trade_Buyer" not found` | Aggregate `count(distinct: Trade_Buyer)` | Use `count(distinct: Transaction_Signer)` |
| `Field "Trade_AmountInUSD" not found` (in DEXTradeByTokens) | Wrong aggregate key | Use `Trade_Side_AmountInUSD` |
| `calculate(expression: ...)` not recognized | Unsupported computed field expression | Remove `calculate`; compute derived values client-side instead |

---

## DEXPools — When to Use

`DEXPools` is the correct cube for:
- New pool creation events
- Liquidity changes and LP snapshots
- Bonding curve progress (Pump.fun graduation threshold)
- Market pair addresses
- Replacing heavy `Instructions` scans that frequently abort/time out

```graphql
DEXPools(
  where: {
    Pool: {
      Dex: { ProtocolName: { includes: "pumpswap" } }
      Market: { BaseCurrency: { MintAddress: { is: $token } } }
    }
  }
) {
  Block { Time }
  Pool {
    Dex { ProtocolName }
    Market { MarketAddress BaseCurrency { MintAddress Symbol } QuoteCurrency { MintAddress Symbol } }
    Base { PostAmountInUSD ChangeAmountInUSD }
  }
}
```

---

## Instructions Cube — Account Filters (Important)

For `Solana.Instructions`, account matching in `where.Instruction.Accounts` must use
`includes`, not direct `Address` equality.

Use:

```graphql
Instructions(
  where: {
    Block: { Time: { since: $since } }
    Instruction: {
      Program: { Name: { includes: "pump" }, Method: { includes: "create" } }
      Accounts: { includes: { Address: { is: $token } } }
    }
    Transaction: { Result: { Success: true } }
  }
) {
  Block { Time }
  Transaction { Signer Signature }
  Instruction { Program { Method } Accounts { Address } }
}
```

Avoid:
- `Accounts: { Address: { is: $token } }` ✗ (invalid shape)

Also avoid duplicate keys in one input object:
- `Program: { Name: ... }` and a second `Program: { Method: ... }` in the same object is **invalid** — GraphQL only keeps the last key.
- Combine into one: `Program: { Name: ..., Method: ... }` ✓

**Always add a `Block.Time.since` filter to Instructions queries** — unbounded Instructions scans (especially with ascending orderBy to find creation events) time out consistently.

---

## Pump.fun Specifics

- **Program address:** `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- **DEX filter:** `Trade: { Dex: { ProtocolName: { includes: "pump" } } }`
- **PumpSwap filter:** `Trade: { Dex: { ProtocolName: { includes: "pumpswap" } } }`
- **Migration detection:** `Instructions` cube with `Program: { Method: { includes: "migrate" } }`
- **Bonding curve progress:** Requires `DEXPools` with `Base.PostAmountInUSD` — exact threshold formula requires live testing
- **First buyers:** Use `DEXTrades` with `Trade: { Buy: { Currency: { MintAddress: { is: $token } } } }` and `orderBy: { ascending: Block_Time }` — output buyer address as `Trade.Buy.Account.Address`

### Token Creation — Correct Method Filter

Filtering Instructions by `Name: {includes: "pump"}` alone returns **all** pump.fun interactions (buys, sells, fees). To target **only new token launches**, filter by the exact program address **and** method:

```graphql
Instruction: {
  Program: {
    Address: {is: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"}
    Method: {is: "create_v2"}
  }
}
```

In the result, `Accounts[0].Address` is the **token mint** and `Transaction.Signer` is the **dev wallet**. Not all pump.fun mints use the `pump` vanity suffix — do not filter by address suffix.

Known pump.fun method values (live-verified, 30-day sample of 2000 instructions):
| Method | Meaning |
|---|---|
| `create_v2` | New token launch — **use this for new token detection** |
| `CreateEvent` | CPI event emitted alongside `create_v2` (single account, less data) |
| `buy` / `buy_exact_sol_in` / `buy_exact_quote_in` | Buy trades |
| `sell` | Sell trade |
| `BuyEvent` / `SellEvent` / `TradeEvent` | CPI event logs for trades |
| `collect_creator_fee` / `CollectCreatorFeeEvent` | Creator fee collection |
| `extend_account` / `ExtendAccountEvent` | Account reallocation |
| `close_user_volume_accumulator` | Volume accumulator housekeeping |
| `sync_user_volume_accumulator` / `init_user_volume_accumulator` | Volume accumulator lifecycle |

**"Mayhem Mode" does not exist on-chain.** No instruction with `mayhem` in the method name has ever appeared in the pump.fun program. The three catalog templates for it (`trackMayhemModeRealtime`, `currentMayhemModeStatus`, `historicalMayhemModeStatus`) have been removed.

---

## Subscriptions

Subscriptions use the same schema rules as queries. `DEXTrades` subscriptions must use `Trade.Buy`/`Trade.Sell` pattern:

```graphql
subscription PumpFunTrades($token: String) {
  Solana {
    DEXTrades(
      where: {
        Trade: {
          Dex: { ProtocolName: { includes: "pump" } }
          Buy: { Currency: { MintAddress: { is: $token } } }
        }
      }
    ) {
      Block { Time }
      Transaction { Signature }
      Trade {
        Buy { Currency { MintAddress Symbol } PriceInUSD Amount }
        Sell { Currency { MintAddress Symbol } }
      }
    }
  }
}
```

For price/OHLC subscriptions, the `Trading.Tokens` cube provides a simpler interface:

```graphql
subscription RealtimeTokenPrices($token: String!) {
  Trading {
    Tokens(where: { Token: { Network: { is: "Solana" }, Address: { is: $token } } }) {
      Block { Time }
      Token { Address Symbol }
      Price { Value Usd }
      Volume { Base Quote Usd }
    }
  }
}
```
