# agent-runtime-gateway

Personal multi-provider HTTP gateway for running development agents (Cursor and future providers).

## Phase 3 (Composer API Full Port)

Monorepo layout:

- `apps/api` — Express HTTP server with full Composer API endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/models`, etc.)
- `packages/compatibility/openai` — Ported OpenAI/Composer protocol engine, SSE codecs, tool call adapters, response stores
- `packages/core` — Provider-agnostic execution runtime, registry, and contracts
- `packages/providers/cursor` — Official `@cursor/sdk` integration with session continuity
- `tests/` — Vitest integration and HTTP compatibility test suite with Supertest

## Requirements

- Node.js 22+ (LTS recommended)
- pnpm 11+

## Commands

```bash
pnpm install
pnpm dev          # start API with hot reload
pnpm test         # run Vitest
pnpm typecheck    # TypeScript across workspaces
pnpm lint         # ESLint
pnpm format:check # Prettier
```

## Environment

Copy `.env.example` to `.env` and adjust as needed:

- `HOST` — bind address (default `127.0.0.1`)
- `PORT` — listen port (default `3000`)

Provider credentials and gateway auth are added in later phases.

## Documentation

See `docs/development.md` and `docs/architecture.md`.
