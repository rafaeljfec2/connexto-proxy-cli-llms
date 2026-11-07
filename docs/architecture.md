# Architecture

## Goal

Provide a **local HTTP gateway** that accepts OpenAI-compatible requests, resolves a provider from the model ID, runs agents through the selected provider, and returns normalized OpenAI-style responses (including SSE streams).

**AI Hub + Codex:** The edge agent owns the workspace and executes client tools; the hub forwards requests opaquely. Hub-integrated requests (`X-Gateway-API-Key`) default to **`edge_owned`** execution through an in-process `@cursor/sdk` agent. The SDK agent has no proxy filesystem or shell tools; client tool calls are returned through the OpenAI-compatible response stream. Direct clients remain on **`local_runtime`**, where the proxy's Cursor agent owns local tools. See [providers.md](providers.md) and [configuration.md](configuration.md). Override with `CURSOR_EXECUTION_MODE=local|edge|auto`.

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
    ├─ packages/providers/cursor → @cursor/sdk edge and local runtimes
    └─ packages/providers/antigravity → agy ACP v1 stdio client → local Antigravity agent
```

## Packages

### `apps/api`

- HTTP only: routes, middleware, logging, CORS, JSON body parsing.
- Wires `createGatewayServices()` once per process (singleton).
- Does not require a second SDK bridge process for hub-integrated Cursor requests.

### `packages/core`

- `AgentProvider`, `AgentExecutionInput`, `AgentRun`, events, results.
- `ProviderRegistry`, `ProviderRouter`, `RuntimeExecutor`.
- Typed errors: `ProviderNotFoundError`, `ProviderExecutionError`, etc.

### `packages/providers/cursor`

- Implements `AgentProvider` (`id: "cursor"`).
- Uses the official `@cursor/sdk` for both execution modes.
- Edge-owned runs use a request-scoped agent with client-only custom tools and return tool calls without executing them on proxy disk.
- Local-runtime runs retain the session-managed agent and local workspace tools.
- Legacy Cursor Connect engine modules remain isolated from the hub-integrated HTTP path.

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
- Cursor local-runtime layer: `CursorSessionManager` maps session → local SDK `agentId`, prefers `Agent.resume`, and falls back to `Agent.create`.
- Cursor edge-owned layer: each request uses a restricted SDK agent and returns client tool calls; the request transcript is supplied by the OpenAI compatibility layer.
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
