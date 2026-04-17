# Orchestrator Changes Required for SKILL v4

These are backend/orchestrator changes that should be implemented to fully support the new SKILL.md capabilities. Organized by priority.

---

## Priority 1: Strategy Update Validation (Server-Side)

**File:** `server/routes.ts` → `POST /api/strategy/update`
**Current:** Accepts any weights object without validation.
**Needed:** Server-side enforcement of weight guardrails.

### Validation Rules to Add

```
1. Weight floor: no weight below 0.01
2. Weight cap: no weight above 0.50
3. Max delta per feature: compare incoming weights vs current weights, reject if any feature changed by more than ±0.20 in a single update
4. Sum check: total of all weights must be between 0.95 and 1.05
5. Feature count: must have at least 3 features (prevent degenerate strategies)
6. Version format: strategyVersion must match semver pattern (v[major].[minor].[patch])
7. Version increment: new version must be greater than current version
```

**Status: IMPLEMENTED** — All 7 validation rules are live in the current orchestrator.

### Response on Violation

Return `400` with structured error:
```json
{
  "code": "STRATEGY_VALIDATION_ERROR",
  "message": "Weight delta for volume_momentum exceeds max ±0.20 (was 0.20 → 0.55)",
  "violations": [
    { "rule": "MAX_WEIGHT_DELTA", "feature": "volume_momentum", "current": 0.20, "proposed": 0.55, "maxDelta": 0.20 }
  ]
}
```

**Why:** The SKILL defines per-mode guardrails (±0.10 HARDENED, ±0.15 DEGEN), but the server should enforce a generous outer bound (±0.20) to prevent obviously broken weight updates regardless of mode. Mode-specific tighter enforcement is the agent's responsibility.

---

## Priority 2: Mode Persistence in Strategy State

**File:** `shared/schema.ts` → `strategyState` table, `server/routes.ts`
**Current:** Strategy state stores `featureWeights` and `strategyVersion` only.
**Needed:** Add `mode` field to persist the agent's operating mode across sessions.

### Schema Change

Add to `strategyState` table:
```typescript
mode: varchar("mode").default("HARDENED")
```

### API Changes

- `GET /api/strategy/state` response should include `mode`
- `POST /api/strategy/update` should accept optional `mode` field ("HARDENED" or "DEGEN")
- `POST /api/thesis/build` response `strategyContext` should include `mode`

### Thesis Builder Change

In `server/services/thesis-builder.ts`, include mode in the `strategyContext` section of the ThesisPackage:
```typescript
strategyContext: {
  featureWeights: strategyStateResult?.featureWeights || defaultWeights,
  strategyVersion: strategyStateResult?.strategyVersion || "v1.0.0",
  mode: strategyStateResult?.mode || "HARDENED",
}
```

**Why:** Without mode persistence, the agent loses its operating mode on session restart and defaults back to HARDENED every time.

---

## Priority 3: Consecutive Loss Tracking

**Current:** The agent must manually count consecutive losses by searching memory.
**Needed:** Expose consecutive loss count in `capital_status` or `journal_summary`.

### Option A: Add to Journal Summary Response

In `server/services/memory-store.ts` → `getJournalSummary()`:

Add `consecutiveLosses` field by querying the N most recent trade reviews and counting how many consecutive "loss" outcomes from the most recent backward.

```json
{
  "period": "7 days",
  "totalEntries": 25,
  "wins": 12,
  "losses": 10,
  "neutral": 3,
  "winRate": 48.0,
  "consecutiveLosses": 2,
  "recentNotes": [...]
}
```

### Option B: Add to Capital Status Response

In `server/routes.ts` → `GET /api/capital/status`:

Query recent trade reviews and include consecutive loss count.

**Why:** The SKILL's kill switch trigger depends on consecutive loss count. Making the agent search memory and count manually is error-prone and wastes tool calls.

---

## Priority 4: walletId Format Compatibility

**Current our side:** `walletId` is `serial` (integer) in our schema, plugin sends integer.
**Other team's side:** `walletId` is UUID string everywhere (z.string().uuid() in their Zod schemas).

### For Merge

When the systems are connected, one of these must happen:
1. Our plugin changes `walletId: number` to `walletId: string` in `PluginConfig`
2. Or the other team accepts integer walletIds
3. Or a mapping layer converts between formats

**Recommendation:** Change our plugin to use string walletId. UUIDs are more robust for distributed systems. This requires:
- `openclaw-plugin/index.ts`: Change `walletId: number` to `walletId: string`
- `parseConfig`: Change integer parsing to string parsing
- All tool handlers: No change needed (walletId is already injected via `{ walletId, ...body }`)

---

## Priority 5: Enhanced Thesis with Token Age

**File:** `server/services/market-intel.ts`
**Current:** Token snapshot returns price, volume, OHLC, trade count. No token creation time.
**Needed:** Include token age/creation timestamp in snapshot or risk data.

### Why This Matters

The SKILL v4 includes `token_maturity` as a feature weight. The agent needs to know how old a token is to score this feature. Without it, the feature is un-scorable and the weight is wasted.

### Implementation

In the token snapshot response, add:
```json
{
  "tokenAddress": "...",
  "symbol": "...",
  "priceUsd": 0.00015,
  "createdAt": "2025-03-04T12:00:00Z",
  "ageMinutes": 45,
  ...
}
```

Source: Bitquery can provide token creation time via the `TokenSupplyUpdates` or `TokenCreateInstruction` queries.

---

## Priority 6: Correlated Token Cluster Detection (Future)

**Current:** No concept of token similarity or narrative clusters.
**Needed for:** The SKILL says "max 40% capital across correlated meme cluster."

### Approach Options

1. **Simple heuristic (recommended for now):** Group tokens by launch source (same deployer address, launched within same hour on Pump.fun) or by symbol pattern (dog-themed, cat-themed, etc.)
2. **Agent-side reasoning (current workaround):** The agent can infer correlation from token names/narratives without orchestrator support. This works but is imprecise.
3. **Full implementation (future):** A token clustering service that uses on-chain data to group tokens by deployer, launch platform, holder overlap, and price correlation.

**Recommendation:** Start with option 2 (agent-side). Document in SKILL that correlation is determined by the agent's judgment. Add server support later.

---

## Not Needed (Agent-Side Only)

These SKILL v4 features require NO orchestrator changes:

| Feature | Why No Backend Change |
|---|---|
| Confidence score computation | Pure agent-side reasoning over thesis data |
| Portfolio allocation logic | Agent uses existing walletContext + riskPreScreen data |
| Management mode selection | Agent decides, sends to existing trade_execute |
| Evolution guardrails (mode-specific) | Agent applies internally; server validates outer bounds only |
| Regime-based weight modulation | Agent adjusts weights mentally using market_regime data |
| Position Defense Mode | Agent-side behavioral rule |
| Tagging system | Uses existing memory_write with tags parameter |
| Exploration/exploitation ratio | Agent-side capital allocation decision |
| Exit plan definition | Agent decides, sends params to trade_execute |
| Review honesty / analysis depth | Agent-side behavior |

---

## Plugin Changes (Already Implemented)

The SKILL v4 works with the current 26-tool plugin as-is. No new tools are needed for the core SKILL. The existing tools cover all referenced capabilities.

Future tools that would enhance the SKILL but are not blockers:
- `solana_social_sentiment` — Social intel from Telegram/X/Discord (planned as separate SocialIntelSkill module)
- `solana_token_cluster` — Correlated token detection (Priority 6 above)
- `solana_usage_streams` — Entitlement usage/throughput metrics (referenced in v3 skill, not yet implemented)
