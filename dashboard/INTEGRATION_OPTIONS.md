# OpenClaw Integration Options Analysis

## The Full Picture

### Three Teams/Pieces

1. **Our team** — Built the **orchestrator** (risk, entitlements, memory, strategy, thesis, dashboard) + the **OpenClaw plugin** (26 tools) + the **trading skill** (SKILL.md)

2. **The other team** — Was supposed to make sure the SpyFly bot + Bitquery data works behind the API endpoints we gave them. Instead, they also built their own orchestrator-like layer on top of SpyFly with auth, risk policy, entitlements, metering, kill switch, etc.

3. **SpyFly native** — The original Telegram trading bot that already existed. Handles actual on-chain execution (Jito bundles), wallet management (KMS), Bitquery queries, TP/SL monitoring.

### The Problem: Two Orchestrator Layers Doing Overlapping Work

| Concern | Our Orchestrator | Their Layer |
|---|---|---|
| Risk checks (slippage, liquidity, concentration, dev holding, daily loss) | Yes | Yes — same rules, same thresholds |
| Kill switch | Per-wallet, DB-backed | Per-wallet + global, DB-backed |
| Entitlements/tiers | Plan-based, time-limited, stackable | Tier-based, permanent, scope-gated |
| Rate limiting | No | Sliding window + metering |
| Auth (HMAC signing) | No | Full HMAC per request |
| Idempotency | No | On trade execute |
| Bitquery proxy | We call Bitquery directly | They proxy it |
| Trade execution | We call SpyFly directly | They proxy it |
| Memory/journal | Yes | No |
| Strategy weights | Yes | No |
| Thesis assembly | Yes (full — with memory + strategy context) | Partial — basic version only |
| Wallet create | Basic (requires publicKey) | Advanced (KMS managed wallets) |
| Dashboard | Full monitoring UI | No |

If the agent calls our orchestrator, and our orchestrator calls their layer, every trade goes through **two risk checks, two entitlement systems, two kill switches**. That's double latency on the hot path for the same result.

### The Decision: One Orchestrator, Best of Both Worlds

