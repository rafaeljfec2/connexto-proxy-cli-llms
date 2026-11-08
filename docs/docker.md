# Docker

Run the gateway in a container using **Node.js 24.22.1** (`bookworm-slim`).

## Requirements

- Docker Engine with Compose v2
- Repository root `.env` (copy from `.env.example`) with:
  - **`CURSOR_API_KEY`** — provider credential
  - **`GATEWAY_API_TOKEN`** — non-empty gateway credential (required because the container binds **`HOST=0.0.0.0`**). An empty `GATEWAY_API_TOKEN=` line is treated as unset and the process will exit.

Compose loads `.env` via `env_file`, then applies overrides below. **`environment` wins over `env_file`** for the same keys.

| Override                                                           | Reason                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `HOST=0.0.0.0`                                                     | Listen inside the container network namespace                                 |
| `LOG_FORMAT=json`                                                  | Production image has no `pino-pretty`                                         |
| `GATEWAY_API_TOKEN=${GATEWAY_API_TOKEN:-docker-local-gateway-dev}` | Non-loopback bind requires a token; empty `.env` values use the local default |
| `CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`                       | Host `.env` often sets WSL `google-chrome`, which does not exist in the image |
| `CURSOR_USAGE_AUTH_HEADLESS=true`                                  | Container has no display; headed OAuth from `.env` (`false`) will fail        |
| `BROWSER_BRIDGE_URL=http://host.docker.internal:4318`              | URL to reach Windows Host Browser Bridge via host-gateway                     |
| `BROWSER_BRIDGE_TOKEN=${BROWSER_BRIDGE_TOKEN:-...}`                | Security token for Host Browser Bridge communication                          |

The Compose configuration includes `extra_hosts: ["host.docker.internal:host-gateway"]`, allowing the containerized proxy to reach native Windows services.

Set a strong, unique `GATEWAY_API_TOKEN` in `.env` before exposing the container beyond your machine. Use that value as `X-Gateway-API-Key` in Swagger.

## Quick start

```bash
docker compose up --build
```

API: `http://127.0.0.1:3000` (override host port with `PORT` in `.env`).

Swagger UI: `http://127.0.0.1:3000/docs`

## Image layout

- Multi-stage build: install workspace deps, `pnpm prune --prod`, copy production `node_modules` and sources
- Runtime user: `gateway` (uid 1001)
- Entrypoint: `tini` for signal forwarding
- Process: `node --import tsx src/server.ts` from `apps/api` (TypeScript workspace packages without a separate compile step)
- `@vscode/ripgrep` is on `PATH` via existing server bootstrap (Cursor SDK compatibility)

## Build only

```bash
docker build -t agent-runtime-gateway:local .
```

## Environment

Compose loads `.env` when present. Set `PORT` to change the published host port. Inside the container the app listens on `0.0.0.0:3000` unless you override `PORT`.

### Workspace mount (Composer / Codex)

Local Cursor agents need a project tree on disk.

| Compose setting                    | Default                            | Container path          |
| ---------------------------------- | ---------------------------------- | ----------------------- |
| `CURSOR_WORKSPACE_HOST_PATH`       | `../connexto-aihub` (sibling repo) | mounted at `/workspace` |
| `CURSOR_DEFAULT_WORKING_DIRECTORY` | `/workspace`                       | Cursor SDK `local.cwd`  |

**Direct proxy clients** (no `X-Gateway-API-Key`) may use `CURSOR_DEFAULT_WORKING_DIRECTORY` when the payload does not declare a workspace. Mount the repo under `/workspace` (or set both the mount and `CURSOR_DEFAULT_WORKING_DIRECTORY` to match).

**AI Hub + Codex** send the IDE workspace in `instructions` / `input_text` (plain labels or Codex `<cwd>` / `<workspace_roots><root>` XML). The gateway resolves `local.cwd` from that payload only — it does not fall back to `CURSOR_DEFAULT_WORKING_DIRECTORY`. Parsed paths are **absolute on the host** (for example `/home/you/project`). Inside Docker those paths must exist at the **same absolute path**, not only under a renamed mount such as `/workspace` or `/projects`. Typical fix:

