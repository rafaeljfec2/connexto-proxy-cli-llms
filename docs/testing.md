# Testing

Vitest runs from the repository root (`pnpm test`). Tests are grouped by layer; **live** tests skip automatically when `CURSOR_API_KEY` is unset.

## Quick commands

```bash
pnpm test              # full suite
pnpm test:watch        # watch mode
pnpm typecheck         # includes tests/ and packages/**/tests/
pnpm lint
```

## Layers

| Layer                 | Location                                          | Needs Cursor key            |
| --------------------- | ------------------------------------------------- | --------------------------- |
| API health / env      | `tests/health.test.ts`, `tests/env.test.ts`       | No                          |
| HTTP Composer parity  | `tests/composer-api.test.ts`                      | No (mocked / stubbed paths) |
| Logging               | `tests/logging.test.ts`                           | No                          |
| Live HTTP integration | `tests/api.integration.test.ts`                   | **Yes**                     |
| Core runtime          | `packages/core/tests/`                            | No                          |
| Cursor provider       | `packages/providers/cursor/tests/`                | Integration only            |
| Cursor engine / SDK   | `packages/providers/cursor/tests/engine/`, `sdk/` | No                          |
| OpenAI protocol       | `packages/compatibility/openai/tests/`            | No                          |

## Live integration

### HTTP (`tests/api.integration.test.ts`)

Uses Supertest against `buildApp()` with real Cursor execution:

```bash
export CURSOR_API_KEY=your_key
pnpm test tests/api.integration.test.ts
```

Covers non-stream and stream `POST /v1/chat/completions`, correlated logs, and `X-Request-ID`.

### Provider package

```bash
export CURSOR_API_KEY=your_key
pnpm --filter @agent-runtime-gateway/provider-cursor test:integration
```

## Expected skip behavior

When `CURSOR_API_KEY` is missing:

- `describe.skip` blocks in live HTTP and provider integration files.
- Full `pnpm test` still passes; skipped count appears in Vitest summary (e.g. **2 skipped**).

## CI recommendations

- Always run: `pnpm typecheck`, `pnpm lint`, `pnpm test` (without secret).
- Optional job with secret: run `tests/api.integration.test.ts` and provider `test:integration`.
- Never print keys in CI logs.

## Writing new tests

- Prefer **Supertest** for HTTP (`import { buildApp } from "@agent-runtime-gateway/api"`).
- Load env in tests that need keys: `loadEnvFileIfPresent()` from `@agent-runtime-gateway/api`.
- Do not assert on full model output when calling live Cursor — assert status, shape, and minimal content checks.

See [development.md](development.md) for workspace layout.
