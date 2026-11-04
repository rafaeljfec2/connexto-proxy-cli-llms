# Phase 2 — Cursor provider analysis

## Reference repository

Source: `~/dev-outros/composer-api` (Standard Agents composer-api).

## Reusable via public `@cursor/sdk`

| Pattern              | Reference location                       | Public SDK API                                             |
| -------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| List models          | `scripts/cursor-sdk-responses-proxy.mjs` | `Cursor.models.list({ apiKey })`                           |
| Create local agent   | bridge + responses proxy                 | `Agent.create({ apiKey, model, local: { cwd } })`          |
| Resume session       | responses proxy `getAgent`               | `Agent.resume(agentId, { apiKey, model, local: { cwd } })` |
| Send prompt          | both scripts                             | `agent.send(message, { model: { id } })`                   |
| Stream output        | bridge `run.stream()`                    | `run.stream()` → `SDKMessage`                              |
| Wait for result      | both                                     | `run.wait()` → `RunResult`                                 |
| Cancel               | bridge timeout path                      | `run.cancel()`                                             |
| API key on agent ops | responses proxy                          | `AgentOptions.apiKey` (not gateway Bearer token)           |

## Not imported (Cloudflare / internal)

| Area                   | Reference                                          | Reason excluded                                  |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------ |
| Worker HTTP + D1       | `worker/index.ts`, `worker/cursor-sdk.ts`          | Cloudflare runtime; protobuf bridge to container |
| Container bridge fetch | `worker/cursor-sdk.ts` → `cursor-sdk-bridge.local` | Internal deployment topology                     |
| API key exchange       | `worker/cursor.ts`                                 | Private backend protocol, not SDK                |
| Client MCP forwarding  | `cursor-sdk-local-agent-bridge.mjs`                | OpenAI tool-call proxy; out of gateway MVP scope |
| OpenAI Responses proxy | entire `cursor-sdk-responses-proxy.mjs` HTTP layer | Phase 8 compatibility, not provider adapter      |
| Protobuf tool decoding | `worker/cursor-sdk.ts` `TOOL_CALL_SPECS`           | Worker-side binary protocol                      |

## Gateway implementation choice

Package: `@agent-runtime-gateway/provider-cursor`

- Implements core `AgentProvider` only.
- Session continuity: in-memory `sessionId → agentId` with `Agent.resume` fallback to `Agent.create`.
- Event normalization: `SDKMessage` → core `AgentEvent` union.
- Errors: SDK typed errors → `CursorProviderError` / normalized codes.

## Real execution evidence

Integration tests live in `packages/providers/cursor/tests/cursor.integration.test.ts`.

They run when `CURSOR_API_KEY` is set in the environment; otherwise they are skipped (not mocked).

```bash
CURSOR_API_KEY=... pnpm --filter @agent-runtime-gateway/provider-cursor test:integration
```

At implementation time, no non-empty `CURSOR_API_KEY` was available in the repo `.env` or shell; unit tests + typecheck/lint are the automated evidence until a key is supplied.
