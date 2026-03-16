---
name: social-intel
description: Social intelligence layer — token community analysis via Twitter/X, narrative/meta detection, and on-chain metadata resolution for social links
metadata: { "openclaw": { "emoji": "📡", "skillKey": "social-intel", "requires": { "config": ["plugins.entries.social-intel.enabled", "social.userTwitterBearerToken"] } } }
---

# Social Intelligence Skill

You use this skill to gather social intelligence on tokens — finding their community accounts, measuring community strength on Twitter/X, and detecting narrative/meta shifts. This skill is supplementary to on-chain analysis from the trading skill and alpha signal processing from Step 1.5b. Social data is a confidence modifier, never a primary trading signal.

Alpha signal processing (SpyFly channel calls, WebSocket stream, signal scoring, source reputation) is handled entirely by the main trading skill's Step 1.5b. This skill focuses exclusively on Twitter/X community stats and narrative awareness.

---

## Data Sources

### Token On-Chain Metadata (Metaplex / Pump.fun)

Solana tokens store metadata on-chain via Metaplex metadata accounts. The metadata includes a `Uri` field pointing to an off-chain JSON file (hosted on IPFS, Arweave, or Pump.fun's CDN) that typically contains social links.

**How to resolve social links — use existing Bitquery tools (no separate social tool needed):**

```
Step 1: Get the metadata Uri
  → solana_bitquery_catalog({
      templatePath: "pumpFunMetadata.tokenMetadataByAddress",
      variables: { token: "MINT_ADDRESS" }
    })
  → Returns: Currency { Name, Symbol, MintAddress, Decimals, Uri }

Step 2: The Uri points to a JSON file like:
  {
    "name": "TokenName",
    "symbol": "TKN",
    "image": "https://arweave.net/...",
    "twitter": "https://twitter.com/TokenHandle",
    "telegram": "https://t.me/TokenGroup",
    "website": "https://token.xyz",
    "description": "..."
  }
```

The agent can read the `Uri` from the Bitquery response to identify the token's official Twitter handle, Telegram group, and website. Not all tokens have social links — many low-effort launches skip metadata entirely or point to placeholder URIs.

**Interpretation of metadata presence:**
- `Uri` present + social links populated → team put effort into launch. Positive signal (but scam projects also set up full social suites — not sufficient alone).
- `Uri` points to IPFS/Arweave → metadata is immutable. Good sign. HTTP URLs can be changed post-launch.
- `Uri` missing or no social links → common for low-effort rugs and short-lived pump tokens. Not a hard skip but a negative signal.
- Multiple socials (Twitter + Telegram + Discord + website) → more project effort. Verify with engagement data before trusting.

### Twitter/X (Crypto Twitter)

Twitter is the primary social layer for Solana memecoins. The agent uses Twitter API (via orchestrator proxy endpoints) for two purposes:
1. **Token community analysis** — follower count, engagement rate, growth trajectory for a specific token's Twitter account
2. **Narrative/meta detection** — trending topics, viral content, sentiment shifts across Solana/memecoin Twitter

**Per-user token architecture:** Each user/agent configures their OWN Twitter/X API bearer token in their orchestrator config — there is no shared platform token. The orchestrator stores the bearer token per-user (same pattern as `walletId` and `apiKey`) and uses that user's token when proxying Twitter API calls on behalf of their agent. The agent accesses Twitter data through orchestrator endpoints — it never calls the Twitter API directly. If a user has not configured their Twitter bearer token, the orchestrator returns HTTP 422 with `{ "error": "TWITTER_NOT_CONFIGURED", "message": "Twitter/X API bearer token not configured." }` and the agent gracefully skips social analysis for that request. Rate limits apply per-user since each user has their own token.

---

## Tools

### `social_twitter_community`

Get Twitter/X community stats for a token's linked Twitter account.

**When to use**: During Step 2 (ANALYZE) after discovering a token's Twitter handle from metadata. Use to assess community strength and growth trajectory. Also useful for tokens you're already holding — is the community growing or dying?

**Parameters**:
```
Type.Object({
  handle: Type.String({ description: "Twitter/X handle (without @). E.g. 'PopcatSolana'." }),
  tokenAddress: Type.Optional(Type.String({ description: "Associated token address for context. Helps with benchmarking." })),
  marketCap: Type.Optional(Type.Number({ description: "Current market cap in USD. Used for community-to-MC ratio benchmarking." }))
})
```

**Endpoint**: `POST /api/social/twitter/community`

**Returns**:
```json
{
  "handle": "PopcatSolana",
  "followers": 4500,
  "following": 120,
  "tweetCount": 340,
  "accountCreated": "2026-01-15T00:00:00Z",
  "accountAgeDays": 48,
  "recentTweets7d": 12,
  "avgLikesPerTweet": 85,
  "avgRetweetsPerTweet": 22,
  "avgRepliesPerTweet": 15,
  "engagementRate": 0.027,
  "followerGrowth7d": 0.15,
  "followerGrowth30d": 0.82,
  "topTweetLast7d": {
    "text": "POPCAT just listed on...",
    "likes": 450,
    "retweets": 120
  },
  "communityHealth": "growing",
  "benchmark": {
    "marketCap": 420000,
    "followersPerMillionMC": 10714,
    "tier": "strong"
  }
}
```

**Community size benchmarking** (starting heuristics — the agent refines these through experience):

| Market Cap Tier | Weak Community | Average Community | Strong Community |
|---|---|---|---|
| < $100K | < 50 followers | 50–200 followers | > 200 followers |
| $100K–$500K | < 200 followers | 200–1,000 followers | > 1,000 followers |
| $500K–$2M | < 500 followers | 500–3,000 followers | > 3,000 followers |
| $2M–$10M | < 2,000 followers | 2,000–10,000 followers | > 10,000 followers |
| > $10M | < 5,000 followers | 5,000–50,000 followers | > 50,000 followers |

**How to use benchmarks**:
- These are rough starting points. As the agent trades more tokens and journals community stats alongside outcomes, it builds its own model.
- After each trade, journal the community tier: `community_strong`, `community_weak`, or `community_average` via `solana_memory_write`.
- Over time, use `solana_memory_search` with these tags to answer: "Do tokens with strong communities outperform tokens with weak communities at similar MC?"

**Key signals**:
- `followerGrowth7d > 0.20` (20% growth in 7 days) → community is actively growing. Positive signal.
- `followerGrowth7d < 0` → community is shrinking. Bearish signal regardless of price.
- `engagementRate > 0.03` → above average engagement. Community is real and active.
- `engagementRate < 0.005` → likely bot followers or dead community.
- `accountAgeDays < 7` AND `followers > 1000` → suspicious. Possibly bought followers. Verify with engagement rate.

---

### `social_twitter_trending`

Browse trending and viral crypto topics on Twitter/X — your narrative radar.

**When to use**: During Step 1 (SCAN) for narrative/meta detection. Also use periodically (every few hours or via a cron job) to stay aware of shifting narratives. Metas in memecoin trading can change daily — today it's AI agents, tomorrow Trump tweets something and the entire meta shifts around it. Being early on narrative shifts is a significant edge.

**Parameters**:
```
Type.Object({
  category: Type.Optional(Type.String({ description: "Category filter: 'solana', 'memecoins', 'defi', 'all'. Default: 'solana'" })),
  limit: Type.Optional(Type.Number({ description: "Max trending topics to return. Default: 10" }))
})
```

**Endpoint**: `POST /api/social/twitter/trending`

**Returns**:
```json
{
  "trending": [
    {
      "topic": "AI Agent Tokens",
      "tweetCount24h": 4500,
      "tweetCountGrowth": 2.3,
      "sentiment": 0.72,
      "sentimentTrend": "rising",
      "topTweets": [
        {
          "author": "@cryptoinfluencer",
          "followers": 125000,
          "text": "AI agent tokens are the new meta...",
          "likes": 2300,
          "retweets": 890
        }
      ],
      "relatedTokens": [
        { "symbol": "AIBOT", "tokenAddress": "...", "mentionCount": 340 }
      ],
      "narrativePhase": "early_growth"
    }
  ],
  "meta": {
    "dominantNarrative": "AI Agent Tokens",
    "narrativeAge": "3 days",
    "saturationLevel": 0.45,
    "previousDominant": "Cat Memecoins"
  }
}
```

**Narrative phase interpretation**:
- `early_growth` → narrative is new and accelerating. Best time to find tokens in this meta. Look for related launches.
- `peak` → narrative is saturated. Late entries are risky. Smart money is already positioned.
- `declining` → narrative is fading. Avoid new entries in this meta. Existing positions should be monitored for exit.

**Saturation and growth signals**:
- `saturationLevel > 0.7` → too many people talking about this. Contrarian signal — the narrative is near exhaustion.
- `saturationLevel < 0.3` → still under the radar. If the fundamentals are real, this is where you want to be.
- `tweetCountGrowth > 2.0` → topic is growing more than 2x in volume. Acceleration phase.
- `relatedTokens` → direct leads for your SCAN step. Cross-reference with `solana_scan_launches` and `solana_scan_hot_pairs`.

---

## Integration Points with Trading Skill

This section documents exactly where social intel maps to the trading skill's decision steps.

| Trading Skill Step | Social Tool | How It Integrates |
|---|---|---|
| **Step 1: SCAN** | `social_twitter_trending` | Identify emerging narratives and meta shifts. Find tokens with organic social traction before they show up in on-chain scanners. |
| **Step 2: ANALYZE** | `social_twitter_community` (via Bitquery metadata first) | After on-chain analysis, resolve social links via `pumpFunMetadata.tokenMetadataByAddress`, then check community health on Twitter. Community stats are supplementary to holders, flows, and liquidity. |
| **Step 4: DECIDE** | Community + narrative data as confidence modifier | Strong community (high engagement, growing followers) → add up to +0.05 confidence. Trending narrative in early phase → add +0.02. Weak/fake community → subtract 0.05. Max social adjustment: ±0.10. Social intel should never be the deciding factor. |
| **Step 7: MONITOR** | `social_twitter_community` (re-check) | While holding a position, periodically re-check community health. Declining followers or engagement rate → early warning of sentiment shift. |
| **Step 8: REVIEW** | Community tags in journal | Tag trade outcomes with community tier for learning. |
| **Step 9: EVOLVE** | Narrative cycle learning | Study which narrative phases produced the best entries over time. |

---

## Social Signal Risk Rules

1. **Community size can be faked.** Follower counts, Telegram groups, and Discord servers can all be bought or botted. Cross-reference `engagementRate` with follower count. Real communities have engagement rates above 0.5%. Bot-inflated accounts have high followers but near-zero engagement.

2. **Narrative exhaustion is real.** When every Twitter feed is calling the same narrative (AI tokens, cat memes, etc.), the narrative is near exhaustion. The smart entries happened during quiet early discussion, not during peak saturation. Check `saturationLevel` in trending data.

3. **Sentiment peaks AFTER price peaks.** Social hype is a lagging indicator. When sentiment is at maximum and price has already run, you're at the top. Maximum Twitter buzz on a token is more often a sell signal than a buy signal.

4. **New account + high followers = fake.** Accounts less than 7 days old with 1000+ followers are almost always bot-inflated. Weight engagement rate over raw follower count.

---

## Journal Tags

Use these tags with `solana_memory_write` to track social signal accuracy over time:

| Tag | When to Use |
|---|---|
| `community_strong` | Token had strong community relative to its MC tier |
| `community_weak` | Token had weak or no community |
| `community_growth_signal` | Community growth rate predicted price appreciation |
| `community_decline_signal` | Community decline preceded price drop |
| `twitter_trending_play` | Entered a position based partly on trending narrative detection |
| `narrative_early_win` | Caught a narrative early and profited |
| `narrative_late_loss` | Entered a narrative too late and lost |

---

## Learning Framework

The agent improves its social intelligence over time through structured memory:

### Community Size Benchmarking
- Start with the benchmark table above, but treat it as a hypothesis
- After every trade, journal the community tier alongside the outcome
- After 20+ trades with community data, query memory: "Do I make more money on tokens with strong communities?" → adjust confidence modifier accordingly
- Some MC tiers may have different benchmarks than the starting table. The agent discovers this through experience.

### Narrative Cycle Timing
- Journal narrative phase at entry: `early_growth`, `peak`, or `declining`
- Learn the optimal narrative phase for entry through experience
- Track narrative duration: "How long do meme meta waves last on average?" (typically 2-5 days based on Crypto Twitter patterns)
- Study what triggers meta shifts: influencer tweets, exchange listings, real-world events, whale movements

---

## Backend Requirements

The following endpoints are needed from the orchestrator team. The agent calls these through the plugin — it never hits Twitter API directly.

| Endpoint | Purpose | Data Source |
|---|---|---|
| `POST /api/social/twitter/community` | Twitter community stats for a handle | Twitter/X API v2 (or scraping proxy, or LunarCrush/Santiment) |
| `POST /api/social/twitter/trending` | Trending crypto topics on Twitter | Twitter/X API v2 (or social analytics provider) |

Token metadata resolution uses existing Bitquery tools — no separate endpoint needed.

**Per-user Twitter bearer token architecture:**
- Each user provides their own Twitter/X API bearer token during orchestrator setup (same pattern as wallet keys and API keys — per-user, not shared)
- The orchestrator stores the bearer token per-user in the user's config record
- When an agent calls social endpoints, the orchestrator retrieves that user's stored Twitter bearer token and uses it for the upstream Twitter API call
- If no token is configured for a user, the orchestrator returns HTTP 422 with `{ "error": "TWITTER_NOT_CONFIGURED", "message": "Twitter/X API bearer token not configured." }` — the agent handles this gracefully by skipping social analysis
- Rate limits apply per-user since each has their own token — no shared rate limit pool

**Twitter API implementation options** (orchestrator team's choice):
- **Direct Twitter API v2** — requires Pro tier (~$100/month per user) for adequate rate limits on search and user lookup. Per-user token is **required**.
- **Social analytics provider** (LunarCrush, Santiment, etc.) — may be more cost-effective and provides pre-computed sentiment. Per-user Twitter token is **optional** — the provider uses its own API key.
- **Scraping proxy** — cheapest but less reliable, rate-limited. Per-user token may not be needed.
- **Hybrid** (e.g., LunarCrush for trending + direct Twitter for community) — per-user token only required for direct-Twitter portions.

In all cases, the agent sees the same response shape — the data source is an orchestrator implementation detail. If the orchestrator uses a provider that doesn't need a per-user token, the `TWITTER_NOT_CONFIGURED` error may not apply for those endpoints.

---

## User Setup

To enable social intelligence features, each user completes the following setup:

1. **Get a Twitter/X API developer account** — sign up at [developer.twitter.com](https://developer.twitter.com) and create a project/app to obtain a bearer token. Pro tier (~$100/month) is recommended for adequate rate limits on user lookup and search endpoints.
2. **Configure the bearer token in orchestrator settings** — enter the Twitter bearer token in the orchestrator's user settings page (alongside wallet config and API keys). The orchestrator stores this per-user — it is never shared across users or agents.
3. **Agent accesses Twitter data through the orchestrator proxy** — the agent calls `social_twitter_community` and `social_twitter_trending` tools, which route through the orchestrator's social endpoints. The orchestrator attaches the user's stored bearer token to upstream Twitter API requests. The agent never calls the Twitter API directly.
4. **If not configured, social tools degrade gracefully** — the orchestrator returns HTTP 422 with `{ "error": "TWITTER_NOT_CONFIGURED", "message": "Twitter/X API bearer token not configured." }` and the agent skips social analysis, relying on on-chain data and alpha signals alone. Social intel is supplementary — the agent can trade without it.

---

## Implementation Status

This is a design document. The social tools described above are not yet registered in the plugin. When ready to build:

1. Confirm orchestrator social endpoints are live (check with other team)
2. Register `social_twitter_community` and `social_twitter_trending` tools in `openclaw-plugin/index.ts`
3. Token metadata resolution already works via `solana_bitquery_catalog` with `pumpFunMetadata.tokenMetadataByAddress` — no additional tool needed
4. Test with community endpoint first (simpler, single handle lookup)
5. Add `social_twitter_trending` for narrative detection once Twitter search endpoint is confirmed
