# WebSocket + Bitquery Streaming Reference

## Purpose

Use this guide when working with OpenClaw WebSocket behavior, managed Bitquery subscriptions, policy limits, and diagnostics endpoints.

This document covers:
- Where WebSocket traffic enters the app
- How Bitquery subscriptions are multiplexed
- What external clients are allowed to do
- How limits and metering are enforced
- How to validate behavior quickly

This is a companion reference to `SKILL.md`, similar to `bitquery-schema.md` and `query-catalog.md`.

---

## High-Level Architecture

### Local WebSocket Entrypoint

- Path: `/ws`
- File: `server/websocket.ts`
- Manager: `OpenClawWebSocketManager`

Clients connect to `/ws` and can subscribe to:
- Internal OpenClaw channels (`trades`, `positions`, etc.)
- Managed Bitquery channels via `bitquery_subscribe`

### Upstream Bitquery Bridge

- File: `server/services/bitquery-ws-bridge.ts`
- Class: `BitqueryWsBridge`
- Upstream URL: `wss://streaming.bitquery.io/graphql`
- Protocol: `graphql-transport-ws`

The bridge keeps one upstream subscription per `templateKey + variables hash` and fans out events to many local clients.

---

## Bootstrap Wiring

The WebSocket manager is created in `server/websocket.ts` and wired into the Express server in `server/index.ts`. The `BitqueryWsBridge` is instantiated and injected into the WebSocket manager during configuration.

If WebSocket behavior is missing, verify this wiring first.

---

## Message Contract (Client <-> Server)

### Server -> Client Messages

| Type | Description | Payload |
|---|---|---|
| `connected` | Sent on initial WebSocket connection | `{ type: "connected" }` |
| `authenticated` | Sent after successful `auth` message | `{ type: "authenticated" }` |
| `subscribed` | Ack for internal channel subscription | `{ type: "subscribed", channels: string[] }` |
| `bitquery_subscribed` | Ack for managed Bitquery subscription | `{ type: "bitquery_subscribed", subscriptionId: string, templateKey: string }` |
| `bitquery_event` | Upstream Bitquery data event relayed to client | `{ type: "bitquery_event", subscriptionId: string, data: object }` |
| `bitquery_error` | Error from upstream Bitquery subscription | `{ type: "bitquery_error", subscriptionId: string, error: object }` |
| `bitquery_complete` | Upstream subscription completed | `{ type: "bitquery_complete", subscriptionId: string }` |
| `bitquery_unsubscribed` | Ack for unsubscribe request | `{ type: "bitquery_unsubscribed", subscriptionId: string }` |
| `error` | General error message | `{ type: "error", message: string, code?: string }` |
| `pong` | Response to client `ping` | `{ type: "pong" }` |

### Client -> Server Messages

| Type | Description | Payload |
|---|---|---|
| `auth` | Authenticate the WebSocket connection | `{ type: "auth", accessToken: string }` |
| `subscribe` | Subscribe to internal channels | `{ type: "subscribe", channels: string[] }` |
| `bitquery_subscribe` | Subscribe to a managed Bitquery stream | `{ type: "bitquery_subscribe", templateKey: string, walletId: string, variables: object }` |
| `bitquery_unsubscribe` | Unsubscribe from a managed Bitquery stream | `{ type: "bitquery_unsubscribe", subscriptionId: string }` |
| `ping` | Keepalive ping | `{ type: "ping" }` |

**Important:** Do not generate your own `subscriptionId` values. Always use the `subscriptionId` returned by the server in the `bitquery_subscribed` ack message.

---

## Auth + Policy Enforcement

### WebSocket Authentication

1. Client sends `{ type: "auth", accessToken: "..." }` after connecting
2. Server validates the access token
3. Session must be active
4. Client must exist in storage
5. On success, server sends `{ type: "authenticated" }`
6. Until authenticated, only `auth` and `ping` messages are accepted

### Bitquery Subscription Policy Checks

For every `bitquery_subscribe` request, the server enforces the following checks in order:

1. **Template allowlist** — `templateKey` must match a known subscription template (see `query-catalog.md` Subscriptions section)
2. **Tier + scope access** — Client must have `bitquery:catalog` scope and appropriate tier access
3. **Funded wallet gate** — The `walletId` must reference a funded wallet with sufficient SOL balance
4. **Usage/metering** — RPS, bandwidth, subscription counts, and advanced filter limits are checked
5. **Per-client subscription cap** — Maximum active subscriptions per client (default: 20, configurable via `OPENCLAW_WS_MAX_SUBS_PER_CLIENT`)

If any check fails, the server sends an `error` message with a descriptive code and message.

### Funded Wallet Source of Truth

Do not trust stale database balance alone. The current check uses:
- Live balance refresh from on-chain data
- Fallback to direct RPC wallet balance query when cached data is stale

---

## Subscription Lifecycle

### Subscribe Flow

```
Client                          Server                         Bitquery Upstream
  |                               |                               |
  |-- bitquery_subscribe -------->|                               |
  |   { templateKey, walletId,    |                               |
  |     variables }               |                               |
  |                               |-- policy checks ------------->|
  |                               |                               |
  |                               |-- subscribe (if new stream) ->|
  |                               |   (reuse if same templateKey  |
  |                               |    + variables hash exists)   |
  |                               |                               |
  |<- bitquery_subscribed --------|                               |
  |   { subscriptionId,           |                               |
  |     templateKey }             |                               |
  |                               |                               |
  |<- bitquery_event -------------|<-- data event ----------------|
  |   { subscriptionId, data }    |   (fanned out to all          |
  |                               |    subscribers on this stream)|
  |                               |                               |
```

### Unsubscribe Flow

