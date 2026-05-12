/** Vite: set `VITE_OPENCLAW_DASHBOARD_SOCKET_ENABLED=true` to expose Agent logs UI + WS `dashboard-logs` subscription. */
export function dashboardSocketFeatureEnabled(): boolean {
  const v = import.meta.env.VITE_OPENCLAW_DASHBOARD_SOCKET_ENABLED;
  return v === "true" || v === "1" || String(v).toLowerCase() === "yes";
}

/** Root `.env` (Vite `envDir`): `true`/`1`/`yes` → gated “Coming soon” for `/staking` + sidebar cue; omit or `false` for full staking UI. */
export function dashboardStakingComingSoon(): boolean {
  const v = import.meta.env.VITE_DASHBOARD_STAKING_COMING_SOON;
  return v === "true" || v === "1" || String(v).toLowerCase() === "yes";
}
