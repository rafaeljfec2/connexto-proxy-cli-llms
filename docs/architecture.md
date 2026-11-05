# Architecture

## Goal

Provide a **local HTTP gateway** that accepts OpenAI-compatible requests, resolves the **Cursor** runtime, runs agents via `@cursor/sdk`, and returns normalized OpenAI-style responses (including SSE streams).

## Request flow

```
Client (OpenAI SDK, curl, OpenCode, …)
    │
    ▼
apps/api (Express)
    │  auth: resolveRequestApiKey → Cursor API key
    │  protocol: compatibility-openai (prepare, format, SSE)
    ▼
RuntimeExecutor (@agent-runtime-gateway/core)
    │  ProviderRouter → CursorProvider
    ▼
packages/providers/cursor
    │  Session manager, SDK bridge, engine (Connect/protobuf port)
    ▼
@cursor/sdk  →  local Cursor agent (tools, workspace cwd)
```

## Packages

### `apps/api`

- HTTP only: routes, middleware, logging, CORS, JSON body parsing.
- Wires `createGatewayServices()` once per process (singleton).
- Does **not** embed Cloudflare Worker or container bridge logic.

### `packages/core`

- `AgentProvider`, `AgentExecutionInput`, `AgentRun`, events, results.
- `ProviderRegistry`, `ProviderRouter`, `RuntimeExecutor`.
- Typed errors: `ProviderNotFoundError`, `ProviderExecutionError`, etc.

### `packages/providers/cursor`

- Implements `AgentProvider` (`id: "cursor"`).
- Contains ported **engine** and **SDK bridge** modules from composer-api (`cursor.ts`, `cursor-sdk.ts`, crypto, protobuf tool specs).
- Uses official SDK for local agent lifecycle where applicable; engine port handles Composer-specific streaming/tool behavior.

### `packages/compatibility/openai`

- OpenAI / Composer protocol: chat, completions, responses, tools, transcripts.
- SSE encoders, model catalog, in-memory `ResponseSessionStore`.
- Shared by Express route handlers — keeps routes thin.

## HTTP surface (summary)

See [api.md](api.md). Notable endpoints:

- `GET /health`, `GET /v1`, `GET /v1/models`
- `POST /v1/chat/completions`, `POST /v1/completions`
- `POST /v1/responses` (+ lifecycle helpers)

Native `POST /v1/agents/run` from the original gateway roadmap is **not** present; OpenAI routes are the primary entry today.

## Session continuity

- HTTP layer: session affinity headers → gateway `sessionId`.
- Cursor layer: `CursorSessionManager` maps session → remote `agentId`, prefers `Agent.resume`, falls back to `Agent.create`.
- Responses API: `ResponseSessionStore` retains response metadata in memory (bounded store).

## Logging & observability

- Pino logger configured from `LOG_FORMAT` / `LOG_LEVEL`.
- Per-request UUID in `X-Request-ID`; request and provider summaries logged without prompts or secrets — [logging.md](logging.md).

## Security boundaries (current)

- Cursor credential arrives per request or via `CURSOR_API_KEY`.
- **No enforced gateway token** yet — see [configuration.md](configuration.md) and [security/SECURITY-AUDIT.md](security/SECURITY-AUDIT.md).
- Default bind: loopback.

## Target evolution

- Enforce `GATEWAY_API_TOKEN` for HTTP while keeping Cursor keys on the provider boundary.
- Add `POST /v1/agents/run` native contract alongside OpenAI compatibility.
- Second provider (Antigravity) registered in the same `ProviderRegistry`.

Implementation proceeds in vertical slices; see [development.md](development.md).
