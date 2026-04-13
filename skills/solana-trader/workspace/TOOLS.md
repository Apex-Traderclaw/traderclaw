# TOOLS.md - Trading Environment Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your trading setup.

## What Goes Here

Things like:

- Wallet address and trading mode
- X/Twitter credential status and handle
- API quirks you discover
- Tool behavior notes and edge cases
- Rate limit observations
- Anything environment-specific

## Tool Inventory (101 tools — 98 Solana + 3 X read-only)

Every tool has a mandatory trigger — when the trigger condition is met, you MUST call the tool. "Cron-only" tools are called during cron jobs, not the heartbeat fast loop.

### System & Auth (6)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_system_status` | Check orchestrator health | Startup sequence; when any tool returns connection errors |
| `solana_startup_gate` | Run mandatory startup sequence | First heartbeat of every session (SKILL.md § Startup) |
| `solana_traderclaw_welcome` | Get welcome message | Immediately after startup gate completes |
| `solana_gateway_credentials_get` | Check gateway registration | Startup sequence (manual path) |
| `solana_gateway_credentials_set` | Register gateway URL and token | When gateway is not registered (startup) |
| `solana_gateway_forward_probe` | Test forwarding path health | Startup sequence; when events stop arriving |

### Wallet & Capital (11)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_wallets` | List all wallets | Startup; when user asks about wallets |
| `solana_wallet_create` | Create a new wallet | When user requests a new wallet |
| `solana_capital_status` | Capital and daily limits | Step 0 every heartbeat; Step 9 for report |
| `solana_funding_instructions` | Get deposit instructions | When balance is zero or user asks |
| `solana_wallet_token_balance` | On-chain SPL balance (POST) | Step 0 when position balance seems off; Step 6 for on-chain verification |
| `solana_sweep_dead_tokens` | Batch-exit losing positions | `dead_money_sweep` cron; Step 0 when multiple dead positions found |
| `solana_killswitch_status` | Check kill switch state | Step 0 every heartbeat |
| `risk_management_get_default` | Read per-wallet default TP/SL/trailing used when buys omit risk | Before relying on implicit defaults; after user asks about protection |
| `risk_management_set_default` | Save per-wallet default exit plan for future buys | When user or policy wants custom defaults instead of platform system default |
| `trade_size_limit_get` | Read max **buy** size (SOL) from wallet `limits` (default 1.5) | Before every buy or when user asks about size limits |
| `trade_size_limit_set` | Set max **buy** size (SOL) on wallet `limits` | When user asks to change the per-order cap |
| `position_risk_management_update` | Adjust TP/SL/trailing **numbers** on an open position (same level count) | After entry when refining exits without removing levels |

### Scanning & Discovery (4)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_scan` | Combined launches + hot pairs | Alternative to calling launches + hot_pairs separately |
| `solana_scan_launches` | Scan for new token launches | Step 1 every heartbeat |
| `solana_scan_hot_pairs` | Find high-volume pairs | Step 1 every heartbeat |
| `solana_market_regime` | Get macro market state | Step 3 for regime modulation of weights; `strategy_evolution` cron |

### Token Analysis (6)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_token_snapshot` | Price, volume, OHLC | Step 2 for every candidate token |
| `solana_token_holders` | Holder distribution, dev holdings | Step 2 for every candidate token |
| `solana_token_flows` | Buy/sell pressure, net flow | Step 2 for every candidate token |
| `solana_token_liquidity` | Pool depth, DEX breakdown | Step 2 for every candidate token |
| `solana_token_risk` | Composite risk profile | Step 2 for every candidate token |
| `solana_token_socials` | Social metadata (X, Telegram, Discord, website) | Step 2 for every candidate token; before `x_search_tweets` |

### Trading (6)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_build_thesis` | Build full thesis package | Alternative to calling individual analysis tools; slower but comprehensive |
| `solana_trade_precheck` | Risk/policy pre-check | Step 5 before every trade execution — mandatory |
| `solana_trade_execute` | Execute a trade (full params) | Step 5 for entries; Step 7 for exits |
| `solana_trade` | Execute a trade (shorthand) | Same as trade_execute but fewer params |
| `solana_trade_review` | Post-trade review with tags | Step 7 after every position close — mandatory |
| `solana_positions` | Current positions and PnL | Step 0 every heartbeat; Step 6 for monitoring |