```
Client                          Server                         Bitquery Upstream
  |                               |                               |
  |-- bitquery_unsubscribe ------>|                               |
  |   { subscriptionId }         |                               |
  |                               |-- remove client from stream ->|
  |                               |   (if last subscriber,        |
  |                               |    close upstream sub)         |
  |                               |                               |
  |<- bitquery_unsubscribed ------|                               |
  |   { subscriptionId }         |                               |
```

### Multiplexing

The bridge maintains one upstream WebSocket subscription per unique `templateKey + variables hash`. When multiple clients subscribe to the same stream:

- Only one upstream connection is made
- Events are fanned out to all local subscribers
- When a client unsubscribes, they are removed from the fan-out list
- When the last subscriber disconnects, the upstream subscription is closed

### Client Disconnect Cleanup

When a WebSocket client disconnects:
- All of their active Bitquery subscriptions are automatically cleaned up
- If they were the last subscriber on any stream, those upstream subscriptions are closed
- Internal channel subscriptions are also removed

---

## Available Subscription Templates

These are the managed subscription template keys. See `query-catalog.md` for full details.

| Template Key | Description | Variables |
|---|---|---|
| `realtimeTokenPricesSolana` | Real-time token prices on Solana | `token: String!` |
| `ohlc1s` | 1-second OHLC stream | `token: String!` |
| `dexPoolLiquidityChanges` | DEXPool liquidity changes stream | `token: String!` |
| `pumpFunTokenCreation` | Pump.fun token creation stream | (none) |
| `pumpFunTrades` | Pump.fun trades stream | `token: String` |
| `pumpSwapTrades` | PumpSwap trades stream | `token: String` |
| `raydiumNewPools` | Raydium v4/Launchpad/CLMM new pools stream | (none) |

---

## Raw Query Endpoint Guard

`POST /api/bitquery/query` behavior:
- Regular raw GraphQL queries are still allowed (subject to existing raw scope/tier checks)
- If operation type is `subscription` AND the query matches a managed template operation, the request is rejected with:
  - Code: `BITQUERY_SUBSCRIPTION_MANAGED_ONLY`
  - Message: `"Use /ws with bitquery_subscribe for managed subscriptions"`

This prevents clients from bypassing the managed subscription lifecycle (and its policy enforcement) by sending raw subscription queries through the REST endpoint.

---

## Diagnostics Endpoint

`GET /api/bitquery/subscriptions/active`

Returns:
- Connected WebSocket client count
- Clients with active Bitquery subscriptions
- Bridge diagnostics:
  - `upstreamConnected` — whether the upstream Bitquery WebSocket is connected
  - `activeStreams` — number of active multiplexed streams
  - Per-stream entries: `templateKey`, `streamKey`, `subscriberCount`, `lastEventAt`

Access is policy-protected with `bitquery:catalog` scope.

---

## Agent Tool Integration

Three plugin tools are available for the agent to manage subscriptions programmatically (the agent operates via stateless HTTP, so the orchestrator manages WebSocket connections on its behalf):

| Tool | Description | Parameters |
|---|---|---|
| `solana_bitquery_subscribe` | Subscribe to a managed Bitquery stream | `templateKey: string`, `variables: object` |
| `solana_bitquery_unsubscribe` | Unsubscribe from a stream | `subscriptionId: string` |
| `solana_bitquery_subscriptions` | List active Bitquery subscriptions | (none) |

The orchestrator creates and manages the WebSocket subscription on behalf of the plugin. Events from the subscription feed into the orchestrator's broadcast channels and can be consumed by the agent through subsequent tool calls or polling.

---

## Trading Use Cases

### New Launch Detection
- Use `pumpFunTokenCreation` subscription for real-time alerts on new Pump.fun token launches
- Replaces polling `pumpFunCreation.trackNewTokens` for lower latency
- Combine with `raydiumNewPools` for cross-launchpad coverage

### Active Position Monitoring
- Use `pumpFunTrades` or `pumpSwapTrades` with `{ token: "MINT_ADDRESS" }` to monitor trades on tokens you hold
- Enables real-time flow detection (large sells, whale accumulation) without polling
- Useful for Step 7 (Monitor) — detect momentum collapse or flow reversal immediately

### Real-Time Price Tracking
- Use `ohlc1s` with `{ token: "MINT_ADDRESS" }` for 1-second OHLC candles
- Use `realtimeTokenPricesSolana` for simpler price-only stream
- Enables micro-timing entries (Step 4.2) — watch for pullbacks within uptrends in real-time

### Liquidity Monitoring
- Use `dexPoolLiquidityChanges` to detect LP drains or additions in real-time
- Critical for anti-rug detection on FRESH and EMERGING tokens

---

## Known Gotchas

1. **Wallet not funded errors** — If most templates fail with "wallet not funded", verify the live on-chain balance, not only the cached database value.

2. **Wrong process listening** — If WebSocket connections time out for all templates, check whether the API process you're connecting to is actually the one listening on the expected port.

3. **Single template failures** — If one template fails while others pass, it is usually a schema mismatch inside that template's GraphQL query, not a WebSocket transport problem.

4. **Environment variable typo** — `BITQUERY_API_KEYBOT` typo exists in some env naming. The bridge supports both the typo and corrected env names (`BITQUERY_API_KEY`) for compatibility.

5. **Subscription ID ownership** — Never fabricate `subscriptionId` values. Always use the ID returned by the server in the `bitquery_subscribed` ack. Using invalid IDs for unsubscribe will result in an error.

6. **Unauthenticated messages** — Sending `bitquery_subscribe` before completing `auth` will result in an error. Always authenticate first.

7. **Subscription cap** — Default per-client cap is 20 active subscriptions. Exceeding this returns an error. Unsubscribe from unused streams before creating new ones.
