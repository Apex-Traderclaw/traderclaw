# traderclaw-v1

TraderClaw V1 is an OpenClaw plugin for autonomous Solana trading.

It exposes typed `solana_*` tools in OpenClaw and connects them to the TraderClaw orchestrator (`https://api.traderclaw.ai`) for market data, risk checks, and execution.

## Start Here

- Beginner install: [`INSTALL_ZERO_TO_HERO.md`](INSTALL_ZERO_TO_HERO.md)
- Canonical install contract: [`INSTALL_CONTRACT_v1.0.7.md`](INSTALL_CONTRACT_v1.0.7.md)
- External installer teams: [`README_EXTERNAL_TAILSCALE_INSTALLER.md`](README_EXTERNAL_TAILSCALE_INSTALLER.md)

## Prerequisites

- OpenClaw CLI installed
- Node.js >= 22
- Network access to `https://api.traderclaw.ai`

Optional:
- Tailscale (if you want event-driven gateway forwarding)

## Install

Choose one:

```bash
npm install -g traderclaw-v1@1.0.7
```

or:

```bash
openclaw plugins install traderclaw-v1@1.0.7
```

Then:

```bash
openclaw gateway restart
```

## Setup Lanes

### Lane A: Quick Local (minimal friction)

```bash
traderclaw setup --signup --url https://api.traderclaw.ai --skip-gateway-registration
```

Use this when you want the fastest successful setup and will enable callbacks later.

### Lane B: Event-Driven (gateway forwarding enabled)

```bash
traderclaw setup --signup --url https://api.traderclaw.ai \
  --gateway-base-url <gatewayBaseUrl> \
  --gateway-token <gatewayToken>
```

Use this when you already exposed your OpenClaw gateway and want orchestrator push callbacks.

## Setup Flags

`traderclaw setup` supports:

- `--signup` create account/session when no API key is available
- `--api-key, -k <oc_key>` use existing API key
- `--url, -u <url>` orchestrator URL (default: `https://api.traderclaw.ai`)
- `--wallet-private-key <base58>` reuse existing wallet key
- `--gateway-base-url, -g <url>` callback URL for orchestrator
- `--gateway-token, -t <token>` gateway bearer token
- `--skip-gateway-registration` complete setup without callback registration

## Verify

```bash
openclaw plugins list
traderclaw status
openclaw gateway status
```

For event-driven lane:

```bash
curl -H "Authorization: Bearer <gatewayToken>" <gatewayBaseUrl>/health
```

## Common Commands

```bash
traderclaw status
traderclaw login --url https://api.traderclaw.ai
traderclaw config show
openclaw logs --follow
openclaw gateway restart
```

## Available Tool Surface

The plugin currently registers a broad trading tool surface (scan, token analysis, strategy, execution, alpha subscriptions, gateway credential APIs, and system diagnostics) under `solana_*` names.

To inspect loaded tools in runtime:

```bash
openclaw plugins list
```

## Troubleshooting

### Session expired

```bash
traderclaw login --url https://api.traderclaw.ai
openclaw gateway restart
```

### Gateway credentials not active

- Verify `gatewayBaseUrl` is reachable from orchestrator (not localhost).
- Verify `gatewayToken` matches `~/.openclaw/openclaw.json` -> `gateway.auth.token`.
- Re-run setup with `--gateway-base-url` and `--gateway-token`.

### Wallet balance still 0 after funding

- Confirm Solana mainnet transfer.
- Confirm recipient equals the wallet address shown by `traderclaw status` / bot funding instructions.
- Confirm tx finalized in explorer.

### Non-blocking warnings you may see

- `plugin id mismatch (manifest uses "solana-trader", entry hints "traderclaw-v1")`
- `unknown format "uuid" ignored in schema ...`

Both are informational in current OpenClaw/plugin combination.
