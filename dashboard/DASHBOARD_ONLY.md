# TraderClaw Dashboard (Frontend Only)

## Overview

`traderClawDashboard` is the standalone frontend dashboard for TraderClaw/OpenClaw operators.

It is a React + Vite web application that provides:

- live dashboard views
- positions and trade history pages
- settings and wallet setup flows
- websocket-driven UI updates

This directory is intentionally frontend-focused. The backend API/server runtime lives in the main platform service (`apps/openClawAPI`) and is not started from this folder.

## Scope and Boundary

This dashboard project:

- serves static frontend assets
- calls backend endpoints under `/api/*`
- opens websocket connections under `/ws`

This dashboard project does **not**:

- host the trading backend
- run API business logic
- manage database migrations for production backend services

## Runtime Model

In development, Vite proxies dashboard requests to the backend service configured by `OPENCLAW_API_URL`.

- `/api/*` -> backend API origin
- `/ws` -> backend websocket origin
- `/healthz` -> backend health endpoint

Default backend target is `http://localhost:5060` unless overridden.

## Prerequisites

- Node.js (project standard)
- npm
- Running OpenClaw backend reachable over HTTP/WS

## Local Development

From this folder:

```bash
cd traderClawDashboard
npm install
OPENCLAW_API_URL=http://localhost:5060 npx vite
```

Optional custom UI port:

```bash
DASHBOARD_PORT=5174 OPENCLAW_API_URL=http://localhost:5060 npx vite
```

## Production Build

```bash
cd traderClawDashboard
npm install
npm run build
```

Build output:

- `traderClawDashboard/dist/public`

Serve `dist/public` via your static hosting/CDN layer.

## Required Environment Variables

- `OPENCLAW_API_URL` (recommended): backend base URL used for API and websocket proxying
- `VITE_OPENCLAW_WS_URL` (optional but recommended for preview platforms): absolute websocket URL the dashboard should connect to (e.g. `wss://api.traderclaw.ai/ws`)
- `DASHBOARD_PORT` (optional): dev server port (default `5173`)
- `VITE_*` (optional): frontend-safe build-time values

## Deploy Notes (Vercel / Preview-first)

Recommended professional setup:

- enable Preview deployments on pull requests
- keep Production branch restricted to `main`
- use backend URL via environment configuration (do not hardcode)
- avoid placing backend secrets in frontend env vars

### Vercel environment variables

For WebSocket connectivity in Vercel previews, set:

- `VITE_OPENCLAW_WS_URL` = `wss://api.traderclaw.ai/ws`

Keep Production deploy controlled (manual promotion as needed).

### External repo governance (personal/private accounts)

If the frontend team is working from a personal/private GitHub account:

- Use classic **Branch Protection** on `main` (PR required + at least one review).
- Require dashboard-area changes to be reviewed (use `CODEOWNERS` in the external repo for `traderClawDashboard/**`-equivalent paths).
- Add required checks for the dashboard preview/build so merges are gated by real CI output.

## Troubleshooting

### UI loads but data fails

Most common cause: `OPENCLAW_API_URL` is wrong or backend is down.

Check:

1. backend is running
2. backend URL is reachable from browser/network
3. websocket endpoint is available

### CORS / proxy issues

Use Vite dev proxy mode (commands above) and validate backend CORS/WS settings if hosting frontend and backend on separate domains.

## Ownership

This file documents the dashboard-only contract for frontend contributors.
Backend behavior, auth policy, and trading logic are owned by the backend services in the main repository runtime.
