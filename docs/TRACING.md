# Kayba Tracing

Every tool call can be automatically traced and sent to your [Kayba](https://kayba.ai) dashboard.

## Setup

1. Get an API key from your Kayba dashboard.

2. Add it to your plugin config in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "solana-trader": {
        "config": {
          "kaybaApiKey": "kayba_ak_...",
          "kaybaFolder": "traderclaw"
        }
      }
    }
  }
}
```

Alternatively, set the `KAYBA_API_KEY` environment variable — the plugin picks it up automatically.

3. `kaybaFolder` is optional (defaults to `"traderclaw"`). It controls how traces are grouped in the dashboard.

## What gets traced

- **Every tool call** (all 95+ tools) — name, parameters, result or error, duration
- **Every orchestrator HTTP request** as a child span — method, path, status

No traces are sent when no API key is configured. There is zero overhead when tracing is disabled.
