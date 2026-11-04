# Phase 1 — Core report

## Objective

Minimal registry, router, and executor over provider-agnostic contracts, with unit tests. No Cursor adapter.

## Delivered

- `@agent-runtime-gateway/core` package
- Contracts: `AgentProvider`, `AgentExecutionInput`, `AgentRun`, `AgentEvent`, `AgentResult`, `Model`, `ProviderCredential`
- `ProviderRegistry`, `ProviderRouter`, `RuntimeExecutor`
- Errors: `ProviderNotFoundError`, `ProviderAlreadyRegisteredError`, `InvalidProviderIdError`, `ProviderExecutionError` (executor wraps provider failures; preserves `cause`)

## Tests (unit, stub providers in test helpers only)

| File                        | Cases                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| `provider-registry.test.ts` | register/resolve, missing, duplicate                                 |
| `provider-router.test.ts`   | selection, not found                                                 |
| `runtime-executor.test.ts`  | models, execute, events, not found, provider failure, multi-provider |

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
```

## Next

Phase 2 — Cursor provider via `@cursor/sdk` (no HTTP run endpoint required until Phase 3).
