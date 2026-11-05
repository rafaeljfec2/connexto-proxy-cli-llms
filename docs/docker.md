# Docker

Run the gateway in a container using **Node.js 24.22.1** (`bookworm-slim`).

## Requirements

- Docker Engine with Compose v2
- Repository root `.env` (copy from `.env.example`) with:
  - **`CURSOR_API_KEY`** — provider credential
  - **`GATEWAY_API_TOKEN`** — non-empty gateway credential (required because the container binds **`HOST=0.0.0.0`**). An empty `GATEWAY_API_TOKEN=` line is treated as unset and the process will exit.

Compose loads `.env` via `env_file`, then applies overrides below. **`environment` wins over `env_file`** for the same keys.

| Override | Reason |
| -------- | ------ |
| `HOST=0.0.0.0` | Listen inside the container network namespace |
| `LOG_FORMAT=json` | Production image has no `pino-pretty` |
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

For agent runs that need a host project tree, mount your workspace and set provider working directory via future config or run the container with `-w` / volume — default `cwd` is `/app/apps/api`.

## Health check

The image healthcheck calls `GET /health` on the configured `PORT`.
