# TraderClaw Dashboard — Dashboard + Plugin

This directory now contains **two things only**:

1. **`client/`** — React/Vite/Tailwind dashboard webapp (separate process)
2. **`openclaw-plugin/`** — OpenClaw agent plugin (26 tools) connecting to the unified API

The orchestrator's server-side code (`server/`) has been **fully merged** into
`stealth/apps/openClawAPI/` and archived in `_server_archived/` for reference.

---

## Running the Dashboard

```bash
# From stealth/ directory:
npm run dev:dashboard
# or directly:
cd traderClawDashboard && OPENCLAW_API_URL=http://localhost:5060 npx vite

# Production build:
npm run build:dashboard
```

The dashboard proxies all `/api/*`, `/ws`, and `/healthz` requests to the
`OPENCLAW_API_URL` (default: `http://localhost:5060`).

**Dev port**: 5173 (or `DASHBOARD_PORT` env var)
**Domain**: `app.openclaw.xyz`

---

## Using the Plugin

The plugin connects directly to the unified OpenClaw API. Configure it with:

```json
{
  "apiUrl": "https://api.openclaw.xyz",
  "walletId": "<uuid from /api/wallet/create>",
  "apiKey": "<from /api/auth/signup or provisionApiKey.js>",
  "apiSecret": "<from signup>",
  "apiTimeout": 30000
}
```

Environment variables (alternative to inline config):
- `OPENCLAW_API_URL` — API base URL
- `OPENCLAW_API_KEY` — HMAC API key
- `OPENCLAW_API_SECRET` — HMAC API secret

---

## Architecture

```
OpenClaw Agent
     │
     ▼ (26 tools via openclaw-plugin)
stealth/apps/openClawAPI   ← unified backend (port 5060)
     │
     ├── HMAC auth + rate limits + usage metering
     ├── KMS wallets + live balance
     ├── Trading (Jito/Solana)
     ├── Bitquery market intel (single hop)
     ├── Memory / Journal
     ├── Strategy state (HARDENED / DEGEN mode)
     ├── Positions + Trade records
     ├── Risk engine (hard + soft denials)
     ├── Monthly entitlement plans
     └── WebSocket (/ws) → dashboard

traderClawDashboard/client  ← dashboard webapp (port 5173)
     └── reads data via proxied /api/* requests
```

---

## Archived

`_server_archived/` contains the original orchestrator server code before the
merge. It is **not loaded at runtime** and kept for reference only.
