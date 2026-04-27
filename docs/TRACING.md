# Kayba Tracing

TraderClaw ships with two layers of [Kayba](https://kayba.ai) observability — both wired up automatically by the setup CLI when you provide a Kayba API key:

| Layer | Plugin | Captures |
|---|---|---|
| **Agent turns** | `kayba-tracing` (`@kayba_ai/openclaw-tracing` on npm) | every full LLM turn — system prompt (once per session), user message, prompt + thinking + tool calls + reply, usage and cost |
| **Tool / HTTP spans** | `solana-trader` built-in | every tool invocation (95+ Solana tools) and every orchestrator HTTP request as a child span |

## One-step setup (recommended)

Pass your Kayba API key during `traderclaw setup` — both plugins get configured and the `kayba-tracing` plugin is installed/enabled in your gateway:

```sh
traderclaw setup --kayba-key kayba_ak_xxx
# or
KAYBA_API_KEY=kayba_ak_xxx traderclaw setup
```

If you skip the flag, the wizard prompts for it interactively (Enter to skip — tracing stays disabled, zero overhead).

## What this writes to `~/.openclaw/openclaw.json`

```json
{
  "plugins": {
    "allow": ["solana-trader", "kayba-tracing", "..."],
    "entries": {
      "solana-trader": {
        "config": {
          "kaybaApiKey": "kayba_ak_...",
          "kaybaFolder": "traderclaw"
        }
      },
      "kayba-tracing": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "apiKey": "kayba_ak_...",
          "folder": "traderclaw-agent"
        }
      }
    }
  }
}
```

The two folder names (`traderclaw` for tool spans, `traderclaw-agent` for full LLM turns) keep the views distinct in the Kayba dashboard. You can rename them after the fact in `openclaw.json`.

## Manual setup (if you skipped the wizard)

```sh
openclaw plugins install @kayba_ai/openclaw-tracing
openclaw plugins enable kayba-tracing
```

Then add the `kayba-tracing` entry shown above to your `openclaw.json` and restart the gateway.

## Configuration knobs (kayba-tracing)

| Field | Default | Purpose |
|---|---|---|
| `apiKey` | required | Your Kayba API key (`kayba_ak_...`) |
| `folder` | `"traderclaw-agent"` | Dashboard folder these traces land in |
| `captureSystemPrompt` | `true` | Capture the system prompt once per session |
| `captureHistory` | `"delta"` | `delta` (only new messages) / `full` (every turn) / `none` |
| `maxAttributeBytes` | `65536` | Per-attribute truncation cap |

## Disabling

Remove the `kaybaApiKey` field from `solana-trader.config` and either delete the `kayba-tracing` entry or set `"enabled": false`. Tracing has zero overhead when disabled.
