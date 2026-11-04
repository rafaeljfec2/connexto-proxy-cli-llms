# Phase 0 — Bootstrap report

## Objective

Executable monorepo with HTTP health check and automated tests.

## Environment

| Tool    | Version                          |
| ------- | -------------------------------- |
| Node.js | v24.22.1                         |
| pnpm    | 11.12.0                          |
| Git     | repo initialized, no commits yet |

## Structure created

- Root workspace: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, Vitest, ESLint, Prettier
- `apps/api` — Fastify server (`GET /health`)
- `tests/health.test.ts` — inject-based health test
- `docs/architecture.md`, `docs/development.md`, `docs/providers.md`

## Decisions

- **HTTP framework:** Fastify (Phase 0 task list); Express listed in stack reference for later alignment if needed.
- **No providers or core packages** in this phase.
- **pnpm build scripts:** `esbuild` approved via `allowBuilds` in `pnpm-workspace.yaml` (pnpm 11 supply-chain policy).

## Commands run (evidence)

```bash
pnpm install
pnpm test        # 1 passed
pnpm typecheck   # clean
pnpm lint        # clean
pnpm format:check
curl http://127.0.0.1:3000/health  # {"status":"ok","service":"agent-runtime-gateway"}
```

## Blockers / notes

- Repository folder name: `connexto-proxy-cli-llms`; product name: `agent-runtime-gateway`.
- No git remote configured yet; `.ai-memory.toml` uses project id `connexto-proxy-cli-llms`.

## Next

Phase 1 — core contracts, `ProviderRegistry`, `ProviderRouter`, `RuntimeExecutor`, unit tests.
