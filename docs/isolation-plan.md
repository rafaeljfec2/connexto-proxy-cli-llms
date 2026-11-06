# Antigravity Storage Isolation Plan

## Problem Statement

When the Connexto Proxy runs on the host system or inside WSL where Antigravity IDE is also running, both environments previously defaulted to reading and writing credentials under `$HOME/.gemini` (e.g., `oauth_creds.json`, `jetski-standalone-oauth-token`, `google_accounts.json`).

This created severe operational conflicts:
1. **Accidental IDE Logout**: Clicking "Encerrar sessão" in Connexto AI Hub or calling `POST /v1/runtime/sessions/clear` / `POST /v1/providers/antigravity/auth/logout` purged `$HOME/.gemini`, causing the host Antigravity IDE to immediately lose its authentication session ("Authentication expired. Your session has expired. Please log back in to continue.").
2. **Account Clobbering**: Performing an OAuth login in the proxy overwritten the user's IDE accounts and active refresh tokens.
3. **Usage Conflicts**: Usage quota queries for the proxy read credentials from the IDE session instead of an independent proxy session.

## Architecture & Isolation Solution

The Connexto Proxy establishes dedicated storage isolation for all Antigravity operations:

### 1. Configurable Storage Root
The proxy introduces the `ANTIGRAVITY_STORAGE_PATH` environment variable:
- If specified, the proxy uses this absolute directory path.
- If unspecified, the proxy defaults to `path.join(os.homedir(), ".connexto-proxy", "antigravity")`.

### 2. Service-Level Propagation
In `apps/api/src/services/gateway.ts`, `createGatewayServices` receives `ANTIGRAVITY_STORAGE_PATH` and injects it as `homeDir` to:
- `AntigravityAuthManager({ homeDir })`: writes OAuth tokens, operation tokens, and account info into `<storagePath>/.gemini` and `<storagePath>/.config/antigravity`.
- `AntigravityTokenResolver({ homeDir })`: resolves and refreshes tokens exclusively inside `<storagePath>/.gemini`.
- `AntigravityUsageService({ homeDir })`: queries quotas and consumption using credentials resolved from `<storagePath>`.
- `AntigravityProvider({ homeDir })`: forwards `HOME: storagePath` and `ANTIGRAVITY_APP_DATA_DIR: storagePath` to the spawned `agy` ACP process.

### 3. Isolated Purge & Logout
When `antigravityAuthManager.clearCredentials()` is invoked during `POST /v1/runtime/sessions/clear` or `POST /v1/providers/antigravity/auth/logout`, it deletes only the credential files within `this.homeDir` (`<storagePath>/.gemini/*`).

The host IDE's files at `$HOME/.gemini` remain completely untouched, keeping the developer's IDE logged in.

