/**
 * Run: npm run build && node scripts/gateway-config-sync-selftest.mjs
 */
import assert from "node:assert/strict";
import {
  normalizeGatewayBaseUrl,
  shouldSyncGatewayCredentials,
} from "../dist/src/gateway-config-sync.js";

assert.equal(normalizeGatewayBaseUrl(" https://x.com/foo/ "), "https://x.com/foo");
assert.equal(normalizeGatewayBaseUrl(""), "");

assert.equal(
  shouldSyncGatewayCredentials("https://a.com", "tok", { gatewayBaseUrl: "https://b.com", gatewayToken: "tok", active: true }),
  true,
);
assert.equal(
  shouldSyncGatewayCredentials("https://a.com/", "t1", { gatewayBaseUrl: "https://a.com", gatewayToken: "t1", active: true }),
  false,
);
assert.equal(
  shouldSyncGatewayCredentials("https://a.com", "t1", { gatewayBaseUrl: "https://a.com", gatewayToken: "t2", active: true }),
  true,
);
assert.equal(
  shouldSyncGatewayCredentials("https://a.com", "t1", { gatewayBaseUrl: "https://a.com", active: true }),
  false,
);
assert.equal(shouldSyncGatewayCredentials("", "t", { gatewayBaseUrl: "x", active: true }), false);

console.log("gateway-config-sync selftest: ok");