**Keep from our side:**
- Memory/journal (they don't have this)
- Strategy weights and evolution (they don't have this)
- Thesis assembly with memory + strategy context (they only have a basic version)
- Dashboard (they don't have this)

**Keep from their side:**
- HMAC auth (production-ready, we have nothing)
- Idempotency on trade execute (we have nothing)
- Rate limiting + usage metering (we have nothing)
- KMS wallet creation (more advanced than ours)
- Structured error codes (we use free text)
- Execution mode (mock/live toggle)

**Merge/decide on one:**
- Risk checks — same rules, pick one implementation
- Kill switch — same concept, pick one
- Entitlements — different models (their tiers vs our plans), need to pick or combine
- Bitquery data — our orchestrator should call their proxy endpoints (not Bitquery directly) since they manage the API key and funded wallet gate
- Trade execution — our orchestrator should call their `/api/trade/execute` endpoint (not SpyFly directly)

---

## Current State (After Phase 1-3 Fixes)

Our orchestrator now supports dual-mode operation:

### What was fixed:
1. **Upstream API Client** (`server/services/upstream-client.ts`) — Shared HTTP client with HMAC SHA256 signing, idempotency key support, per-endpoint timeouts, structured error handling
2. **Bitquery routing** — `bitquery-client.ts` now routes through upstream `/api/bitquery/query` when `UPSTREAM_API_URL` is set; falls back to direct Bitquery calls in dev mode
3. **Trade execution routing** — `trade-executor.ts` now routes through upstream `/api/trade/execute` with `side` in body + `x-idempotency-key` header when upstream is configured; falls back to direct/mock in dev mode
4. **Structured error codes** — All API errors now use `{ code, message }` format matching their contract (`RISK_*`, `KILLSWITCH_ACTIVE`, `VALIDATION_ERROR`, etc.)
5. **`/healthz` endpoint** — Unsigned health check matching their contract format
6. **Execution mode** — `OPENCLAW_EXECUTION_MODE` env var (default: `mock`) surfaced in `/healthz` and `/api/system/status`
7. **Plugin updated** — Health service checks `/healthz` first, reports execution mode and upstream status

### New environment variables:
- `UPSTREAM_API_URL` — Their API base URL (when set, proxy mode activates)
- `UPSTREAM_API_KEY` — API key for HMAC signing
- `UPSTREAM_API_SECRET` — API secret for HMAC signing
- `OPENCLAW_EXECUTION_MODE` — `mock` (default) or `live`

---

## Option A: Merge Their Code Into Ours

### What we'd bring in:
- **HMAC auth middleware** — Their request signing verification (currently they verify our signatures; we'd need to verify incoming requests from the agent/plugin)
- **Idempotency store** — Their `(walletId + idempotencyKey)` dedup table + replay logic
- **Rate limiting** — Sliding window rate limiter with metering headers
- **API clients table** — Their database table for storing API keys/secrets per client
- **KMS wallet integration** — Direct KMS wallet creation (replacing our `publicKey`-required approach)
- **Usage metering** — Request counting, bandwidth tracking, usage warnings

### What we'd remove:
- `upstream-client.ts` — No longer needed since we'd call SpyFly directly
- Their entire API layer — We become the single entry point

### What we'd need from them:
- SpyFly infra access details (bot API URL, auth credentials)
- Bitquery API key (or their proxy stays as a separate data service)
- KMS wallet provisioning access

### Estimated effort: **Large (2-3 weeks)**
- Auth middleware: 2-3 days
- Idempotency: 1-2 days
- Rate limiting: 1-2 days
- KMS integration: 3-5 days
- Testing + migration: 3-5 days

### Risk assessment:
- **High risk**: Need SpyFly infra access, which may not be available
- **Medium risk**: KMS wallet integration requires security review
- **Low risk**: Auth/idempotency/rate limiting are well-understood patterns

### Pros:
- Full control over the entire stack
- Single codebase, single deployment
- Lowest latency (one hop to SpyFly/Bitquery)
- Can tune risk/entitlements without cross-team coordination

### Cons:
- Biggest implementation effort
- We maintain all infrastructure code
- Need SpyFly team cooperation for infra access
- Higher operational burden

---

## Option B: Call Their Layer, Strip Our Duplicates

### What we'd strip from our side:
- **Risk engine simplification** — Keep for advisory pre-screen only (thesis building); let their layer be authoritative for trade execution risk checks
- **Kill switch** — Remove our enforcement on `/api/trade/execute`; their layer enforces it
- **Entitlement enforcement** — Remove our entitlement checks on trade execution; keep for display/dashboard only
- Risk denial logging on trade execute (they log it)

### What we'd keep:
- Memory/journal (they don't have this)
- Strategy weights and evolution (they don't have this)
- Thesis assembly with full context (they only have basic)
- Dashboard (they don't have this)
- Risk engine for advisory/thesis pre-screen (not enforcement)
- Entitlement display and plan browsing

### Architecture after stripping:
```
Agent → Plugin → Our Orchestrator (memory, strategy, thesis, dashboard)
                        ↓ proxies via upstream-client.ts
                Their API Layer (auth, risk enforcement, execution, Bitquery, entitlements, kill switch)
                        ↓
                SpyFly Infra (on-chain execution, KMS wallets)
```

### Latency impact:
- **Trade hot path**: Agent → us → them → SpyFly = 3 hops (was 2 with double enforcement, now 2 with single enforcement through proxy)
- **Bitquery queries**: Agent → us → them → Bitquery = 3 hops
- Added latency per hop: ~5-15ms depending on network

### Estimated effort: **Small (3-5 days)**
- Strip duplicate checks: 1 day
- Test dual-mode operation: 1-2 days
- Documentation: 1 day

### Risk assessment:
- **Low risk**: Minimal code changes, mostly deletion
- **Medium risk**: Dependency on their layer's uptime and correctness
- **Low risk**: We already have the upstream client working

### Pros:
- Least code on our side
- They handle all infra concerns (auth, rate limiting, KMS, execution)
- Fastest to implement
- Clean separation of concerns: we do intelligence, they do infrastructure

### Cons:
- Extra hop on every request
- We lose control of risk tuning (can't adjust thresholds without their cooperation)
- Dependency on their uptime
- Their entitlement model may not match our users' needs

---

## Option C: Merge Our Code Into Theirs

### What we'd move:
- `memory-store.ts` — Memory/journal service + `memory_entries` table
- `thesis-builder.ts` — Thesis assembly with strategy + memory context
- Strategy state management — `strategy_state` table + endpoints
- Dashboard — Entire React frontend

### What they'd need to add:
- PostgreSQL schema for our tables (memory_entries, strategy_state)
- WebSocket broadcasting for real-time updates
- Dashboard hosting

### Coordination required:
- Schema migration of our tables into their database
- API endpoint alignment (they'd need to add our 15+ memory/strategy/thesis endpoints)
- Frontend integration (their project may have different build tooling)
- Testing environment setup

### Estimated effort: **Very Large (4-6 weeks)**
- Code migration: 1-2 weeks
- Integration testing: 1 week
- Dashboard integration: 1-2 weeks
- Cross-team coordination overhead: throughout

### Risk assessment:
- **Very high risk**: Requires their team's active cooperation throughout
- **High risk**: We lose control of our deployment and release cycle
- **Medium risk**: Schema migration could break things

### Pros:
- True single system — no double anything
- Simplest architecture long-term

### Cons:
- Requires significant cross-team coordination
- We lose our independent deployment
- Massive effort
- Risk of scope creep and delays
- We become dependent on their release schedule

---

## Recommendation

### Short-term: Option B (Call Their Layer, Strip Duplicates)

**Why**: It's the fastest path to a working, non-duplicated system. We already have the upstream client working with HMAC signing and idempotency. The main work is stripping our duplicate enforcement code, which is straightforward deletion. We maintain our unique value (memory, strategy, thesis, dashboard) while they handle infrastructure.

**Timeline**: 3-5 days to fully strip duplicates and test.

### Medium-term: Evaluate Option A Based on Experience

After running with Option B for 2-4 weeks:
- If their layer is reliable and responsive → stay with Option B
- If latency is a problem or we need more control → migrate to Option A
- If both teams want to consolidate → consider Option C

### Key metrics to watch during Option B:
- Trade execution latency (end-to-end from our orchestrator through their layer)
- Their layer uptime/availability
- How often we need risk tuning that requires their cooperation
- Whether their entitlement model serves our users

---

## Action Items for Cross-Team Discussion

1. **Confirm their API is ready** for us to route through (all endpoints from TEAM_EXECUTION_CONTRACT)
2. **Get API credentials** (UPSTREAM_API_KEY + UPSTREAM_API_SECRET) for HMAC signing
3. **Agree on risk ownership**: If we go Option B, their risk checks are authoritative — confirm they're comfortable with that
4. **Entitlement alignment**: Discuss whether their tier model (starter/pro/enterprise) replaces our plan model or if both coexist
5. **Kill switch coordination**: If they own the kill switch, how do we surface its state in our dashboard?
6. **SLA expectations**: What uptime/latency guarantees do they provide?
