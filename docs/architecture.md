# Architecture (initial)

## Goal

A unified HTTP API that authenticates callers, resolves a runtime provider, runs an agent task, and returns a normalized result.

## Current state (Phase 2)

```
Client ──HTTP──► apps/api (Fastify)
                      └── GET /health

packages/core     AgentProvider, registry, router, executor
packages/providers/cursor   Cursor SDK adapter (Phase 2)
```

No HTTP agent routes or durable session store yet. The Cursor adapter is library-only until Phase 3.

## Target layout (reference)

```
apps/api          HTTP routes, middleware, config
packages/core     AgentProvider contract, registry, router, executor
packages/providers/cursor   Cursor SDK adapter
packages/shared   Shared types and utilities
```

Implementation proceeds in vertical slices; see `docs/development.md`.
