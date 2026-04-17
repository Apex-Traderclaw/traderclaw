/** Vite: set `VITE_OPENCLAW_DASHBOARD_SOCKET_ENABLED=true` to expose Agent logs UI + WS `dashboard-logs` subscription. */
export function dashboardSocketFeatureEnabled(): boolean {
  const v = import.meta.env.VITE_OPENCLAW_DASHBOARD_SOCKET_ENABLED;
  return v === "true" || v === "1" || String(v).toLowerCase() === "yes";
}
