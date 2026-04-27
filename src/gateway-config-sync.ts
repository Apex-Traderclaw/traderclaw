/**
 * Normalize gateway base URL for comparison (orchestrator vs local openclaw.json).
 */
export function normalizeGatewayBaseUrl(url: string): string {
  return String(url || "").trim().replace(/\/+$/, "");
}

/**
 * True when local plugin config should be pushed to the orchestrator because it
 * differs from the active credential row. If the API omits gatewayToken, only
 * the URL is compared for drift.
 */
export function shouldSyncGatewayCredentials(
  localBaseUrl: string,
  localToken: string,
  active: Record<string, unknown> | null,
): boolean {
  const gbu = String(localBaseUrl || "").trim();
  const gt = String(localToken || "").trim();
  if (!gbu || !gt || !active) return false;
  const lUrl = normalizeGatewayBaseUrl(gbu);
  const rUrl = normalizeGatewayBaseUrl(String(active.gatewayBaseUrl ?? ""));
  if (lUrl !== rUrl) return true;
  if (typeof active.gatewayToken === "string") {
    return active.gatewayToken.trim() !== gt;
  }
  return false;
}
