// src/gateway-config-sync.ts
function normalizeGatewayBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}
function shouldSyncGatewayCredentials(localBaseUrl, localToken, active) {
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

export {
  normalizeGatewayBaseUrl,
  shouldSyncGatewayCredentials
};
