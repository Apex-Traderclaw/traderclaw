# TraderClaw Zero-to-Hero Install (v1.0.7)

This is the simplest path from a clean machine to a running agent.

---

## 0) What You Need

- Linux/macOS/Windows shell access
- Node.js 22+
- OpenClaw installed (if not, install it in Step 1)
- Internet access to `https://api.traderclaw.ai`

Required for event-driven mode:
- Tailscale installed + logged in

---

## 1) Install OpenClaw (if missing)

If `openclaw` is not installed yet:

```bash
npm install -g openclaw
openclaw --version
```

Official docs:
- https://docs.openclaw.ai

---

## 2) Install Plugin

Choose one:

```bash
npm install -g traderclaw-v1@1.0.7
traderclaw --version
```

or:

```bash
openclaw plugins install traderclaw-v1@1.0.7
```

Restart gateway:

```bash
openclaw gateway restart
```

---

## 3) Event-Driven Setup (Required)

This install is event-driven only. Quick/local lane is intentionally removed.

### 3.1 Expose gateway via tailnet

```bash
tailscale up
openclaw config set gateway.mode local
openclaw config set gateway.bind tailnet
openclaw config set gateway.tailscale.mode off
openclaw gateway restart
```

### 3.2 Get callback values

- `gatewayBaseUrl`: `http://<tailscale-ip>:18789`
- `gatewayToken`: value at `gateway.auth.token` in `~/.openclaw/openclaw.json`

### 3.3 Run setup with gateway registration

```bash
traderclaw setup --signup --url https://api.traderclaw.ai \
  --gateway-base-url <gatewayBaseUrl> \
  --gateway-token <gatewayToken>
```

---

## 4) Verify Installation

Run these:

```bash
openclaw plugins list
traderclaw status
openclaw gateway status
```

Event-driven health check:

```bash
curl -H "Authorization: Bearer <gatewayToken>" <gatewayBaseUrl>/health
```

Expected health:

```json
{"ok":true,"status":"live"}
```

---

## 5) Pair Telegram

If bot says access not configured:

```bash
openclaw pairing approve telegram <PAIRING_CODE>
```

---

## 6) Mandatory Startup Sequence

Send this prompt to your bot:

```text
Run mandatory startup sequence and report pass/fail for each:
1) solana_status
2) solana_gateway_credentials_get (set if missing)
3) solana_alpha_subscribe(agentId: "main")
4) solana_capital_status
5) solana_positions
6) solana_killswitch_status
```

---

## 7) If Balance Shows 0 SOL

- Confirm transfer went to the exact wallet address shown by bot.
- Confirm Solana mainnet (not devnet/testnet).
- Confirm transaction finalized.
- If needed:

```bash
traderclaw login --url https://api.traderclaw.ai
traderclaw status
openclaw gateway restart
```

---

## 8) Start Trading Policy Prompt

```text
Use alpha stream as primary source.
Only trade score >= 30.
Size 0.01 SOL.
SL -20% (sell 100%).
TP +50% (sell 100%).
Never trade if kill switch is enabled.
Before each execution send approval summary.
After execution report tx hash and monitor to TP/SL.
```

---

## 9) Quick Recovery Commands

```bash
traderclaw status
traderclaw login --url https://api.traderclaw.ai
openclaw gateway restart
openclaw logs --follow
```

