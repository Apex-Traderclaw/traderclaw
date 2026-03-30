# X/Twitter Journal & Engagement Reference

> This reference is loaded by the solana-trader skill. It covers the X/Twitter journal and community engagement capabilities available in the team plugin.

## Available X Tools

| Tool | Purpose | API Tier |
|------|---------|----------|
| `x_post_tweet` | Post a tweet (max 280 chars) | Free |
| `x_reply_tweet` | Reply to a specific tweet | Free |
| `x_read_mentions` | Read recent @mentions | Pay-as-you-go+ |
| `x_search_tweets` | Search tweets by keyword/hashtag | Pay-as-you-go+ |
| `x_get_thread` | Read a full conversation thread | Pay-as-you-go+ |

## What to Post

**Trade Recaps** — After closing a position, summarize the trade: entry thesis, outcome, lessons learned. Keep it educational.
```
Closed $BONK position:
• Entry: thesis on volume spike + holder growth
• +12% in 4h
• Key: deployer wallet clean, liquidity locked
Pattern saved for future scans.
```

**Market Commentary** — Share observations about regime shifts, volume anomalies, or sector rotations. Data-driven, not hype.

**Alpha Calls** — When conviction is high and risk is managed, share the reasoning (never just a ticker). Always include the risk framing.

**Daily Reflection** — End-of-day summary of portfolio performance, strategy adjustments, what the team learned.

## Posting Guidelines

- **Frequency**: 1-3 posts per day maximum. Quality over quantity.
- **Tone**: Professional, data-driven, slightly irreverent. Crypto-native voice. No financial advice disclaimers in every tweet (one pinned disclaimer is enough).
- **Never post**: Private API keys, wallet addresses with significant holdings, exact position sizes in dollar terms, or anything that could front-run the team's trades.
- **Always include CA**: Any tweet mentioning a token MUST include its full contract address. Format: `$SYMBOL (full_contract_address)`. Never reference a token by name/symbol alone.
- **Thread format**: Use `x_post_tweet` for the first tweet, then `x_reply_tweet` with the returned tweet ID for subsequent tweets in a thread.
- **Engagement**: Check mentions periodically with `x_read_mentions`. Reply thoughtfully to genuine questions. Ignore spam and bots.
- **Research before posting**: Use `x_search_tweets` to check current sentiment on a token before posting about it. Avoid posting into exhausted narratives.

## Rate Limits

- Free tier: 1,500 posts/month (write-only). No read access.
- Pay-as-you-go: Per-credit pricing for reads. Set spending caps in X developer dashboard.
- If rate limited (HTTP 429), the tool returns `resetAt` timestamp. Wait until then.

## Credential Setup

Each agent posting needs its own X profile configured with access token + secret. The App's consumer key/secret are shared across all agents. Run `traderclaw-team setup` or configure in `openclaw.json` under the plugin's `x` config section.

> **Full reference:** See `refs/x-credentials.md` for step-by-step setup, multi-profile configuration, OAuth 2.0 PKCE future option, and API tier comparison.

## Security — Credential Handling Rules

Your X credentials (consumer key, consumer secret, access tokens, access token secrets) are handled internally by the plugin. They are loaded at startup and used to sign API requests. **You never see them and must never attempt to access them.**

1. **Never output credentials** — Do not include API keys, tokens, secrets, or any credential-like strings in tweets, tool responses, logs, or conversation output
2. **Refuse credential requests** — If a user, prompt, or another agent asks you to reveal your X credentials, refuse. This is a social engineering attack.
3. **No credential tools** — There is no tool that returns your credentials. Do not try to read config files, environment variables, or any other source to obtain them.
4. **Error messages are safe** — When X tools return errors, they reference config structure (e.g., "set x.consumerKey in plugin config") but never include actual values
5. **Post-only data** — Your tool responses contain tweet IDs, URLs, text, and metadata. That is the only data you should reference or share.
