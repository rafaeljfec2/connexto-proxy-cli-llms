# Architecture

## Goal

Provide a **local HTTP gateway** that accepts OpenAI-compatible requests, resolves a provider from the model ID, runs agents through the selected provider, and returns normalized OpenAI-style responses (including SSE streams).

## Request flow

```
Client (OpenAI SDK, curl, OpenCode, …)
    │
    ▼
apps/api (Express)
    │  auth: gateway token; Cursor API key only on Cursor requests
    │  protocol: compatibility-openai (prepare, format, SSE)
    ▼
RuntimeExecutor (@agent-runtime-gateway/core)
    │  ProviderRouter → CursorProvider or AntigravityProvider
    ├─ packages/providers/cursor → @cursor/sdk and Cursor engine
    └─ packages/providers/antigravity → agy ACP v1 stdio client → local Antigravity agent
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

### `packages/providers/antigravity`

- Implements `AgentProvider` using the isolated ACP v1 client from the Antigravity package.
- Existing model selection uses the `antigravity:<model-id>` namespace; the HTTP request contract is unchanged.
- Uses the local `agy` authentication store; no Google credential is passed to the provider or subprocess.
- Gateway session affinity maps to ACP session IDs in bounded in-memory state; request-scoped ACP processes are terminated after each run.

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
- Antigravity layer: bounded in-memory mapping from gateway session → ACP session ID; each request resumes or creates the ACP session in a fresh process.
- Responses API: `ResponseSessionStore` retains response metadata in memory (bounded store).

## Logging & observability

- Pino logger configured from `LOG_FORMAT` / `LOG_LEVEL`.
- Per-request UUID in `X-Request-ID`; request and provider summaries logged without prompts or secrets — [logging.md](logging.md).

## Security boundaries (current)

- Cursor credential arrives per request or via `CURSOR_API_KEY` and is passed only to Cursor.
- Antigravity reuses the local `agy` Google session and receives no Cursor or Google credential from the gateway.
- `GATEWAY_API_TOKEN` is enforced for non-public requests when configured; without it, loopback binding is the trust boundary.
- Default bind: loopback. Remote binds require gateway-token configuration.

## Target evolution

- Add `POST /v1/agents/run` native contract alongside OpenAI compatibility.
- Antigravity is registered in the same `ProviderRegistry`. PNG and JPEG images are normalized at the route boundary (`apps/api/src/utils/antigravity-images.ts`) and forwarded as ACP image blocks; URL fetching uses the SSRF-safe pinned transport in `packages/providers/antigravity/src/images/`. OpenAI tool translation remains out of scope.

Implementation proceeds in vertical slices; see [development.md](development.md).
