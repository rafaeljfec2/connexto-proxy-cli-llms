# agent-runtime-gateway

Personal **OpenAI-compatible HTTP gateway** for running **Cursor** agents locally. Clients such as OpenCode, custom scripts, or any OpenAI SDK can call familiar endpoints (`/v1/chat/completions`, `/v1/responses`, …) while execution goes through the official **`@cursor/sdk`** and the gateway’s provider runtime.

This is a **single-operator** project: no multi-tenant billing, no hosted SaaS features.

## Features

- **Express 5** API with Composer-style routes (ported from [standardagents/composer-api](https://github.com/standardagents/composer-api))
- **Cursor provider** via `@cursor/sdk` (local agents, session resume, streaming)
- **OpenAI compatibility layer** (`@agent-runtime-gateway/compatibility-openai`) — chat, completions, responses, SSE, tool/MCP mapping
- **Core runtime** (`@agent-runtime-gateway/core`) — registry, router, executor, shared contracts
- **Structured logging** (Pino) with `X-Request-ID` correlation — see [docs/logging.md](docs/logging.md)

## Requirements

| Tool    | Version       |
| ------- | ------------- |
| Node.js | **22+** (LTS) |
| pnpm    | **11+**       |

Optional for **live** integration tests and real agent runs:

- A valid **Cursor API key** ([Cursor dashboard](https://cursor.com))

## Quick start

### 1. Clone and install

```bash
git clone <your-remote> connexto-proxy-cli-llms
cd connexto-proxy-cli-llms
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` at the **repository root** (the API walks up the tree and loads the first `.env` it finds):

```env
HOST=127.0.0.1
PORT=3000
LOG_FORMAT=pretty
LOG_LEVEL=info

# Required for real agent calls (also accepted per request — see Authentication)
CURSOR_API_KEY=your_cursor_api_key_here
```

See [docs/configuration.md](docs/configuration.md) for every variable.

### 3. Run the gateway

**Development** (reload on change):

```bash
pnpm dev
```

**Production-style** (compile then run):

```bash
pnpm build
pnpm start
```

### 4. Verify

```bash
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/v1
```

Expected health payload:

```json
{ "status": "ok", "service": "agent-runtime-gateway" }
```

### 5. Call the API (example)

Non-streaming chat completion (uses your Cursor key):

```bash
curl -s http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "messages": [{"role": "user", "content": "Say hello in one short sentence."}],
    "stream": false
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "composer-2.5",
    "messages": [{"role": "user", "content": "Count to three."}],
    "stream": true
  }'
```

Full route list and request shapes: [docs/api.md](docs/api.md).

## Authentication (current behavior)

The gateway resolves the **Cursor API key** for provider calls in this order:

1. `Authorization: Bearer <token>` (unless the token is the literal `local` or `dummy`)
2. `x-api-key: <token>` (same exclusions)
3. `CURSOR_API_KEY` from the process environment

There is **no separate gateway gate** yet: `GATEWAY_API_TOKEN` appears in `.env.example` but is **not enforced** by the server. Treat **network exposure** accordingly — default bind is loopback (`127.0.0.1`). Details: [docs/configuration.md](docs/configuration.md#authentication).

## Monorepo layout

| Path                            | Package                                       | Role                                    |
| ------------------------------- | --------------------------------------------- | --------------------------------------- |
| `apps/api`                      | `@agent-runtime-gateway/api`                  | Express HTTP server                     |
| `packages/core`                 | `@agent-runtime-gateway/core`                 | Provider contracts, registry, executor  |
| `packages/providers/cursor`     | `@agent-runtime-gateway/provider-cursor`      | Cursor SDK + engine port                |
| `packages/compatibility/openai` | `@agent-runtime-gateway/compatibility-openai` | OpenAI/Composer protocol & SSE          |
| `tests/`                        | —                                             | Root Vitest suites (HTTP, logging, env) |

## Scripts

| Command             | Description                                                  |
| ------------------- | ------------------------------------------------------------ |
| `pnpm dev`          | Start API with `tsx watch`                                   |
| `pnpm start`        | Run compiled `apps/api/dist/server.js`                       |
| `pnpm build`        | `tsc` build for all packages that define `build`             |
| `pnpm test`         | Full Vitest suite (unit + HTTP; live tests skip without key) |
| `pnpm test:watch`   | Vitest watch mode                                            |
| `pnpm typecheck`    | TypeScript (workspaces + root test tsconfig)                 |
| `pnpm lint`         | ESLint                                                       |
| `pnpm format`       | Prettier write                                               |
| `pnpm format:check` | Prettier check                                               |

### Provider integration tests only

```bash
export CURSOR_API_KEY=...
pnpm --filter @agent-runtime-gateway/provider-cursor test:integration
```

## Testing

- **173+** automated tests when the default suite runs (live Cursor tests **skip** if `CURSOR_API_KEY` is unset).
- HTTP coverage uses **Supertest** against `buildApp()` from `@agent-runtime-gateway/api`.

See [docs/testing.md](docs/testing.md).

## Documentation index

| Document                                                           | Contents                   |
| ------------------------------------------------------------------ | -------------------------- |
| [docs/README.md](docs/README.md)                                   | Documentation map          |
| [docs/development.md](docs/development.md)                         | Day-to-day development     |
| [docs/connexto-workflow.md](docs/connexto-workflow.md)             | Connexto demand workflow   |
| [docs/architecture.md](docs/architecture.md)                       | System structure           |
| [docs/api.md](docs/api.md)                                         | HTTP endpoints             |
| [docs/configuration.md](docs/configuration.md)                     | Environment & auth         |
| [docs/providers.md](docs/providers.md)                             | Cursor provider            |
| [docs/logging.md](docs/logging.md)                                 | Pino logging & correlation |
| [docs/security/SECURITY-AUDIT.md](docs/security/SECURITY-AUDIT.md) | Security notes             |
| [docs/reports/](docs/reports/)                                     | Phase delivery reports     |

## Security

- **Do not commit** `.env` or API keys.
- Prefer **`HOST=127.0.0.1`** unless you explicitly need remote access and additional controls.
- Logs intentionally **omit** prompts, completions, and credentials — see [docs/logging.md](docs/logging.md).

## License

Private / personal use — see repository policy.
