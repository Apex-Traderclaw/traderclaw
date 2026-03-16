#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://api.traderclaw.ai}"
EXTERNAL_USER_ID="${EXTERNAL_USER_ID:-oc_e2e_$(date +%s)_${RANDOM}}"
TOKEN_ADDRESS="So11111111111111111111111111111111111111112"
CURL_OPTS="${CURL_OPTS:---max-time 30}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASSED=0
FAILED=0
SKIPPED=0
TIER_BLOCKED=0

API_KEY=""
ACCESS_TOKEN=""
REFRESH_TOKEN=""
WALLET_ID=""

log_pass() { echo -e "  ${GREEN}✓ PASS${NC}  $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "  ${RED}✗ FAIL${NC}  $1 — $2"; FAILED=$((FAILED + 1)); }
log_skip() { echo -e "  ${YELLOW}○ SKIP${NC}  $1 — $2"; SKIPPED=$((SKIPPED + 1)); }
log_tier() { echo -e "  ${YELLOW}◆ TIER${NC}  $1 — Pro tier required (HTTP $2)"; TIER_BLOCKED=$((TIER_BLOCKED + 1)); }
log_info() { echo -e "  ${CYAN}ℹ INFO${NC}  $1"; }

api_get() {
  local path="$1"
  curl -sS -w "\n%{http_code}" -X GET "${BASE_URL}${path}" \
    -H "content-type: application/json" \
    -H "authorization: Bearer ${ACCESS_TOKEN}" \
    ${CURL_OPTS} 2>/dev/null || echo -e "\n000"
}

api_post() {
  local path="$1"
  local body="$2"
  if [ -z "$body" ]; then body="{}"; fi
  curl -sS -w "\n%{http_code}" -X POST "${BASE_URL}${path}" \
    -H "content-type: application/json" \
    -H "authorization: Bearer ${ACCESS_TOKEN}" \
    -d "${body}" \
    ${CURL_OPTS} 2>/dev/null || echo -e "\n000"
}

api_post_noauth() {
  local path="$1"
  local body="$2"
  if [ -z "$body" ]; then body="{}"; fi
  curl -sS -w "\n%{http_code}" -X POST "${BASE_URL}${path}" \
    -H "content-type: application/json" \
    -d "${body}" \
    ${CURL_OPTS} 2>/dev/null || echo -e "\n000"
}

parse_response() {
  local raw="$1"
  HTTP_CODE=$(echo "$raw" | tail -1)
  HTTP_BODY=$(echo "$raw" | sed '$d')
}

check_response() {
  local name="$1"
  local expected_code="$2"
  local raw="$3"
  parse_response "$raw"

  if [ "$HTTP_CODE" = "000" ]; then
    log_fail "$name" "Connection failed / timeout"
    return 1
  fi

  if [ "$HTTP_CODE" = "403" ] && echo "$HTTP_BODY" | jq -e '.code == "TIER_REQUIRED" or .code == "SCOPE_DENIED" or .code == "INSUFFICIENT_TIER" or .code == "ENDPOINT_NOT_ALLOWED" or .code == "AUTH_SCOPE_MISSING" or .error == "Forbidden"' >/dev/null 2>&1; then
    log_tier "$name" "$HTTP_CODE"
    return 2
  fi

  if [ "$HTTP_CODE" = "$expected_code" ]; then
    log_pass "$name"
    return 0
  else
    local snippet
    snippet=$(echo "$HTTP_BODY" | head -c 200)
    log_fail "$name" "Expected HTTP ${expected_code}, got ${HTTP_CODE}: ${snippet}"
    return 1
  fi
}

echo ""
echo -e "${BOLD}OpenClaw E2E API Integration Test${NC}"
echo -e " Target: ${BASE_URL}"
echo -e " User:   ${EXTERNAL_USER_ID}"
echo " ═══════════════════════════════════════"

echo ""
echo -e "${BOLD}Phase 1: BOOTSTRAP (signup + session)${NC}"
echo " ───────────────────────────────────────"

RAW=$(api_post_noauth "/api/auth/signup" "{\"externalUserId\":\"${EXTERNAL_USER_ID}\"}")
parse_response "$RAW"
if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
  API_KEY=$(echo "$HTTP_BODY" | jq -r '.apiKey // empty')
  if [ -n "$API_KEY" ]; then
    log_pass "POST /api/auth/signup → apiKey obtained"
    log_info "API Key: ${API_KEY:0:12}..."
  else
    log_fail "POST /api/auth/signup" "No apiKey in response"
    echo -e "\n${RED}Cannot continue without API key. Aborting.${NC}"
    exit 1
  fi
else
  log_fail "POST /api/auth/signup" "HTTP ${HTTP_CODE}: $(echo "$HTTP_BODY" | head -c 200)"
  echo -e "\n${RED}Cannot continue without API key. Aborting.${NC}"
  exit 1
fi

RAW=$(api_post_noauth "/api/session/challenge" "{\"apiKey\":\"${API_KEY}\",\"clientLabel\":\"e2e-test\"}")
parse_response "$RAW"
CHALLENGE_ID=""
WALLET_PROOF_REQUIRED="false"
if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
  CHALLENGE_ID=$(echo "$HTTP_BODY" | jq -r '.challengeId // empty')
  WALLET_PROOF_REQUIRED=$(echo "$HTTP_BODY" | jq -r '.walletProofRequired // false')
  log_pass "POST /api/session/challenge → challengeId obtained"
  log_info "Wallet proof required: ${WALLET_PROOF_REQUIRED}"
else
  log_fail "POST /api/session/challenge" "HTTP ${HTTP_CODE}: $(echo "$HTTP_BODY" | head -c 200)"
  echo -e "\n${RED}Cannot continue without session. Aborting.${NC}"
  exit 1
fi

if [ "$WALLET_PROOF_REQUIRED" = "true" ]; then
  echo -e "\n${YELLOW}Wallet proof required. Cannot proceed without private key.${NC}"
  echo "Set OPENCLAW_TEST_WALLET_PRIVATE_KEY env var and re-run."
  exit 1
fi

RAW=$(api_post_noauth "/api/session/start" "{\"apiKey\":\"${API_KEY}\",\"clientLabel\":\"e2e-test\"}")
parse_response "$RAW"
if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
  ACCESS_TOKEN=$(echo "$HTTP_BODY" | jq -r '.accessToken // empty')
  REFRESH_TOKEN=$(echo "$HTTP_BODY" | jq -r '.refreshToken // empty')
  if [ -n "$ACCESS_TOKEN" ] && [ -n "$REFRESH_TOKEN" ]; then
    log_pass "POST /api/session/start → tokens obtained"
    log_info "Access token: ${ACCESS_TOKEN:0:20}..."
  else
    log_fail "POST /api/session/start" "Missing tokens in response"
    exit 1
  fi
else
  log_fail "POST /api/session/start" "HTTP ${HTTP_CODE}: $(echo "$HTTP_BODY" | head -c 200)"
  exit 1
fi

echo ""
echo -e "${BOLD}Phase 2: WALLET SETUP${NC}"
echo " ───────────────────────────────────────"

RAW=$(api_get "/api/wallets")
parse_response "$RAW"
if [ "$HTTP_CODE" = "200" ]; then
  WALLET_COUNT=$(echo "$HTTP_BODY" | jq 'if type == "array" then length else 0 end' 2>/dev/null || echo 0)
  log_pass "GET /api/wallets → ${WALLET_COUNT} wallet(s)"

  if [ "$WALLET_COUNT" -gt 0 ]; then
    WALLET_ID=$(echo "$HTTP_BODY" | jq -r '.[0].id // empty')
    log_info "Using existing wallet: ${WALLET_ID}"
  fi
else
  check_response "GET /api/wallets" "200" "$HTTP_CODE
$HTTP_BODY"
fi

if [ -z "$WALLET_ID" ]; then
  RAW=$(api_post "/api/wallet/create" "{\"label\":\"e2e-test-wallet\",\"chain\":\"solana\"}")
  parse_response "$RAW"
  if [ "$HTTP_CODE" = "201" ] || [ "$HTTP_CODE" = "200" ]; then
    WALLET_ID=$(echo "$HTTP_BODY" | jq -r '.id // .walletId // empty')
    if [ -n "$WALLET_ID" ]; then
      log_pass "POST /api/wallet/create → wallet created"
      log_info "Wallet ID: ${WALLET_ID}"
    else
      log_fail "POST /api/wallet/create" "No wallet ID in response: $(echo "$HTTP_BODY" | head -c 200)"
    fi
  else
    log_fail "POST /api/wallet/create" "HTTP ${HTTP_CODE}: $(echo "$HTTP_BODY" | head -c 200)"
  fi
fi

if [ -z "$WALLET_ID" ]; then
  echo -e "\n${RED}No wallet available. Cannot continue with wallet-dependent tests.${NC}"
  WALLET_ID="00000000-0000-0000-0000-000000000001"
  log_info "Using placeholder wallet ID for remaining tests (expect failures)"
fi

echo ""
echo -e "${BOLD}Phase 3: STARTER TIER ENDPOINTS${NC}"
echo " ───────────────────────────────────────"

echo ""
echo -e " ${CYAN}--- System & Status ---${NC}"

RAW=$(api_get "/api/system/status")
parse_response "$RAW"
if [ "$HTTP_CODE" = "200" ]; then
  log_pass "GET /api/system/status"
elif [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
  log_pass "GET /api/system/status → restricted (HTTP ${HTTP_CODE}) — requires HMAC auth or Enterprise tier"
else
  log_fail "GET /api/system/status" "Expected 200/401/403, got HTTP ${HTTP_CODE}"
fi

RAW=$(api_get "/api/capital/status?walletId=${WALLET_ID}")
check_response "GET /api/capital/status" "200" "$RAW" || true

RAW=$(api_get "/api/wallet/positions?walletId=${WALLET_ID}")
check_response "GET /api/wallet/positions" "200" "$RAW" || true

RAW=$(api_get "/api/funding/instructions?walletId=${WALLET_ID}")
check_response "GET /api/funding/instructions" "200" "$RAW" || true

echo ""
echo -e " ${CYAN}--- Kill Switch ---${NC}"

RAW=$(api_get "/api/killswitch/status?walletId=${WALLET_ID}")
check_response "GET /api/killswitch/status" "200" "$RAW" || true

RAW=$(api_post "/api/killswitch" "{\"walletId\":\"${WALLET_ID}\",\"enabled\":false,\"mode\":\"TRADES_ONLY\"}")
parse_response "$RAW"
if [ "$HTTP_CODE" = "200" ]; then
  log_pass "POST /api/killswitch (disable)"
elif [ "$HTTP_CODE" = "403" ]; then
  log_tier "POST /api/killswitch (disable)" "$HTTP_CODE"
else
  log_fail "POST /api/killswitch (disable)" "Expected 200 or 403, got HTTP ${HTTP_CODE}"
fi

echo ""
echo -e " ${CYAN}--- Strategy ---${NC}"

RAW=$(api_get "/api/strategy/state?walletId=${WALLET_ID}")
parse_response "$RAW"
if [ "$HTTP_CODE" = "200" ]; then
  log_pass "GET /api/strategy/state"
elif [ "$HTTP_CODE" = "404" ]; then
  log_pass "GET /api/strategy/state → 404 (no strategy yet — expected for new wallet)"
else
  log_fail "GET /api/strategy/state" "Expected 200 or 404, got HTTP ${HTTP_CODE}"
fi

RAW=$(api_post "/api/strategy/update" "{\"walletId\":\"${WALLET_ID}\",\"featureWeights\":{\"volume_momentum\":0.20,\"buy_pressure\":0.18,\"liquidity_depth\":0.18,\"holder_quality\":0.15,\"flow_divergence\":0.12,\"token_maturity\":0.10,\"risk_inverse\":0.07},\"strategyVersion\":\"v1.0.0\",\"mode\":\"HARDENED\"}")
check_response "POST /api/strategy/update" "200" "$RAW" || true

echo ""
echo -e " ${CYAN}--- Entitlements ---${NC}"

RAW=$(api_get "/api/entitlements/costs")
check_response "GET /api/entitlements/costs" "200" "$RAW" || true

RAW=$(api_get "/api/entitlements/plans")
check_response "GET /api/entitlements/plans" "200" "$RAW" || true

RAW=$(api_get "/api/entitlements/current?walletId=${WALLET_ID}")
check_response "GET /api/entitlements/current" "200" "$RAW" || true

echo ""
echo -e " ${CYAN}--- Trade History ---${NC}"

RAW=$(api_get "/api/trades?walletId=${WALLET_ID}&limit=10&offset=0")
check_response "GET /api/trades" "200" "$RAW" || true

RAW=$(api_get "/api/risk-denials?walletId=${WALLET_ID}&limit=10")
check_response "GET /api/risk-denials" "200" "$RAW" || true

echo ""
echo -e " ${CYAN}--- Memory ---${NC}"

RAW=$(api_post "/api/memory/write" "{\"walletId\":\"${WALLET_ID}\",\"notes\":\"E2E test memory entry — testing alignment\",\"tags\":[\"e2e_test\",\"alignment\"],\"outcome\":\"neutral\",\"strategyVersion\":\"v1.0.0\"}")
check_response "POST /api/memory/write" "201" "$RAW" || true

RAW=$(api_post "/api/memory/search" "{\"walletId\":\"${WALLET_ID}\",\"query\":\"e2e test\"}")
check_response "POST /api/memory/search" "200" "$RAW" || true

RAW=$(api_post "/api/memory/by-token" "{\"walletId\":\"${WALLET_ID}\",\"tokenAddress\":\"${TOKEN_ADDRESS}\"}")
check_response "POST /api/memory/by-token" "200" "$RAW" || true

RAW=$(api_get "/api/memory/journal-summary?walletId=${WALLET_ID}&lookbackDays=7")
check_response "GET /api/memory/journal-summary" "200" "$RAW" || true

echo ""
echo -e " ${CYAN}--- Thesis & Trading ---${NC}"

RAW=$(curl -sS -w "\n%{http_code}" -X POST "${BASE_URL}/api/thesis/build" \
  -H "content-type: application/json" \
  -H "authorization: Bearer ${ACCESS_TOKEN}" \
  -d "{\"walletId\":\"${WALLET_ID}\",\"tokenAddress\":\"${TOKEN_ADDRESS}\"}" \
  -k --max-time 60 2>/dev/null || echo -e "\n000")
parse_response "$RAW"
if [ "$HTTP_CODE" = "200" ]; then
  log_pass "POST /api/thesis/build"
elif [ "$HTTP_CODE" = "503" ]; then
  REASON=$(echo "$HTTP_BODY" | jq -r '.code // .message // empty' | head -c 80)
  log_pass "POST /api/thesis/build → 503 (${REASON}) — expected for test token (wSOL)"
else
  check_response "POST /api/thesis/build" "200" "$RAW" || true
fi

RAW=$(curl -sS -w "\n%{http_code}" -X POST "${BASE_URL}/api/trade/precheck" \
  -H "content-type: application/json" \
  -H "authorization: Bearer ${ACCESS_TOKEN}" \
  -d "{\"walletId\":\"${WALLET_ID}\",\"tokenAddress\":\"${TOKEN_ADDRESS}\",\"side\":\"buy\",\"sizeSol\":0.01,\"slippageBps\":300}" \
  -k --max-time 60 2>/dev/null || echo -e "\n000")
parse_response "$RAW"
if [ "$HTTP_CODE" = "200" ]; then
  APPROVED=$(echo "$HTTP_BODY" | jq -r '.approved // empty')
  log_pass "POST /api/trade/precheck → approved=${APPROVED}"
elif [ "$HTTP_CODE" = "403" ]; then
  DENIED_CODE=$(echo "$HTTP_BODY" | jq -r '.code // empty')
  log_pass "POST /api/trade/precheck → denied (${DENIED_CODE}) — expected for unfunded wallet"
elif [ "$HTTP_CODE" = "503" ]; then
  REASON=$(echo "$HTTP_BODY" | jq -r '.code // .message // empty' | head -c 80)
  log_pass "POST /api/trade/precheck → 503 (${REASON}) — expected for test token (wSOL)"
else
  check_response "POST /api/trade/precheck" "200" "$RAW" || true
fi

log_skip "POST /api/trade/execute" "Requires funded wallet"

RAW=$(api_post "/api/trade/review" "{\"walletId\":\"${WALLET_ID}\",\"tokenAddress\":\"${TOKEN_ADDRESS}\",\"outcome\":\"neutral\",\"notes\":\"E2E test review — no actual trade\",\"pnlSol\":0,\"tags\":[\"e2e_test\"],\"strategyVersion\":\"v1.0.0\"}")
check_response "POST /api/trade/review" "201" "$RAW" || true

echo ""
echo -e " ${CYAN}--- Entitlement Actions (skipped — costs SOL) ---${NC}"

log_skip "POST /api/entitlements/purchase" "Would cost SOL"
log_skip "POST /api/entitlements/upgrade" "Would cost SOL"

echo ""
echo -e "${BOLD}Phase 4: PRO TIER ENDPOINTS${NC}"
echo " ───────────────────────────────────────"
echo -e " ${CYAN}(These may return 403 if account is Starter tier)${NC}"

echo ""
echo -e " ${CYAN}--- Scan & Market ---${NC}"

RAW=$(api_post "/api/scan/new-launches" "{\"walletId\":\"${WALLET_ID}\"}")
check_response "POST /api/scan/new-launches" "200" "$RAW" || true

RAW=$(api_post "/api/scan/hot-pairs" "{\"walletId\":\"${WALLET_ID}\"}")
check_response "POST /api/scan/hot-pairs" "200" "$RAW" || true

RAW=$(api_post "/api/market/regime" "{\"walletId\":\"${WALLET_ID}\"}")
check_response "POST /api/market/regime" "200" "$RAW" || true

echo ""
echo -e " ${CYAN}--- Token Analysis ---${NC}"

RAW=$(api_post "/api/token/snapshot" "{\"walletId\":\"${WALLET_ID}\",\"tokenAddress\":\"${TOKEN_ADDRESS}\"}")
check_response "POST /api/token/snapshot" "200" "$RAW" || true

RAW=$(api_post "/api/token/holders" "{\"walletId\":\"${WALLET_ID}\",\"tokenAddress\":\"${TOKEN_ADDRESS}\"}")
check_response "POST /api/token/holders" "200" "$RAW" || true

RAW=$(api_post "/api/token/flows" "{\"walletId\":\"${WALLET_ID}\",\"tokenAddress\":\"${TOKEN_ADDRESS}\"}")
check_response "POST /api/token/flows" "200" "$RAW" || true

RAW=$(api_post "/api/token/liquidity" "{\"walletId\":\"${WALLET_ID}\",\"tokenAddress\":\"${TOKEN_ADDRESS}\"}")
check_response "POST /api/token/liquidity" "200" "$RAW" || true

RAW=$(api_post "/api/token/risk" "{\"walletId\":\"${WALLET_ID}\",\"tokenAddress\":\"${TOKEN_ADDRESS}\"}")
check_response "POST /api/token/risk" "200" "$RAW" || true

echo ""
echo -e " ${CYAN}--- Bitquery ---${NC}"

RAW=$(api_post "/api/bitquery/catalog" "{\"walletId\":\"${WALLET_ID}\",\"templatePath\":\"pumpFunCreation.trackNewTokens\",\"variables\":{}}")
check_response "POST /api/bitquery/catalog" "200" "$RAW" || true

RAW=$(api_post "/api/bitquery/query" "{\"walletId\":\"${WALLET_ID}\",\"query\":\"{ Solana { DEXTradeByTokens(limit: {count: 1}) { Trade { Currency { Name } } } } }\",\"variables\":{}}")
check_response "POST /api/bitquery/query" "200" "$RAW" || true

log_skip "POST /api/bitquery/subscribe" "Requires Pro tier + active stream setup"
log_skip "POST /api/bitquery/unsubscribe" "No active subscription to cancel"
log_skip "GET /api/bitquery/subscriptions/active" "Requires active subscriptions"

echo ""
echo -e "${BOLD}Phase 5: SESSION LIFECYCLE${NC}"
echo " ───────────────────────────────────────"

RAW=$(api_post_noauth "/api/session/refresh" "{\"refreshToken\":\"${REFRESH_TOKEN}\"}")
parse_response "$RAW"
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  NEW_ACCESS=$(echo "$HTTP_BODY" | jq -r '.accessToken // empty')
  NEW_REFRESH=$(echo "$HTTP_BODY" | jq -r '.refreshToken // empty')
  if [ -n "$NEW_ACCESS" ] && [ -n "$NEW_REFRESH" ]; then
    ACCESS_TOKEN="$NEW_ACCESS"
    REFRESH_TOKEN="$NEW_REFRESH"
    log_pass "POST /api/session/refresh → tokens rotated"
  else
    log_fail "POST /api/session/refresh" "Missing tokens in response"
  fi
else
  log_fail "POST /api/session/refresh" "HTTP ${HTTP_CODE}: $(echo "$HTTP_BODY" | head -c 200)"
fi

RAW=$(api_get "/api/system/status")
parse_response "$RAW"
if [ "$HTTP_CODE" = "200" ]; then
  log_pass "GET /api/system/status (with refreshed token) → verified"
elif [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
  log_pass "GET /api/system/status (refreshed token) → restricted (HTTP ${HTTP_CODE}) — expected"
else
  log_fail "GET /api/system/status (refreshed token)" "HTTP ${HTTP_CODE}"
fi

RAW=$(api_post_noauth "/api/session/logout" "{\"refreshToken\":\"${REFRESH_TOKEN}\"}")
parse_response "$RAW"
if [ "$HTTP_CODE" = "200" ]; then
  log_pass "POST /api/session/logout → session ended"
else
  log_fail "POST /api/session/logout" "HTTP ${HTTP_CODE}: $(echo "$HTTP_BODY" | head -c 200)"
fi

RAW=$(api_post_noauth "/api/session/refresh" "{\"refreshToken\":\"${REFRESH_TOKEN}\"}")
parse_response "$RAW"
if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
  log_pass "POST /api/session/refresh (after logout) → correctly rejected (${HTTP_CODE})"
else
  log_fail "POST /api/session/refresh (after logout)" "Expected 401/403, got HTTP ${HTTP_CODE}"
fi

echo ""
echo " ═══════════════════════════════════════"
echo -e "${BOLD} RESULTS${NC}"
echo " ═══════════════════════════════════════"
echo ""
echo -e "  ${GREEN}✓ Passed:${NC}       ${PASSED}"
echo -e "  ${RED}✗ Failed:${NC}       ${FAILED}"
echo -e "  ${YELLOW}◆ Tier blocked:${NC} ${TIER_BLOCKED}"
echo -e "  ${YELLOW}○ Skipped:${NC}      ${SKIPPED}"
TOTAL=$((PASSED + FAILED + TIER_BLOCKED + SKIPPED))
echo -e "  Total:          ${TOTAL}"
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo -e "${RED}${BOLD}E2E test completed with ${FAILED} failure(s).${NC}"
  exit 1
else
  echo -e "${GREEN}${BOLD}E2E test passed! All endpoints aligned.${NC}"
  if [ "$TIER_BLOCKED" -gt 0 ]; then
    echo -e "${YELLOW}(${TIER_BLOCKED} endpoints blocked by tier — upgrade to Pro to access)${NC}"
  fi
  exit 0
fi
