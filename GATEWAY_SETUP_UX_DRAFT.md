# TraderClaw CLI UX Draft: Gateway Registration

## Purpose
Make `traderclaw setup` friendly for first-time users by avoiding hard blocks when gateway exposure is not ready, while still supporting full event-driven onboarding.

---

## 1) Wizard Section Title

`Gateway forwarding setup (for event-driven wakeups)`

---

## 2) Intro Copy

Use this exact text after wallet/session setup succeeds:

```text
Gateway forwarding lets TraderClaw wake your agent from external events (alpha streams, callbacks).

You can continue without this now:
- Trading works in local/manual mode
- Event-driven wakeups stay disabled until gateway credentials are registered
```

---

## 3) Required Decision Prompt

```text
How do you want to continue?

1) Quick start (recommended for first-time users)
   Skip gateway registration for now and finish setup immediately.

2) Enable event-driven wakeups now
   Register a public HTTPS Gateway URL + token.

Select [1/2]:
```

---

## 4) Path 1: Quick Start (Skip)

If user picks `1`:

```text
Skipping gateway credential registration.
Setup will continue in local/manual mode.

You can enable this later with:
  traderclaw gateway register --gateway-base-url <https-url> --gateway-token <token>
```

Then complete setup successfully.

---

## 5) Path 2: Guided Registration

If user picks `2`, run guided checks in this order.

### A) Auto-detect first

```text
Trying to auto-detect a reachable Gateway URL...
```

If success:

```text
Detected Gateway URL: <detected_url>
Use this URL? [Y/n]:
```

If failure:

```text
Could not auto-detect a public HTTPS Gateway URL.
No problem — paste one below or type 'back' to return to Quick start.
```

### B) URL prompt with validation

```text
Gateway base URL (must be public HTTPS, e.g. https://my-host.ts.net):
>
```

Validation messages:

- Empty:
  - `Gateway URL is required for registration.`
- Non-HTTPS:
  - `Invalid URL: must start with https://`
- Loopback/private/local:
  - `Invalid URL: localhost/127.0.0.1/private-only addresses are not reachable by the orchestrator.`

### C) Token prompt

```text
Gateway token (Bearer token from openclaw gateway auth):
>
```

If empty:

- `Gateway token cannot be empty.`

### D) Register + verify

```text
Registering gateway credentials...
```

Success:

```text
Gateway credentials registered and active.
Event-driven wakeups: ENABLED
```

Failure:

```text
Registration failed: <reason>

Choose next step:
1) Retry registration
2) Finish setup in Quick start mode (skip for now)
Select [1/2]:
```

---

## 6) Non-interactive CLI Contract

### Flags

- `--gateway-base-url <https-url>`
- `--gateway-token <token>`
- `--skip-gateway-registration`

### Behavior rules

- If both `--gateway-base-url` and `--gateway-token` are provided: attempt registration.
- If only one is provided: fail with a clear actionable error.
- If `--skip-gateway-registration` is set: do not prompt; finish setup.
- In interactive mode, if none provided: show decision prompt.
- Never block setup completion if user explicitly chooses skip.

---

## 7) Post-setup Summary Block

Use this exact final status:

```text
Setup complete.

Trading session: ACTIVE
Wallet: READY

Gateway forwarding: <ENABLED|SKIPPED>
- ENABLED: external event wakeups are active
- SKIPPED: local/manual mode only (enable later with traderclaw gateway register)
```

---

## 8) UX Intent

- Keep first run fast and successful.
- Keep advanced networking optional.
- Make event-driven setup discoverable and retryable.
- Ensure docs and CLI wording are aligned.
