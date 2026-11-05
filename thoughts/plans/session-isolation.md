# Phase 4 — Session Isolation (AUD-05)

## Objective

Bind every stored Response and every provider session to the authenticated
principal. Knowing a Response ID must never grant access. Authorization happens
on the server for every read, mutation, cancel, delete, and chain operation.

## Current model (inspection summary)

- `createGatewayAuthMiddleware` (Phase 1) validates one shared
  `GATEWAY_API_TOKEN` header (`x-gateway-api-key`) and never records identity.
- `ResponseSessionStore` is a process-wide in-memory map keyed only by response
  ID; `StoredResponse` has no owner field (LRU, 512 entries).
- Lifecycle routes (`GET/DELETE /v1/responses/:id`, `GET /:id/input_items`,
  `POST /:id/cancel`) authorize by ID knowledge only (IDOR).
- `POST /v1/responses` accepts `previous_response_id` from any principal and
  reads its output items, input items, and SDK session key (context theft).
- `resolveSessionAffinity` passes raw client headers (`x-session-affinity`,
  `x-opencode-session`) as the provider `sessionId`; `CursorSessionManager` is
  keyed only by session ID, so one consumer can resume another consumer's agent
  by submitting their affinity ID (AUD-05).
- `POST /v1/responses/compact` and `POST /v1/responses/input_tokens` are
  stateless. `POST /v1/completions` uses a server-generated session ID.

## Isolation model

- **Principals.** Gateway credentials are the union of `GATEWAY_API_TOKEN`
  (existing, primary) and an additive comma-separated `GATEWAY_API_TOKENS`.
  Each distinct credential maps to a derived internal principal
  `gw_<sha256(token), 32 hex chars>`. The raw token is never stored, logged, or
  exposed. The trusted local-only mode (loopback, no tokens configured) maps to
  the fixed principal `local`.
- **Identity propagation.** The gateway auth middleware stamps
  `res.locals.principal` after successful authentication (and in local mode).
  Resource routes require a principal; absence is rejected with the existing
  Phase 1 unauthorized payload.
- **Ownership.** `StoredResponse.ownerPrincipal` is stamped at creation from
  the authenticated context only. Client input cannot influence it.
- **Authorization.** All individualized access goes through an ownership check
  that returns the same payload for unknown, foreign, and owner-less resources:
  `404 openAiErrorPayload("Response not found", "not_found")`.
- **Legacy resources.** Stored responses without an owner are not accessible to
  any principal (indistinguishable 404). The store is in-memory and transient
  across restarts, so no legitimate flow loses state.
- **Session scoping.** Client affinity headers are never forwarded raw. The
  effective provider session key is `ssk_<sha256(principal + "\n" + affinity)>`.
  Previously chained keys (`sdkSessionKey`) are already scoped and reused
  directly. Fresh server-generated IDs stay raw (unique per run, cannot
  collide). Priority order is preserved: affinity header > previous session key
  > fresh ID.
- **Out of scope.** RBAC, user hierarchy, organizations, rate limits,
  dependency changes, real Cursor calls, commits, Phase 5.

## Files planned

- `apps/api/src/utils/identity.ts` (new): principal derivation helpers.
- `apps/api/src/utils/gateway-auth.ts`: multi-credential check, principal stamp.
- `apps/api/src/config/env.ts`: `GATEWAY_API_TOKENS` validation.
- `apps/api/src/utils/session.ts`: principal-scoped session keys.
- `apps/api/src/routes/responses/lifecycle.ts`: ownership gates.
- `apps/api/src/routes/responses/create.ts`: ownership gate for
  `previous_response_id`, owner stamping, scoped affinity.
- `apps/api/src/routes/chat-completions.ts`: scoped affinity.
- `packages/compatibility/openai/src/response-store.ts`: `ownerPrincipal` field.
- `.env.example`, `docs/api.md`, `docs/security/SECURITY-AUDIT.md`.
- Tests: `tests/session-isolation.test.ts` (new), `tests/env.test.ts`,
  fixture updates in `tests/gateway-auth.test.ts` (owned seeds).

## Validation strategy

TDD red first. Then the offline suite (`--exclude tests/api.integration.test.ts
--exclude packages/providers/cursor/tests/cursor.integration.test.ts`),
typecheck, lint, format check, build, `git diff --check`. Independent review via
senior-code-review-judge before closure. No commits.