### Trade History & Risk (2)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_trades` | Trade history with pagination | `daily_performance_report` cron; `strategy_evolution` cron; when reviewing patterns |
| `solana_risk_denials` | Risk denial log | When trades are denied — check why; `daily_performance_report` cron |

### Strategy (2)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_strategy_state` | Current weights and mode | `strategy_evolution` cron; Step 0 for drift check |
| `solana_strategy_update` | Update feature weights | `strategy_evolution` cron only — never during fast loop |

### Entitlements (5)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_entitlement_costs` | Tier costs and capabilities | When user asks about pricing |
| `solana_entitlement_current` | Current tier and limits | Startup; when hitting rate limits |
| `solana_entitlement_plans` | Available monthly plans | When user asks about upgrade options |
| `solana_entitlement_purchase` | Buy a plan | When user explicitly requests purchase |
| `solana_entitlement_upgrade` | Upgrade account tier | When user explicitly requests upgrade |

### Alpha Signals (5)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_alpha_subscribe` | Subscribe to alpha stream | Startup sequence; when stream disconnects |
| `solana_alpha_signals` | Poll buffered signals | Step 1.5 every heartbeat |
| `solana_alpha_history` | Historical signal data | Step 1.5 to check prior calls on a token; Step 7 to check source accuracy after exit |
| `solana_alpha_sources` | Per-source performance stats | Step 1.5 to check source win rates; `source_reputation_recalc` cron |
| `solana_alpha_submit` | Submit candidate to alpha | When you discover a high-conviction opportunity from scan (not alpha) |

### Firehose (2)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_firehose_config` | Configure firehose filters | Startup; when changing scan parameters |
| `solana_firehose_status` | Check firehose health | Startup; when scan results seem stale |

### Bitquery Intelligence (7)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_bitquery_templates` | List available templates | First heartbeat of session — discover and cache; when unsure which template to use |
| `solana_bitquery_catalog` | Run pre-built template | Step 2: MANDATORY for FRESH tokens (first100Buyers, devHoldings); Step 2: website metadata check for tokens >0.60 |
| `solana_bitquery_query` | Run custom raw GraphQL | When no catalog template fits your query need |
| `solana_bitquery_subscribe` | Subscribe to real-time stream | Step 5: after every successful buy (realtimeTokenPricesSolana); startup for discovery streams |
| `solana_bitquery_unsubscribe` | Unsubscribe from stream | Step 7: after every exit; `subscription_cleanup` cron for orphaned subscriptions |
| `solana_bitquery_subscriptions` | List active subscriptions | Step 1: check for buffered events; `subscription_cleanup` cron |
| `solana_bitquery_subscription_reopen` | Renew expiring subscription | `subscription_cleanup` cron for subscriptions nearing 24h expiry |

### Memory & State (13)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_state_save` | Persist durable state + MEMORY.md | Step 8 every heartbeat if state changed |
| `solana_state_read` | Read durable state | When MEMORY.md is missing or stale |
| `solana_daily_log` | Append to daily log | Step 8 every heartbeat — mandatory |
| `solana_memory_trim` | Smart memory compaction (daily logs, stale state, old decisions/bulletin, stale snapshots). Reports bytesFreed | `memory_trim` cron daily at 03:00 UTC |
| `solana_decision_log` | Log trade decisions | Step 5 before every trade; Step 8 for significant non-trade decisions |
| `solana_team_bulletin_post` | Post to team bulletin | Step 8 every heartbeat with tag `position_update` — mandatory |
| `solana_team_bulletin_read` | Read team bulletin | Memory context load; when checking multi-agent coordination |
| `solana_context_snapshot_write` | Write portfolio world-view | Step 8 every heartbeat — mandatory (feeds bootstrap) |
| `solana_context_snapshot_read` | Read latest snapshot | When context is missing from bootstrap |
| `solana_memory_write` | Write to server-side memory | Step 8 for lessons/observations; Step 5 for pre_trade_rationale; Step 7 for source_reputation |
| `solana_memory_search` | Search server-side memory | Memory context load; before website fetch (cache check); before trusting alpha source |
| `solana_memory_by_token` | Memory for specific token | Step 5: before every trade — check prior history; Step 2: when re-analyzing a known token |
| `solana_journal_summary` | Performance summary stats | `daily_performance_report` cron; `strategy_evolution` cron |

