# Development guide

## Workspace

pnpm monorepo (`pnpm-workspace.yaml`):

| Path                            | Package                                       |
| ------------------------------- | --------------------------------------------- |
| `apps/api`                      | `@agent-runtime-gateway/api`                  |
| `packages/core`                 | `@agent-runtime-gateway/core`                 |
| `packages/providers/cursor`     | `@agent-runtime-gateway/provider-cursor`      |
| `packages/compatibility/openai` | `@agent-runtime-gateway/compatibility-openai` |

Root `package.json` holds shared devDependencies (Vitest, ESLint, Prettier, Supertest) and orchestration scripts.

For recoverable feature delivery (demands, review gate, AI Memory), see [connexto-workflow.md](connexto-workflow.md).

## First-time setup

```bash
pnpm install
cp .env.example .env
# Edit .env — set CURSOR_API_KEY for real agent execution
# A gateway token is optional while HOST remains loopback.
```

## Run locally

```bash
pnpm dev
# http://127.0.0.1:3000
```

The default loopback mode may omit `GATEWAY_API_TOKEN` for existing local clients. Set the token to require authentication from local clients too. To allow remote clients, set a non-loopback `HOST` and a unique `GATEWAY_API_TOKEN`; startup fails if the token is missing. Send the gateway token as `X-Gateway-API-Key` and keep it separate from the Cursor credential in `Authorization` or `x-api-key`. See [configuration.md](configuration.md) for the endpoint allowlist and deployment examples.

Build and run compiled output:

```bash
pnpm build
pnpm start
```

## Quality gates

Run before pushing changes:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
```

Optional full build:

```bash
pnpm build
```

## Project structure (API)

```
apps/api/src/
  server.ts          # entry: load .env, logger, listen
  app.ts             # Express app, middleware, route registration
  config/env.ts      # HOST, PORT, LOG_*
  routes/            # HTTP handlers
  services/gateway.ts # ProviderRegistry + CursorProvider + executor
  utils/             # auth, logger, sse, session, run helpers
```

Core and providers **must not** import Express — only `apps/api` binds HTTP.

## Importing the app in tests

```typescript
import { buildApp, loadEnvFileIfPresent } from "@agent-runtime-gateway/api";
import request from "supertest";

loadEnvFileIfPresent();
const app = buildApp();
await request(app).get("/health");
```

## Phase roadmap (product master prompt)

| Phase                    | Status  | Notes                                                        |
| ------------------------ | ------- | ------------------------------------------------------------ |
| 0 — Bootstrap            | Done    | Monorepo, health, toolchain                                  |
| 1 — Core                 | Done    | Registry, router, executor                                   |
| 2 — Cursor provider      | Done    | `@cursor/sdk` + engine port                                  |
| 3 — First HTTP execution | Done    | Composer API port (OpenAI routes), not `POST /v1/agents/run` |
| 4 — Gateway auth         | Done    | Separate gateway token; remote binds require configuration   |
| 5 — Sessions             | Partial | Session affinity headers + Cursor resume                     |
| 6 — Streaming            | Done    | SSE on chat/responses                                        |
| 7 — Antigravity          | Done    | ACP v1 provider, registered and routed via namespaced models |
| 8 — OpenAI clients       | Done    | `packages/compatibility/openai` + Express routes             |

Delivery evidence: [reports/](reports/).

## Adding a provider

1. Implement `AgentProvider` in `packages/providers/<name>`.
2. Register in `createGatewayServices()` (`apps/api/src/services/gateway.ts`).
3. Wire HTTP if needed without leaking framework types into the provider package.

## Tooling notes

- **pnpm 11** may require approved build scripts for `esbuild` — see `pnpm-workspace.yaml` (`allowBuilds`).
- TypeScript: `module` / `moduleResolution` **NodeNext**; use `.js` extensions in relative imports inside packages.
- Docker production images use `LOG_FORMAT=json` by default; `pino-pretty` is only loaded when `LOG_FORMAT=pretty` (dev dependency).

## See also

- [docker.md](docker.md)
- [configuration.md](configuration.md)
- [testing.md](testing.md)
- [api.md](api.md)
