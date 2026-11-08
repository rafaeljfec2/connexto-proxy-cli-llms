# Host Browser Bridge

The **Host Browser Bridge** (`apps/host-browser-bridge`) is a native Windows background service that enables browser automation and session control from Linux environments (WSL2) and Docker containers.

It exposes an HTTP/CDP automation interface on port `4318`, allowing the gateway and provider packages to automate real Windows Google Chrome instances.

---

## 1. Why Host Browser Bridge?

When running the Connexto Proxy inside WSL2 or a Docker container, headless Chromium often faces major challenges:

1. **Cloudflare / Bot Detection**: Headless Linux Chromium instances lack native Windows hardware profiles and are frequently blocked or challenged by Cloudflare / Turnstile on `cursor.com` and `grok.com`.
2. **Interactive Social Login & CAPTCHA**: Docker containers and headless WSL environments cannot display a GUI window for user interaction when OAuth or Captchas are required.
3. **Session Cookie & Storage Persistence**: Storing authenticated sessions natively under the user's Windows profile ensures long-lived authentication across Docker container restarts.

---

## 2. Architecture & Networking

```
┌──────────────────────────────────────────────┐
│ Docker Container (Linux)                     │
│ connexto-proxy-cli-llms-gateway-1            │
│ Port 9090                                    │
│ BROWSER_BRIDGE_URL=                          │
│   http://host.docker.internal:4318           │
└──────────────────────┬───────────────────────┘
                       │ HTTP / CDP (Port 4318)
                       ▼
┌──────────────────────────────────────────────┐
│ Windows Host (Native OS)                     │
│ Host Browser Bridge (Node.js on win32)       │
│ Port 4318 (0.0.0.0:4318)                     │
│ Controls native Windows Chrome via CDP       │
│ Profile: %LOCALAPPDATA%\Connexto\...         │
└──────────────────────────────────────────────┘
```

### Docker Gateway Resolution

- Inside Docker containers, `extra_hosts: ["host.docker.internal:host-gateway"]` in `docker-compose.yml` resolves `host.docker.internal` to the Windows host gateway IP.
- The client library (`HostBrowserBridgeClient`) also reads `/proc/net/route` on Linux to automatically discover the default gateway if hostname resolution is unavailable.

---

## 3. Operational Modes

### A. Interactive Web Login (`headless: false`)

- **Trigger**: User clicks **"Login web"** in AI Hub (`POST /v1/providers/cursor/auth`).
- **Behavior**: Spawns a visible Google Chrome window on the Windows desktop pointing to the login page (`https://cursor.com/dashboard`).
- **Profile**: Persisted under `%LOCALAPPDATA%\Connexto\BrowserBridge\profiles\<principalId>`.
- **Completion**: Once the user completes login, the cookies and local storage remain stored in the Windows profile directory.

### B. Background Invisible Quota Collection (`headless: true`)

- **Trigger**: User clicks **"Atualizar"** in AI Hub, or background quota sync runs (`POST /v1/providers/cursor/usage/collect`).
- **Behavior**: Spawns Google Chrome in modern invisible headless mode (`--headless=new`) using the authenticated persistent profile.
- **Desktop Impact**: **Zero windows or popups** appear on the user's desktop.
- **Data Retrieved**:
  - `GET /dashboard/api/dashboard/v2/usage-status?scope=user` (Weekly budget and usage)
  - `POST /dashboard/api/dashboard/get-user-prepaid-billing` (Available prepaid credits and monthly spend)
  - `POST /dashboard/api/dashboard/get-user-analytics` (Historical agent requests)
- **Auto-Cleanup**: The temporary headless session is automatically closed and purged upon completion.

---

## 4. Starting the Bridge

### From WSL2 / Linux Terminal

Run the root script:

```bash
pnpm bridge
```

Or directly:

```bash
bash scripts/start-bridge-windows.sh
```

This script detects WSL2, resolves Windows paths via `wslpath -w`, and launches the bridge natively in Windows PowerShell in the background with detached I/O (`< /dev/null`) to avoid terminal stdin hangs.

### Verification

Check bridge health:

```bash
curl -s http://127.0.0.1:4318/health
```

Expected output:

```json
{
  "status": "ok",
  "activeSessions": 0,
  "platform": "win32",
  "uptime": 12.34
}
```

---

## 5. Session Lifecycle & Safety Features

1. **Idempotent Session Reuse**:
   - If an active session already exists for the same `principalId`, the bridge reuses it rather than launching redundant Chrome processes.
2. **Windows Process Exit Code 0 Handling**:
   - Chrome on Windows uses single-instance process routing. Launching a second Chrome process for an already open user directory delegates to the existing process and exits with code 0. The launcher handles this cleanly.
3. **Dead Session Purging**:
   - The bridge automatically purges disconnected or unresponsive CDP sessions before allocating new sessions, preventing the `maxConcurrentSessions` (default 5) limit from stalling.
4. **Token Security**:
   - Protected endpoints require `X-Bridge-Token: <BROWSER_BRIDGE_TOKEN>` matching the configured environment variable.
