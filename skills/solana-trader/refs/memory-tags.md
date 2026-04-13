# Memory Tag Vocabulary — Complete Reference

Use consistent tags to enable pattern detection, self-improvement, and strategy evolution.

## Trade Outcome Tags

Used with `solana_trade_review` and `solana_memory_write`.

| Tag | Purpose |
|---|---|
| `momentum_win` | Entered on momentum, exited profitably |
| `rug_escape` | Detected rug risk, exited early |
| `chop_loss` | Lost in sideways/choppy action |
| `late_entry` | Entered too late in the move |
| `over_size` | Position was too large for the setup |
| `bad_liquidity` | Liquidity insufficient for clean exit |
| `policy_denied` | Trade or exit denied by policy engine |
| `regime_shift` | Market regime changed during position |
| `thesis_correct` | Overall thesis was right |
| `thesis_wrong` | Overall thesis was wrong |
| `house_money_win` | Extracted initial capital, rode house money to profit |
| `house_money_stopped` | House money stopped out (still net positive) |
| `dead_money` | Exited flat position to redeploy capital |
| `fomo_entry` | Entered because of FOMO, not analysis |
| `meta_rotation` | Narrative/meta shift affected position |
| `anti_rug_save` | Anti-rug heuristics prevented bad entry |
| `serial_deployer` | Identified serial deployer pattern |

## Alpha-Specific Tags

| Tag | Purpose |
|---|---|
| `alpha_signal_win` | Entered based on alpha signal, profitable |
| `alpha_signal_loss` | Entered based on alpha signal, loss |
| `alpha_clustering_win` | Multiple independent sources AND winner |
| `alpha_stale_skip` | Skipped because signal too old or token moved |
| `alpha_source_quality` | Source reputation tracking journal |
| `alpha_source_win` | Specific source's call led to win |
| `alpha_source_loss` | Specific source's call led to loss |
| `alpha_risk_alert` | `kind: risk` signal on held position |
| `alpha_exit_signal` | `kind: exit` signal on held position |
| `alpha_front_run` | Detected front-running before alpha call |
| `alpha_skipped_regret` | Skipped call that would have been profitable |
| `alpha_skipped_correct` | Skipped call that didn't work out |
| `alpha_push_received` | Agent woken by push/webhook alpha signal |

## Self-Improvement Tags

Used by Steps 0, 5.5, 8.5, 9.

| Tag | Purpose |
|---|---|
| `pre_trade_rationale` | Decision journal BEFORE trade execution (Step 5.5) |
| `pre_exit_rationale` | Exit decision journal BEFORE sell (Step 5.5) |
| `learning_entry` | Structured learning log entry (Step 8.5) |
| `learning_entry_sizing` | Learning entry about position sizing errors |
| `learning_entry_timing` | Learning entry about entry/exit timing errors |
| `learning_entry_analysis` | Learning entry about analysis/red-flag errors |
| `learning_entry_model` | Learning entry about feature weight model blind spots |
| `learning_entry_alpha` | Learning entry about alpha signal processing errors |
| `learning_entry_risk` | Learning entry about risk management errors |
| `learning_entry_meta` | Learning entry about narrative/meta errors |
| `learning_entry_execution` | Learning entry about execution errors |
| `strategy_drift_warning` | Behavior misaligned with weights (Step 0) |
| `weight_velocity_freeze` | Weight oscillating, frozen for this cycle (Step 9 ADL) |
| `vfm_scorecard` | Value-First Modification scoring record (Step 9 VFM) |
| `pattern_detection` | Recurring pattern detection results (Step 9) |
| `named_pattern` | Recognized winning trade setup (Step 9) |
| `strategy_evolution` | Strategy evolution reasoning log (Step 9) |
| `discovery_filter_evolution` | Discovery filter parameter updates (Step 9) |

## Bitquery Recovery Tags

Used when Bitquery API calls fail and the agent applies recovery procedures.

| Tag | Purpose |
|---|---|
| `bitquery_fix_applied` | Successful Bitquery recovery — records error class, fix applied, and working query/variables |
| `bitquery_recovery_failed` | Recovery attempt failed — records error class, what was tried, and why it didn't work |
| `bitquery_template_broken` | Template identified as consistently broken — records template path, error pattern, suggested replacement |

## System Tags

| Tag | Purpose |
|---|---|
| `defense_mode` | Position Defense Mode activation journal |
| `defense_recovery` | Defense Mode auto-recovery log |
| `killswitch_activated` | Kill switch activation tracking |
| `killswitch_auto_recovery` | Kill switch auto-recovery log |
| `signal_convergence` | Independent discovery paths converged on same token |
| `source_reputation` | Source reputation recalculation results |
| `daily_report` | Daily performance report |
| `dead_money_sweep` | Dead money sweep cron results |
| `subscription_cleanup` | Subscription cleanup cron results |
| `meta_rotation` | Meta rotation analysis results |
| `deployer_profile` | Deployer profiling results |
| `regime_change` | Market regime transition log |
| `coordinated_shill_detected` | Coordinated shill campaign detected |
| `website_analyzed` | Website legitimacy analysis result |
| `alpha_source_model` | Personal alpha source trust model |
| `memory_trim` | Memory trim cron results |
