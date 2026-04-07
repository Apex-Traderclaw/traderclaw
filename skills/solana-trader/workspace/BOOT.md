# Gateway Restart Recovery

_Runs automatically when the gateway restarts (crash, update, reboot). Keep this short — every token counts._

## Quick Health Check

1. **System status** — `solana_system_status()` to verify orchestrator connectivity.
2. **Kill switch** — `solana_killswitch_status()`. If active, halt and report immediately.
3. **Positions** — `solana_positions()` to load current open positions. Check for any needing urgent attention (SL/TP approaching, dead money).
4. **Wallet health** — `solana_capital_status()` to verify available capital.
5. **Alpha re-subscribe** — `solana_alpha_subscribe()` to restore alpha signal stream after restart.
6. **Context snapshot** — `solana_context_snapshot_read()` to restore world-view from last session.

## If Anything Fails

- Log the failure via `solana_daily_log` with `[BOOT_RECOVERY]` prefix.
- If orchestrator is unreachable, wait and retry once. If still down, post to user: "Gateway restarted but orchestrator is unreachable. Trading halted until connectivity restored."
- If kill switch is active, do NOT re-subscribe to alpha or resume scanning. Report the kill switch state to user.

## After Recovery

Post a brief status update: "Gateway restarted. Positions: <count>, Kill Switch: <status>, Orchestrator: OK"

Then proceed to your normal heartbeat cycle.