### Deterministic Compute (4)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_compute_confidence` | Weighted confidence formula | Step 3 for every candidate — MANDATORY, never do manual math |
| `solana_compute_freshness_decay` | Signal age decay factor | Step 3 for alpha-sourced candidates — apply decay to stale signals |
| `solana_compute_position_limits` | Full position sizing ladder | Step 4 for every trade — MANDATORY, never calculate manually |
| `solana_compute_deployer_risk` | Deployer risk classification | Step 2 for FRESH tokens — MANDATORY; returns HIGH/MEDIUM/LOW |

### Deep Analysis (2)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_history_export` | Export decisions + trades + memory | `daily_performance_report` cron; when user requests export |
| `solana_pattern_store` | Read/write/list named patterns | `strategy_evolution` cron for recording/referencing recurring patterns |

### X/Twitter — Read-Only Social Intel (3)
| Tool | Purpose | When to Call |
|---|---|---|
| `x_search_tweets` | Search tweets (social analysis) | Step 2 for social intel on candidates >0.60; Step 6 for social exhaustion check on held positions |
| `x_read_mentions` | Read mentions | When checking community engagement; `daily_performance_report` cron |
| `x_get_thread` | Get full thread context | When a mention requires thread context to understand |

### Intelligence Lab (17) — V1-Upgraded
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_candidate_write` | Record token with features | Step 2: EVERY analyzed token — mandatory (feeds learning dataset) |
| `solana_candidate_get` | Read/list candidates | `intelligence_lab_eval` cron; when reviewing past analysis |
| `solana_candidate_label_outcome` | Label trade outcome | Step 7: after EVERY exit — mandatory (feeds learning loop) |
| `solana_candidate_delta` | Compare stored vs current features | Step 6: on held positions to detect feature degradation |
| `solana_contradiction_check` | Detect conflicting claims | Step 1.5: when 2+ alpha signals on same token disagree |
| `solana_scrub_untrusted_text` | Scrub external text | Step 2: before using ANY tweet/Discord/website text — mandatory |
| `solana_source_trust_refresh` | Recalculate source trust | `source_reputation_recalc` cron |
| `solana_source_trust_get` | Get source trust score | Step 1.5: before acting on any alpha signal — mandatory |
| `solana_deployer_trust_refresh` | Recalculate deployer trust | `intelligence_lab_eval` cron |
| `solana_deployer_trust_get` | Get deployer trust score | Step 0: for held positions; Step 2: for FRESH tokens — mandatory |
| `solana_model_registry` | List/register scoring models | `intelligence_lab_eval` cron; when setting up champion/challenger |
| `solana_model_score_candidate` | Score with a model | Step 3: score candidate with champion model (if model exists) |
| `solana_replay_run` | Run offline replay evaluation | `intelligence_lab_eval` cron |
| `solana_model_promote` | Promote challenger to champion | `intelligence_lab_eval` cron when challenger outperforms |
| `solana_evaluation_report` | Confusion matrix, accuracy, F1 | `intelligence_lab_eval` cron |
| `solana_replay_report` | Replay comparison report | `intelligence_lab_eval` cron |
| `solana_dataset_export` | Export candidate dataset | When user requests data export; external analysis |

### Utility (1)
| Tool | Purpose | When to Call |
|---|---|---|
| `web_fetch_url` | Fetch webpage content | Step 2: website legitimacy check for tokens >0.60 |

### Runtime (3)
| Tool | Purpose | When to Call |
|---|---|---|
| `solana_runtime_status` | Plugin runtime health | Diagnostics; when tools behave unexpectedly |
| `solana_agent_sessions` | List agent sessions | Diagnostics; when checking session state |
| `solana_classify_deployer_risk` | Deployer risk (alias) | Same as `solana_compute_deployer_risk` — use either |

## X/Twitter (Read-Only)

- Status: [configured/not configured — update this after startup]
- Read tools: x_search_tweets, x_read_mentions, x_get_thread (social analysis only)
- X posting is not available in the public edition

## Wallet

- Address: [populated after startup gate completes]
- Trading mode: [HARDENED/DEGEN — populated after startup]
- Tier: [starter/pro/enterprise — populated after startup]

## API Quirks & Lessons

(Add notes here as you learn about tool behavior, edge cases, rate limits, and patterns)

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
