# Bitquery v2 EAP GraphQL Schema Reference

## Overview

This is the Bitquery v2 EAP (Early Access Program) GraphQL schema reference for Solana. Use this before writing any custom raw GraphQL query via `solana_bitquery_query`.

**Endpoint:** `https://streaming.bitquery.io/graphql` (HTTP and WebSocket)
**Auth header:** `Authorization: Bearer <BITQUERY_API_KEY>`

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
- Filter by Dex: `Trade: { Dex: { ProtocolName: { includes: "pump" } } }`
- Filter by token (buy side): `Trade: { Buy: { Currency: { MintAddress: { is: $token } } } }`
- Filter by signer: `Transaction: { Signer: { is: $wallet } }`
- `Trade: { Currency: { MintAddress: ... } }` — **INVALID on DEXTrades**
- `Trade: { Buyer: { is: $wallet } }` — **INVALID on DEXTrades**

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
- Filter by token: `Trade: { Currency: { MintAddress: { is: $token } } }`
- Filter by side: `Trade: { Side: { Type: { is: buy } } }`
- Filter by Dex: `Trade: { Dex: { ProtocolName: { includes: "pump" } } }`

**Aggregate keys for DEXTradeByTokens:**
- `sum(of: Trade_Side_AmountInUSD)` — total USD volume (NOT `Trade_AmountInUSD`)
- `sum(of: Trade_Amount)` — native token amount
- `count(distinct: Transaction_Signer)` — unique traders (NOT `Trade_Buyer`)
- `count(distinct: Transaction_Signer, if: {Trade: {Side: {Type: {is: buy}}}})` — unique buyers
- `groupBy` is NOT supported; use time-bounded aggregate windows instead
- If `groupBy` is removed, also remove unused variables (e.g. `$intervalSeconds`) from the operation signature

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

---

## TokenSupplyUpdates — Currency Metadata Fields

In `TokenSupplyUpdates`, the currency metadata field is `Uri` (camel-case), not `URI`.

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

---

## Common Schema Errors and Fix Map

| Error message | Root cause | Fix |
|---|---|---|
| `Cannot query field "Currency" on type "Solana_DEXTrade_Fields_Trade"` | Using `Trade.Currency` on `DEXTrades` | Use `Trade.Buy.Currency` / `Trade.Sell.Currency` |
| `Cannot query field "Side" on type "Solana_DEXTrade_Fields_Trade"` | Using `Trade.Side` on `DEXTrades` | Switch to `DEXTradeByTokens` or use `Trade.Buy`/`Trade.Sell` |
| `Cannot query field "PriceInUSD" on type "Solana_DEXTrade_Fields_Trade"` | Using `Trade.PriceInUSD` on `DEXTrades` | Use `Trade.Buy.PriceInUSD` or `Trade.Sell.PriceInUSD` |
| `Cannot query field "AmountInUSD" on type "Solana_DEXTrade_Fields_Trade"` | Using `Trade.AmountInUSD` on `DEXTrades` | Use `Trade.Buy.Amount` or switch to `DEXTradeByTokens` |
| `Cannot query field "Buyer" on type "Solana_DEXTrade_Fields_Trade"` | Using `Trade.Buyer` on `DEXTrades` | Use `Trade.Buy.Account.Address` for output; `Transaction.Signer` for WHERE |
| `Cannot query field "Address" on type "Solana_BalanceUpdate"` | Using `BalanceUpdate.Address` | Use `BalanceUpdate.Account.Token.Owner` (SPL) or `BalanceUpdate.Account.Owner` (SOL) |
| `Cannot query field "URI"` | Using uppercase `URI` in `TokenSupplyUpdate.Currency` | Use `Uri` |
| `Unknown field` in `Instruction.Accounts.Address` | Using direct `Accounts.Address` in `Instructions.where` | Use `Accounts: { includes: { Address: { is: $token } } }` |
| `Unknown argument "groupBy"` on `DEXTradeByTokens` | Attempting interval grouping | Remove `groupBy`; use aggregate windows over `Block.Time` ranges |
| `Variable "$intervalSeconds" is never used` | Leftover variable after removing groupBy | Remove from query args and `variableShape` |
| `Unexpected metric name or alias to order balance` | Ordering by non-existent alias | Order by concrete metric name (e.g. `BalanceUpdate_balance_maximum`) |
| `Variable "$minCap" of type "Float!"` type mismatch | Comparator input type mismatch | Use `String` vars for `PostBalanceInUSD` filters |
| `This operation was aborted` | Query exceeded timeout | Increase `options.timeoutMs` (e.g. 120000) and/or reduce scan window/limit |
| `Field "Trade_Buyer" not found` | Aggregate `count(distinct: Trade_Buyer)` | Use `count(distinct: Transaction_Signer)` |
| `Field "Trade_AmountInUSD" not found` (DEXTradeByTokens) | Wrong aggregate key | Use `Trade_Side_AmountInUSD` |

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

## Instructions Cube — Account Filters

For `Solana.Instructions`, account matching in `where.Instruction.Accounts` must use `includes`, not direct `Address` equality.

```graphql
Instructions(
  where: {
    Instruction: {
      Program: { Name: { includes: "pump" } }
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
- `Accounts: { Address: { is: $token } }` (invalid shape)
- Duplicate keys in one input object — combine into one: `Program: { Name: ..., Method: ... }`

---

## Pump.fun Specifics

- **Program address:** `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- **DEX filter:** `Trade: { Dex: { ProtocolName: { includes: "pump" } } }`
- **PumpSwap filter:** `Trade: { Dex: { ProtocolName: { includes: "pumpswap" } } }`
- **Migration detection:** `Instructions` cube with `Program: { Method: { includes: "migrate" } }`
- **Bonding curve progress:** Requires `DEXPools` with `Base.PostAmountInUSD`

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
        Buy { Currency { MintAddress Symbol } PriceInUSD }
        Sell { Currency { MintAddress Symbol } PriceInUSD }
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