```yaml
volumes:
  - /home/rafael:/home/rafael:rw
```

Adjust the host prefix to your layout and keep `user: 1000:1000` (or `CURSOR_CONTAINER_USER`) so writes succeed.

**Alternative:** run `pnpm dev` on the host instead of Docker; host paths from Codex already exist locally.

Override `CURSOR_WORKSPACE_HOST_PATH` in `.env` when your checkout layout differs. The default Compose file sets `user: 1000:1000` so the bind-mounted workspace remains writable from the container (adjust with `CURSOR_CONTAINER_USER` if your host uid differs). The application tree under `/app` remains world-readable (`755`) so a non-`gateway` uid can still start Node.

The runtime image installs **`git`** (agent tools) and bootstraps **`@vscode/ripgrep`** on `PATH` at startup.

Without workspace mounts or payload paths, default `cwd` inside the container is `/app/apps/api`.

### Session & Authentication Persistence

Restarting or recreating the Proxy Docker container preserves provider sessions and authentication state:

- **Named Volume `proxy-sessions`**: Mounted at `/var/lib/connexto-proxy/sessions:rw`. Stores session mappings for Cursor (`cursor/<sessionId>.json`) and Antigravity ACP (`antigravity/<gatewaySessionId>.json`). Directory permissions in the image (`1777`) ensure write access across any host UID (`CURSOR_CONTAINER_USER`).
- **Antigravity Host Credentials & Environment**: The compose file mounts `${HOST_GEMINI_DIR:-${HOME}/.gemini}` to `/app/.gemini` and `${HOST_ANTIGRAVITY_CONFIG_DIR:-${HOME}/.config/antigravity}` to `/app/.config/antigravity`, preserving Google OAuth tokens (`oauth_creds.json`, `jetski-standalone-oauth-token`, `google_accounts.json`) and CLI user scopes. The container sets `HOME=/app`, `AGY_PATH=/app/.gemini/bin/agy`, and adds `/app/.gemini/bin` to `PATH`.
- **Container Re-creation**: Running `docker compose down && docker compose up -d` retains the `proxy-sessions` volume, eliminating the need to re-login to providers.

### Cursor usage auth & quota collection (Host Browser Bridge)

In Docker, the gateway delegates browser authentication and quota extraction to the **Host Browser Bridge** running natively on Windows at `http://host.docker.internal:4318`:

- **Interactive Login («Login web»)**: Calls `POST /v1/providers/cursor/auth`. The bridge opens a native Windows Chrome window so the user can complete social login or CAPTCHA solving. Once completed, the session is stored in the persistent Windows user data directory (`%LOCALAPPDATA%\Connexto\BrowserBridge\profiles\<principalId>`).
- **Background Quota Collect («Atualizar»)**: Calls `POST /v1/providers/cursor/usage/collect`. The bridge runs Chrome in background headless mode (`--headless=new`) using the authenticated persistent profile to retrieve usage data without popping up any desktop windows.
- **Fallback**: If `BROWSER_BRIDGE_URL` is unreachable or unset, the container falls back to its internal bundled Chromium (`/usr/bin/chromium`) in headless mode.

See [host-browser-bridge.md](host-browser-bridge.md) for bridge setup and architecture details.

### Clearing persisted sessions (API)

To force a fresh provider session without removing the whole volume, call (with `X-Gateway-API-Key` when the server requires it):

`POST /v1/runtime/sessions/clear` with JSON body `{ "namespace": "cursor" }` or `{ "namespace": "antigravity" }`.

This deletes the on-disk session directory for that provider under `SESSION_STORAGE_PATH`. Antigravity OAuth tokens under `~/.gemini` / `~/.config/antigravity` (host mounts) are separate; clear those only if you need a full Google re-login outside the hub.

## Health check

The image healthcheck calls `GET /health` on the configured `PORT`.
