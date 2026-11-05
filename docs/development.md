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

## First-time setup

```bash
pnpm install
cp .env.example .env
# Edit .env — set CURSOR_API_KEY for live agent tests
```

## Run locally

```bash
pnpm dev
# http://127.0.0.1:3000
```

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
| 4 — Gateway auth         | Open    | `GATEWAY_API_TOKEN` not enforced                             |
| 5 — Sessions             | Partial | Session affinity headers + Cursor resume                     |
| 6 — Streaming            | Done    | SSE on chat/responses                                        |
| 7 — Antigravity          | Open    | Second provider                                              |
| 8 — OpenAI clients       | Done    | `packages/compatibility/openai` + Express routes             |

Delivery evidence: [reports/](reports/).

## Adding a provider

1. Implement `AgentProvider` in `packages/providers/<name>`.
2. Register in `createGatewayServices()` (`apps/api/src/services/gateway.ts`).
3. Wire HTTP if needed without leaking framework types into the provider package.

## Tooling notes

- **pnpm 11** may require approved build scripts for `esbuild` — see `pnpm-workspace.yaml` (`allowBuilds`).
- TypeScript: `module` / `moduleResolution` **NodeNext**; use `.js` extensions in relative imports inside packages.

## See also

- [configuration.md](configuration.md)
- [testing.md](testing.md)
- [api.md](api.md)
