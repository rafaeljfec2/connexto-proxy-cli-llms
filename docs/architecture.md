# Architecture (initial)

## Goal

A unified HTTP API that authenticates callers, resolves a runtime provider, runs an agent task, and returns a normalized result.

## Current state (Phase 3 — Composer API Port)

```
Client ──HTTP──► apps/api (Express)
                      ├── GET /
                      ├── GET /v1
                      ├── GET /health
                      ├── GET /v1/models & /v1/models/:model
                      ├── POST /v1/chat/completions (stream & non-stream)
                      ├── POST /v1/completions (legacy text)
                      └── /v1/responses (Responses API, stream, compact, input_tokens)

packages/compatibility/openai   OpenAI/Composer compatibility engine, SSE, schemas
packages/core                   AgentProvider contract, registry, router, executor
packages/providers/cursor       Cursor SDK adapter
```

## Target layout (reference)

```
apps/api          HTTP routes, middleware, config
packages/core     AgentProvider contract, registry, router, executor
packages/providers/cursor   Cursor SDK adapter
packages/shared   Shared types and utilities
```

Implementation proceeds in vertical slices; see `docs/development.md`.
