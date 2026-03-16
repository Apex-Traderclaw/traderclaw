# traderclaw-v1

TraderClaw V1 plugin for autonomous Solana memecoin trading. Connects OpenClaw to a trading orchestrator that handles market data, risk enforcement, and trade execution.

## Architecture

```
OpenClaw Agent (brain: reasoning, decisions, strategy evolution)
       │
       │ calls 52 typed tools
       ▼
Plugin (this package) ── HTTP ──→ Orchestrator (data + risk + execution)
                                       │              │
                                   Bitquery        SpyFly Bot
                                   (market data)   (on-chain execution)
```

The plugin gives OpenClaw tools to interact with the Solana trading orchestrator. The orchestrator gathers market data, enforces risk rules, and proxies trades. OpenClaw does all reasoning, decision-making, and strategy evolution.

## Prerequisites

- OpenClaw v2026.1+ with Node >= 22
- An API key from [traderclaw.ai/register](https://traderclaw.ai/register)

## Quick Start

### 1. Install the plugin

```bash
npm install -g traderclaw-v1
```

Or install directly into OpenClaw:

```bash
openclaw plugins install traderclaw-v1
```

### 2. Run setup

```bash
traderclaw setup
```

The setup wizard will:
- Ask for your API key (from [traderclaw.ai/register](https://traderclaw.ai/register))
- Connect to the orchestrator and validate your key
- Create or select a trading wallet
- Write the plugin configuration automatically

That's it. Restart the gateway and start trading:

```bash
openclaw gateway --restart
```

### 3. Run the mandatory startup sequence

Send this prompt to your bot after startup:

```text
Run mandatory startup sequence and report pass/fail for each:
1) solana_system_status
2) solana_gateway_credentials_get (set if missing)
3) solana_alpha_subscribe(agentId: "main")
4) solana_capital_status
5) solana_positions
6) solana_killswitch_status
```

### Non-interactive setup

```bash
traderclaw setup --api-key sk_live_abc123 --url https://api.traderclaw.ai
```

## CLI Commands

### `traderclaw setup`

Interactive setup wizard. Validates API key, connects to orchestrator, sets up wallet, writes config.

Options:
- `--api-key, -k` — API key (skip prompt)
- `--url, -u` — Orchestrator URL (skip prompt, default: `https://api.traderclaw.ai`)

### `traderclaw status`

Check connection health and wallet status at a glance:

```
OpenClaw Solana Trader - Status
=============================================
  Orchestrator:     CONNECTED
  Execution mode:   live
  Upstream:         configured
  System status:    OK
  WS connections:   1

  Wallet:           ACTIVE
  Wallet ID:        1
  Balance:          5.0 SOL
  Open positions:   3
  Unrealized PnL:   0.062 SOL
  Kill switch:      disabled
  Strategy version: v1.2.3
  Mode:             HARDENED
=============================================
```

### `traderclaw config`

View and manage configuration:

```bash
traderclaw config show          # View current config (API key masked)
traderclaw config set <key> <v> # Update a value
traderclaw config reset         # Remove all plugin config
```

Available config keys: `orchestratorUrl`, `walletId`, `apiKey`, `apiTimeout`, `refreshToken`, `walletPublicKey`, `walletPrivateKey`, `gatewayBaseUrl`, `gatewayToken`, `agentId`

### `traderclaw --help`

Print all available commands and options.

### `traderclaw --version`

Print plugin version.

## Advanced: Manual Configuration

If you prefer to configure manually instead of using the CLI, add to `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "solana-trader": {
        enabled: true,
        config: {
          orchestratorUrl: "https://api.traderclaw.ai",
          walletId: 1,
          apiKey: "sk_live_your_key_here",
          apiTimeout: 30000  // optional, default 30s
        }
      }
    }
  }
}
```

Restart the gateway after configuration:

```bash
openclaw gateway --restart
```

## Available Tools (52)

### Scanning
| Tool | Description |
|------|-------------|
| `solana_scan_launches` | Find new Solana token launches |
| `solana_scan_hot_pairs` | Find high-volume trading pairs |
| `solana_market_regime` | Get macro market state (bullish/bearish/neutral) |

### Token Analysis
| Tool | Description |
|------|-------------|
| `solana_token_snapshot` | Price, volume, OHLC data |
| `solana_token_holders` | Holder concentration and distribution |
| `solana_token_flows` | Buy/sell pressure and flow data |
| `solana_token_liquidity` | Pool depth and liquidity profile |
| `solana_token_risk` | Composite risk assessment |

### Intelligence
| Tool | Description |
|------|-------------|
| `solana_build_thesis` | Full context package: market data + strategy weights + memory + risk pre-screen |

### Trading
| Tool | Description |
|------|-------------|
| `solana_trade_precheck` | Pre-trade risk validation |
| `solana_trade_execute` | Execute trade via SpyFly bot |

### Reflection
| Tool | Description |
|------|-------------|
| `solana_trade_review` | Post-trade outcome review |
| `solana_memory_write` | Write journal entry |
| `solana_memory_search` | Search trading memories |
| `solana_memory_by_token` | Token-specific trade history |
| `solana_journal_summary` | Performance stats summary |

### Strategy
| Tool | Description |
|------|-------------|
| `solana_strategy_state` | Read current strategy weights |
| `solana_strategy_update` | Update weights after learning |

### Safety
| Tool | Description |
|------|-------------|
| `solana_killswitch` | Toggle emergency kill switch |
| `solana_killswitch_status` | Check kill switch state |

### Wallet
| Tool | Description |
|------|-------------|
| `solana_capital_status` | Balance, positions, PnL, limits |
| `solana_positions` | Current positions with PnL |
| `solana_funding_instructions` | Deposit instructions |

### Entitlements
| Tool | Description |
|------|-------------|
| `solana_entitlement_plans` | Available limit upgrades |
| `solana_entitlement_purchase` | Purchase upgrade plan |

### System
| Tool | Description |
|------|-------------|
| `solana_system_status` | Orchestrator health check |

## Skills

### solana-trader (Trading Skill v5)
The primary skill that teaches OpenClaw the complete trading lifecycle:

1. **SCAN** — Find opportunities with launch/hot-pair scanners
2. **ANALYZE** — Deep dive with 5 token analysis tools
3. **THESIS** — Assemble full context with build_thesis
4. **DECIDE** — Agent reasons over data using confidence scoring
5. **PRECHECK** — Validate against risk rules
6. **EXECUTE** — Place trade via SpyFly
7. **MONITOR** — Watch positions and capital
8. **REVIEW** — Journal outcomes honestly
9. **EVOLVE** — Update strategy weights based on performance

Includes: token lifecycle framework, anti-rug heuristics, volume pattern reading, FOMO detection, liquidity-relative sizing, house money exits, dead money rule, narrative awareness.

### social-intel (Alpha Feed & Social Intelligence)
Standalone skill for SpyFly alpha feed integration and social intelligence:

- **SpyFly Alpha Feed** — Query recent alpha calls, historical accuracy, price milestone pings
- **Token Social Metadata** — Resolve on-chain metadata to find Twitter/Telegram/Discord links
- **Twitter Community Stats** — Follower count, engagement, growth trajectory, MC-relative benchmarking
- **Twitter Trending** — Narrative/meta detection from viral crypto topics

This skill is designed to merge into the trading skill when both are ready.

## Example Conversation

```
User: Start scanning for opportunities

Agent: Let me check the current market conditions and scan for new tokens.

[calls solana_market_regime]
Market is in a bullish regime with high DEX volume.

[calls solana_scan_launches]
Found 5 new launches in the last hour. POPCAT at 0x7a... looks interesting — high initial volume.

[calls solana_build_thesis with POPCAT address]
Thesis package shows:
- Strong buy pressure (68% buy ratio)
- Adequate liquidity ($180k)
- Holder concentration at 35% (acceptable)
- My strategy weights favor volume_momentum (0.28) — this token scores well there
- No prior trades on this token in my memory
- Risk pre-screen: approved, capped at 0.5 SOL

Based on the thesis data and my learned weights, I'll enter a small position.

[calls solana_trade_precheck]
Approved. Capped size: 0.5 SOL.

[calls solana_trade_execute]
Trade executed. TradeId: 15, PositionId: 4, TX: 5xK...

I'll monitor this position and review after exit.
```

## Troubleshooting

**Plugin won't load:**
- Run `traderclaw status` to check connectivity
- Check `openclaw plugins list` for errors
- Verify `openclaw.plugin.json` exists in the plugin directory

**"apiKey is required" error:**
- Run `traderclaw setup` to configure your API key
- Or manually add `apiKey` to your config: `traderclaw config set apiKey sk_live_...`

**"Could not reach orchestrator" warning:**
- Run `traderclaw status` to diagnose
- Check your internet connection
- Verify the orchestrator URL: `traderclaw config show`

**"Wallet not found" errors:**
- Run `traderclaw setup` to create or select a wallet
- Verify the wallet ID: `traderclaw config show`

**Tools returning errors:**
- Run `traderclaw status` to check system health
- Check if kill switch is enabled
- Verify your wallet has sufficient SOL balance
