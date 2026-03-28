# TraderClaw External Installer Guide (v1.0.7)

This guide is for teams implementing a GUI/CLI installer around `solana-traderclaw@1.0.18`.

It aligns external installer behavior with the canonical contract in `INSTALL_CONTRACT_v1.0.7.md`.

---

## 1) Integration Outcome

Installer integration is successful when the user can complete:
- plugin installation
- wallet/session onboarding
- one of two explicit lanes:
  - **Quick Local**: setup complete, gateway registration intentionally skipped
  - **Event-Driven**: gateway credentials registered and `active: true`

---

## 2) Required Lane Choice

Installers must present this decision:

1. Quick Local (recommended first run)
2. Event-Driven (gateway callbacks enabled now)

If Event-Driven fails, user must be able to:
- retry registration, or
- finish in Quick Local mode

Do not hard-fail install completion with no fallback.

---

## 3) Preflight Requirements

- `openclaw` command available
- Node.js >= 22
- outbound access to `https://api.traderclaw.ai`
- gateway auth token available in OpenClaw config

Useful checks:

```bash
openclaw --version
openclaw gateway status
```

---

## 4) Install / Upgrade Contract

Authoritative plugin load path:

```bash
openclaw plugins install solana-traderclaw@1.0.18
openclaw gateway restart
```

Optional global CLI binary:

```bash
npm install -g solana-traderclaw@1.0.18
```

---

## 5) Setup Command Contract

### Quick Local lane

```bash
traderclaw setup \
  --signup \
  --url https://api.traderclaw.ai \
  --skip-gateway-registration
```

### Event-Driven lane

```bash
traderclaw setup \
  --signup \
  --url https://api.traderclaw.ai \
  --gateway-base-url <gatewayBaseUrl> \
  --gateway-token <gatewayToken>
```

API-key variant:

```bash
traderclaw setup \
  --api-key <apiKey> \
  --url https://api.traderclaw.ai \
  --gateway-base-url <gatewayBaseUrl> \
  --gateway-token <gatewayToken>
```

Fallback when command not in PATH:

```bash
node ~/.openclaw/extensions/solana-trader/bin/openclaw-trader.mjs setup ...
```

---

## 6) Gateway Exposure Guidance (Tailscale)

The orchestrator must reach `gatewayBaseUrl`.

### Baseline mode (tailnet bind)

```bash
tailscale up
openclaw config set gateway.mode local
openclaw config set gateway.tailscale.mode off
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Use:
- `gatewayBaseUrl = http://<tailscale-ip>:18789`

### Serve mode (HTTPS, only when account supports it)

```bash
tailscale up
openclaw config set gateway.mode local
openclaw config set gateway.bind loopback
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Use:
- `gatewayBaseUrl = https://<tailscale-hostname>`

If serve/cert fails, fallback to tailnet bind.

---

## 7) Secrets and Input Handling

Secrets:
- API key
- gateway token
- refresh token
- wallet private key

Requirements:
- mask in UI
- never print in telemetry/crash logs
- allow copy action with masked preview

**`TRADERCLAW_WALLET_PRIVATE_KEY` and the OpenClaw gateway:** External installers must document that this variable must be available to the **same process** that runs the gateway (e.g. systemd `EnvironmentFile`), not only in the user’s SSH session. Otherwise session refresh failures inside the gateway cannot complete wallet proof and **all** trading tools fail in Telegram/chat. Canonical user doc: [Installation troubleshooting](https://docs.traderclaw.ai/docs/installation#troubleshooting-session-expired-auth-errors-or-the-agent-logged-out).

Gateway token source:
- `~/.openclaw/openclaw.json` -> `gateway.auth.token`

---

## 8) Verification Contract

Installer can report "Done" only if selected lane checks pass.

### Common checks

```bash
openclaw plugins list
traderclaw status
```

### Event-Driven extra checks

```bash
curl -H "Authorization: Bearer <gatewayToken>" <gatewayBaseUrl>/health
```

Expected:

```json
{"ok":true,"status":"live"}
```

And:
- `solana_gateway_credentials_get()` reports `active: true`

---

## 9) Error Recovery Matrix

`tailscale: command not found`
- install tailscale, rerun `tailscale up`

`registration failed`
- confirm URL is reachable and not localhost/private-only from orchestrator perspective
- confirm token value
- confirm selected gateway mode is active

`Session: EXPIRED`

```bash
traderclaw login --url https://api.traderclaw.ai
```

Informational non-blocking warnings:
- plugin id mismatch warning
- uuid schema warning

---

## 10) Minimal End-to-End Script

```bash
openclaw plugins install solana-traderclaw@1.0.18
openclaw config set gateway.mode local
openclaw config set gateway.tailscale.mode off
openclaw config set gateway.bind tailnet
openclaw gateway restart

traderclaw setup --signup --url https://api.traderclaw.ai \
  --gateway-base-url <gatewayBaseUrl> \
  --gateway-token <gatewayToken>

traderclaw status
curl -H "Authorization: Bearer <gatewayToken>" <gatewayBaseUrl>/health
```

---

## 11) `activate_openclaw_plugin` / `writeConfigFile` (OpenClaw)

If the log shows `at Object.writeConfigFile (.../auth-profiles-...js)` during `openclaw plugins install`, that is OpenClaw **validating** `~/.openclaw/openclaw.json` before write — not a generic disk error.

**Required `orchestratorUrl`:** The plugin manifest marks `orchestratorUrl` as required. `openclaw plugins install` calls `writeConfigFile` **during** that command, so `plugins.entries.<id>.config.orchestratorUrl` must be present **before** install completes. The wizard seeds the plugin id (`solana-trader`), migrates stale entry keys from older releases (`traderclaw-v1`, `solana-traderclaw-v1`, `solana-traderclaw`), and keeps the canonical OpenClaw config entry at `plugins.entries.solana-trader`.

**`agents.defaults.heartbeat`:** OpenClaw’s schema requires `agents.defaults.heartbeat` (can be `{}`) whenever `agents.defaults` exists. The wizard sets this in the LLM step.

**`plugins.allow`:** OpenClaw validates every id in `plugins.allow` against the plugin registry, so the installer **must not** set it before `openclaw plugins install`. After `plugins enable`, the wizard removes stale TraderClaw ids from `plugins.allow` and adds the canonical plugin id (`solana-trader`) so users do not keep the `plugin not found: solana-traderclaw` warning around.

**Wizard logs:** ANSI color codes from the `openclaw` CLI are stripped before logs are shown in the browser UI.

