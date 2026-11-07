# Phase B — Cursor usage collector spike

## Versions

- `playwright-core`: 1.50.1 (see `packages/providers/cursor-usage/package.json`)
- Chromium: system package in `Dockerfile` (`CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`)

## Smoke (browser launch)

From repo root after `pnpm install`:

```bash
CHROMIUM_EXECUTABLE_PATH=${CHROMIUM_EXECUTABLE_PATH:-/usr/bin/chromium} \
  node spikes/cursor-usage-phase-b/chromium-smoke.mjs
```

## Network capture pattern

Register `page.waitForResponse` **before** `page.goto` (see `PlaywrightBrowserPool.waitForUsageJson`).

Override the URL predicate with `CURSOR_USAGE_RESPONSE_URL_PATTERN` once the real usage XHR is confirmed against a logged-in session.

## Interactive login (local dev)

The collector runs Playwright against `https://authenticator.cursor.sh/`. By default the browser is **headless** and cannot be used from the Hub interaction tab.

For local sign-in, set in the proxy `.env`:

```bash
CURSOR_USAGE_AUTH_HEADLESS=false
CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome
```

Restart the proxy, click **Login web** in the Hub, and complete OAuth in the **Chromium window** opened by the proxy (not in the placeholder browser tab).

### Usage data source: cursor.com (not grok.com)

**grok.com / x.ai is not viable** for headless or Playwright-driven collect: Cloudflare and bot signals block automated browsers even when a human clicks in the same window. Google OAuth there often redirects to `accounts.x.ai` and fails the same way.

Collect **must** use **cursor.com** session cookies and dashboard APIs (`/api/usage-summary`, etc.) after OAuth on `authenticator.cursor.sh` → `cursor.com/agents` or `/dashboard`.

Prefer **GitHub** or **email** sign-in over **Google**. Optional **CDP** (`CHROMIUM_CDP_ENDPOINT`) only helps login UX on the desktop; it does not make grok.com collect reliable.

Headed auth uses a persistent Chrome profile under `~/.connexto-proxy/cursor-usage-auth/<accountId>` (override with `CURSOR_USAGE_AUTH_USER_DATA_DIR`). After a successful login, later collects reuse cookies from that profile.

## Remote UI (noVNC)

Do not expose display ports publicly. Serve interaction only behind the AI Hub gateway with short-lived `interactionUrl` tokens.

## Decisive test checklist

1. Manual Cursor login in assisted session.
2. Close remote UI; collect still succeeds on the same `BrowserContext` / persisted `storageState`.
3. Second collect without re-login.
4. Proxy restart with `SESSION_STORAGE_DRIVER=filesystem` rehydrates session.
5. `POST /v1/runtime/sessions/clear` with `{"namespace":"cursor-usage"}` forces `authentication_required`.
