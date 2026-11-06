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

Local Cursor agents need a project tree on disk. The default Compose file mounts a host directory into the container and points the agent there:

| Compose setting                    | Default                            | Container path          |
| ---------------------------------- | ---------------------------------- | ----------------------- |
| `CURSOR_WORKSPACE_HOST_PATH`       | `../connexto-aihub` (sibling repo) | mounted at `/workspace` |
| `CURSOR_DEFAULT_WORKING_DIRECTORY` | `/workspace`                       | Cursor SDK `local.cwd`  |

Override `CURSOR_WORKSPACE_HOST_PATH` in `.env` when your checkout layout differs. The default Compose file sets `user: 1000:1000` so the bind-mounted workspace remains writable from the container (adjust with `CURSOR_CONTAINER_USER` if your host uid differs). The application tree under `/app` remains world-readable (`755`) so a non-`gateway` uid can still start Node.

The runtime image installs **`git`** (agent tools) and bootstraps **`@vscode/ripgrep`** on `PATH` at startup.

For agent runs that need a host project tree, mount your workspace and set `CURSOR_DEFAULT_WORKING_DIRECTORY` — default `cwd` without these settings is `/app/apps/api` inside the container.

### Session & Authentication Persistence

Restarting or recreating the Proxy Docker container preserves provider sessions and authentication state:

- **Named Volume `proxy-sessions`**: Mounted at `/var/lib/connexto-proxy/sessions:rw`. Stores session mappings for Cursor (`cursor/<sessionId>.json`) and Antigravity ACP (`antigravity/<gatewaySessionId>.json`). Directory permissions in the image (`1777`) ensure write access across any host UID (`CURSOR_CONTAINER_USER`).
- **Antigravity Host Credentials & Environment**: The compose file mounts `${HOST_GEMINI_DIR:-${HOME}/.gemini}` to `/app/.gemini` and `${HOST_ANTIGRAVITY_CONFIG_DIR:-${HOME}/.config/antigravity}` to `/app/.config/antigravity`, preserving Google OAuth tokens (`oauth_creds.json`, `jetski-standalone-oauth-token`, `google_accounts.json`) and CLI user scopes. The container sets `HOME=/app`, `AGY_PATH=/app/.gemini/bin/agy`, and adds `/app/.gemini/bin` to `PATH`.
- **Container Re-creation**: Running `docker compose down && docker compose up -d` retains the `proxy-sessions` volume, eliminating the need to re-login to providers.

### Clearing persisted sessions (API)

To force a fresh provider session without removing the whole volume, call (with `X-Gateway-API-Key` when the server requires it):

`POST /v1/runtime/sessions/clear` with JSON body `{ "namespace": "cursor" }` or `{ "namespace": "antigravity" }`.

This deletes the on-disk session directory for that provider under `SESSION_STORAGE_PATH`. Antigravity OAuth tokens under `~/.gemini` / `~/.config/antigravity` (host mounts) are separate; clear those only if you need a full Google re-login outside the hub.

## Health check

The image healthcheck calls `GET /health` on the configured `PORT`.
