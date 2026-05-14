# Live status queries — always call the tool, never answer from memory

When the user asks any question about **current alpha stream state**, you MUST call the matching plugin tool **on this turn**, then summarize what the tool returned. Do NOT answer from memory, heartbeat history, journal logs, log snippets, or earlier conversation context: alpha counts grow second-by-second and stale answers (especially "none" / "zero") are wrong by default.

## Why this rule exists

The plugin does NOT log every received alpha signal to the journal (that would be noisy at sustained throughput). Signal counts and the buffer of recent signals live **only inside the running plugin process** and are exposed via these tools. If you don't call the tool, you have no data — you only have the absence of log lines, which is not the same thing.

The heartbeat history (`memory/<date>.md`, `MEMORY.md`) only captures signals the agent **personally evaluated** during a heartbeat cycle. It is NOT a record of what the WebSocket received. Using heartbeat history to answer "how many signals" gives a count that is typically much smaller than the real number (because most signals never reach a cycle where the agent processes them).

## Alpha question → tool routing

When the user's question matches a row in column 1, call the tool(s) in column 2 (always on this turn, before replying), read the response, and answer from that data.

| User question (or similar) | Call this tool | What to report back |
|---|---|---|
| "how many alpha signals have we gotten?" / "are we getting alpha?" / "anything from alpha lately?" | `solana_alpha_signals` (with `unseen: false`) | `stats.messageCount` (LIFETIME — survives re-registers/reconnects), `stats.lifetimeUptimeSeconds`, `stats.lastEventTs`, `subscribed`, `bufferSize` |
| "what's the alpha stream doing right now?" / "is alpha connected?" / "alpha health?" | `solana_alpha_signals` (with `unseen: false`) | `subscribed`, `stats.reconnectAttempt`, `stats.unhealthyStreak`, `stats.circuitBackoff`, `stats.lastEventTs` (interpret as "Xs ago") |
| "how many alpha signals in the last hour / today / this week / since Monday?" | `solana_alpha_signals` (live) **AND** `solana_alpha_history` (`days=` covering the window) | Live: `stats.messageCount` since gateway start + signals in `signals[]` within the window. Historical: pings in window from REST. Report both. |
| "any alpha on `<token>` recently / in the last 24h?" | `solana_alpha_signals` (filter `signals[]` by `tokenAddress`/`tokenSymbol`) **AND** `solana_alpha_history` (`tokenAddress=<addr>&days=N`) | Merge live + historical signals for that token by timestamp. |
| "what alpha sources are active?" / "which channels are sending signals?" | `solana_alpha_sources` | `sources` array — name, type, count, avgScore per channel |
| "show me the latest alpha signals" / "new signals?" | `solana_alpha_signals` (with `unseen: false` for full buffer, `unseen: true` only if you intend to consume) | Up to N signals: token, source, kind, signalStage, marketCap, systemScore, ts |

## `stats` fields — what to use vs. what to ignore

`solana_alpha_signals` returns a `stats` object with both **lifetime** and **per-current-WS** fields. **Always quote the lifetime fields to the user.**

USE these for user-facing answers (stable across plugin re-registers and WS reconnects):

- `stats.messageCount` — **lifetime** total alpha_signal messages received since the gateway process started.
- `stats.lifetimeUptimeSeconds` — seconds since the first WebSocket open in this gateway process.
- `stats.lastEventTs` — wall-clock ms of the most recent signal (lifetime).
- `stats.firstConnectedAt` — wall-clock ms of the first WS open in this process.

DO NOT use as "totals" (they reset on every WS reconnect / plugin re-register, which happens every agent turn — so the numbers are misleading as standalone answers):

- `stats.currentWsMessageCount` — messages since the CURRENT WS opened. Useful only for debugging "why is the WS cycling?".
- `stats.uptimeSeconds` — current WS uptime.
- `stats.connectedAt` — current WS open ts.

## When to also call `solana_alpha_history`

The live tool gives you "messages since this gateway process started" and a buffer of ~200 deduped signals. For windows that exceed those:

- The asked window predates `stats.firstConnectedAt` (e.g. user asks "last 24h" but gateway started 2h ago).
- The user asks about a specific date or named window ("yesterday", "since Monday", "last week").
- The buffer is empty (e.g. just after a gateway restart) but the user is asking about a real time range.

…ALSO call `solana_alpha_history` (`days=N` covering the window) and combine the two responses. Tier=enterprise → up to 200 results back ~1 year.

## How to answer (template — live-only)

After the tool returns, structure your reply like this so the user can verify you queried live data:

```
Live alpha state (as of <now>):
- subscribed: <subscribed>
- lifetime: <stats.messageCount> messages over <stats.lifetimeUptimeSeconds>s (≈ <rate>/min) since gateway start
- last signal: <stats.lastEventTs as "Xs/Xm ago">
- buffer (deduped, ≤200): <bufferSize>
- reconnects: <stats.reconnectAttempt>, unhealthy streak: <stats.unhealthyStreak>

Top sources (from `solana_alpha_sources`):
- <sourceName> (<sourceType>): <count> signals, avg score <avgScore>

Sample of latest signals (newest first):
- <tokenSymbol> (<tokenName>) — <kind>/<signalStage>, MC $<marketCap>, score <systemScore>, from <sourceName>, <ts ago>
```

## How to answer (template — when window > gateway lifetime)

```
Alpha activity (<window>):
- live (gateway lifetime, <lifetimeUptimeSeconds>s): <messageCount> messages, currently <bufferSize> in buffer
- historical (`solana_alpha_history` days=<N>): <pings.length> pings in window
- combined unique: <merged count>
- subscribed: <bool>, last signal: <ago>

Top historical sources / tokens: …
```

## Common mistakes to avoid

- **Don't answer "zero" or "none" without calling the tool.** "I don't see any in the logs / heartbeat history" is wrong — signals are NOT logged per-message and heartbeat history only captures what the agent itself touched.
- **Don't reuse a count from earlier in the conversation.** The buffer is continuously updated; quote only freshly-fetched numbers.
- **Don't quote `currentWsMessageCount` or `uptimeSeconds` as "totals".** Those reset every time you (or anyone) interacts with the agent, because each interaction re-registers the plugin. Always use `stats.messageCount` and `stats.lifetimeUptimeSeconds` for user-facing answers.
- **Don't mix heartbeat history with live tool data without flagging it.** If the user asks "how many in the last hour" and you can only see live state, say so and call `solana_alpha_history` to fill the window.
- **Don't claim "the stream is offline" from log gaps alone.** Check `subscribed` and `stats.lastEventTs` — a stream can be healthy with low-traffic minutes.
- **Don't paste raw JSON to the user.** Summarize per the templates above; offer raw JSON only if asked.

## When the user does NOT need a tool call

These are NOT live-state queries; answer from your knowledge:

- "how does the alpha stream work?" (explain the design from `skills/solana-trader/refs/alpha-signals.md` if available)
- "what's a `ca_drop`?" (definition)
- "which alpha sources are premium?" (static info from refs)

## Related

- `HEARTBEAT.md` — per-heartbeat cycle envelope (separate from ad-hoc Q&A).
- `skills/solana-trader/refs/alpha-signals.md` — full alpha pipeline reference.
- Tool catalog: `solana_alpha_subscribe`, `solana_alpha_unsubscribe`, `solana_alpha_signals`, `solana_alpha_sources`, `solana_alpha_history`.
