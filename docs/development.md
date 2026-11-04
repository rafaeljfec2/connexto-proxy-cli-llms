# Development

## Workspace

This repository is a pnpm monorepo:

| Path       | Package                      |
| ---------- | ---------------------------- |
| `apps/api` | `@agent-runtime-gateway/api` |

Future packages (`packages/core`, `packages/providers/*`) are added in later phases.

## Local run

```bash
pnpm install
pnpm dev
curl -s http://127.0.0.1:3000/health
```

## Quality gates

```bash
pnpm typecheck
pnpm lint
pnpm test
```

## Phase checklist

- [x] Phase 0 — Bootstrap, health check, tests
- [ ] Phase 1 — Core contracts and registry
- [ ] Phase 2 — Cursor provider
- [ ] Phase 3 — `POST /v1/agents/run`
- [ ] Phase 4 — Gateway authentication
- [ ] Phase 5 — Sessions
- [ ] Phase 6 — Streaming (SSE)
- [ ] Phase 7 — Antigravity provider
- [ ] Phase 8 — OpenAI-compatible routes
