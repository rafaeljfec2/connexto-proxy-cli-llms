# Architecture (initial)

## Goal

A unified HTTP API that authenticates callers, resolves a runtime provider, runs an agent task, and returns a normalized result.

## Current state (Phase 0)

```
Client ──HTTP──► apps/api (Fastify)
                      └── GET /health
```

No provider layer, registry, or persistence yet.

## Target layout (reference)

```
apps/api          HTTP routes, middleware, config
packages/core     AgentProvider contract, registry, router, executor
packages/providers/cursor   Cursor SDK adapter
packages/shared   Shared types and utilities
```

Implementation proceeds in vertical slices; see `docs/development.md`.
