# Cursor Usage Collector — Phase A audit (proxy + hub)

## Proxy (`connexto-proxy-cli-llms`)

- **Session persistence:** `SESSION_STORAGE_DRIVER` / `SESSION_STORAGE_PATH`; `FilesystemSessionStore`; pattern in `AntigravitySessionStore` (`packages/providers/antigravity/src/session-store.ts`).
- **Runtime clear:** `POST /v1/runtime/sessions/clear` with namespace (extend docs for `cursor-usage`).
- **Antigravity reference:** OAuth routes under `/v1/providers/antigravity/auth/*`; usage `GET /v1/providers/antigravity/usage`.
- **Gateway wiring:** `apps/api/src/services/gateway.ts` shares `sessionStore` across cursor SDK and antigravity providers.
- **Auth middleware:** `x-gateway-api-key`; payload logging must skip cursor usage/auth routes.

## AI Hub (`connexto-aihub`)

- **Proxy quota:** `AntigravityQuotaAdapter` → `GET .../providers/antigravity/usage`.
- **Cursor proxy usage:** `CursorUsageQuotaAdapter` → `POST .../providers/cursor/usage/collect` with hub account id; see `internal/providers/cursor_usage_quota.go`.
- **Proxy auth BFF:** `GetAntigravityProxyAuthStatus` / `StartAntigravityProxyAuth` in `internal/providers/antigravity_proxy_auth.go`; admin routes in `cmd/ai-hub/provider_admin.go`.
- **Cursor proxy auth BFF:** `StartCursorProxyAuth` / `GetCursorProxyAuthStatus` in `internal/providers/cursor_usage_proxy.go`; routes `POST /api/providers/{id}/proxy/cursor/auth/start`, `GET /api/providers/{id}/proxy/cursor/auth/{sessionId}`, `POST /api/providers/{id}/proxy/cursor/runtime/sessions/clear`.
- **Cursor provider:** `TypeCursor` with Connexto Proxy endpoint pattern; management key for hub→proxy.

## MVP implementation map

| Area | Location |
|------|----------|
| Browser usage package | `packages/providers/cursor-usage` |
| HTTP routes | `apps/api/src/routes/cursor-usage.ts` |
| Hub collect/auth client | `internal/providers/cursor_usage_proxy.go` |
| Spike smoke | `spikes/cursor-usage-phase-b/` |

## Manual acceptance (loopback proxy)

After web login on the same proxy as the provider endpoint (e.g. `pnpm dev` on port 9090):

```bash
GW="<gateway-api-key>"
ACCOUNT="<provider-id>"   # e.g. cursor
BASE="http://127.0.0.1:9090/v1"
curl -s "$BASE/providers/cursor/usage/session?accountId=$ACCOUNT" -H "X-Gateway-API-Key: $GW"
curl -s -X POST "$BASE/providers/cursor/usage/collect" \
  -H "Content-Type: application/json" -H "X-Gateway-API-Key: $GW" \
  -d "{\"accountId\":\"$ACCOUNT\"}"
```

Expected after login: session JSON `authenticated`; collect JSON `available` (or `session_expired` if cookies expired — not `authentication_required`).

Confirm on-disk file: `~/.connexto-proxy/sessions/cursor-usage/<accountId>.json` when `SESSION_STORAGE_PATH` points at home (default fallback on loopback when `/var/lib/...` is not writable).
