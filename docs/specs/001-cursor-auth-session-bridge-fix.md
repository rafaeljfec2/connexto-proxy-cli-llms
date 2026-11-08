# SPEC: Cursor Authentication and Session Persistence Fix

- **Status**: Approved
- **Work Item / Trigger**: User reported web login immediately marked as "expired" and status check failing in Cursor provider modal.
- **Classification**: Bugfix / Reliability

---

## 1. Context & Problem Statement

When the user clicks "Login web" or "Ver status" for the Cursor provider in AI Hub with Docker Gateway running:
1. **Immediate `expired` status**:
   - The AI Hub calls `POST /v1/providers/cursor/auth`.
   - `CursorUsageService.startAuth` creates a random UUID `sessionId` and requests session creation on the Host Browser Bridge.
   - In `apps/host-browser-bridge/src/session-manager.ts`, when an active session for the same `principalId` (`cursor`) exists, `createSession` returns the existing session (with its original ID) instead of associating the new `sessionId`.
   - `CursorUsageService.startAuth` discards the returned session and registers the new UUID in `authOperations`.
   - Polling queries the new UUID via `GET /v1/providers/cursor/auth/:sessionId`. The bridge returns 404 (`BridgeSessionNotFoundError`) because it only has the old session ID.
   - `CursorUsageService.getAuthOperationStatus` catches `BridgeSessionNotFoundError` and immediately sets `operation.status = "expired"`, despite a 30-minute expiration timestamp.
2. **Persistence failure causing `authentication_required` in "Ver status"**:
   - `docker-compose.yml` maps `SESSION_STORAGE_PATH: ${SESSION_STORAGE_PATH:-/var/lib/connexto-proxy/sessions}`.
   - The root `.env` configures `SESSION_STORAGE_PATH=/home/rafael/.connexto-proxy/sessions` for local host/WSL execution.
   - Docker Compose interpolates this variable into the container.
   - Inside the container, user `node` (uid 1000) cannot access or create `/home/rafael`, failing with `mkdir: Permission denied`.
   - `session-store.ts` fails to write, deletes the in-memory record, and suppresses the error, keeping `getCollectSessionStatus` stuck on `authentication_required`.

---

## 2. Requirements & Scope

1. **Host Browser Bridge Session Management**:
   - When `createSession` is invoked with a specific `id` for an existing `principalId`:
     - If the existing session is already running with a different ID, close the old session gracefully and launch/bind the new session with the requested ID.
2. **Cursor Usage Service Auth Operation**:
   - In `startAuth`, ensure the effective session ID used in `authOperations` matches the session created/returned by the bridge.
   - If the bridge session is already authenticated, immediately reflect `authenticated` status in the operation and persist the session.
   - Ensure `getAuthOperationStatus` handles pending sessions without prematurely expiring on transient bridge lookup delays.
3. **Docker Compose Session Persistence Path**:
   - Enforce container-internal path `/var/lib/connexto-proxy/sessions` in `docker-compose.yml` so host `.env` overrides cannot leak invalid host paths into the container.
4. **Runtime Session Cleanup**:
   - When clearing runtime sessions (`/v1/runtime/sessions/clear` or provider modal "Limpar sessão"), ensure the Host Browser Bridge session for that principal is also terminated.

---

## 3. Acceptance Criteria

- [ ] AC-1: `createSession` in Host Browser Bridge terminates previous session if a new session ID is requested for the same principal, returning a session with the requested ID.
- [ ] AC-2: `startAuth` in `CursorUsageService` tracks the effective session ID returned by the bridge.
- [ ] AC-3: Polling `GET /v1/providers/cursor/auth/:sessionId` returns `authentication_pending` or `authenticated` (not false `expired` while process is active).
- [ ] AC-4: `SESSION_STORAGE_PATH` in `docker-compose.yml` is pinned to `/var/lib/connexto-proxy/sessions`, allowing successful read/write within the container.
- [ ] AC-5: `getCollectSessionStatus` correctly resolves authenticated sessions after collection.
- [ ] AC-6: All unit and integration tests pass without regression.

---

## 4. Evidence Plan

- **Claim**: The Cursor web login operation will no longer expire immediately upon creation and will correctly track the bridge session. Session persistence will operate cleanly inside the Docker container.
- **Success Type**: Automated tests pass (`vitest run`) + live container verification.
- **Evidence Path**: Unit tests in `host-browser-bridge` and `cursor-usage`, followed by Docker gateway restart and verification via `curl`.

