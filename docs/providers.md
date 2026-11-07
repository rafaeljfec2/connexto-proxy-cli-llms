# Providers

## Overview

Providers implement `@agent-runtime-gateway/core` **`AgentProvider`**. The HTTP app registers providers on a **`ProviderRegistry`** and executes through **`RuntimeExecutor`**.

**Cursor** and **Antigravity** are registered in `apps/api/src/services/gateway.ts`.

## Cursor — `@agent-runtime-gateway/provider-cursor`

### Capabilities

- **Model listing** — `Cursor.models.list` / engine-backed listing (HTTP `/v1/models` uses the static Composer catalog; live listing is available on the provider class).
- **Local agents** — `Agent.create` / `Agent.resume` with `local.cwd` set to the working directory.
- **Execution** — `agent.send`, `run.stream`, `run.wait`, `run.cancel`.
- **Session map** — in-memory `sessionId → agentId` with resume-first semantics.
- **Engine port** — Connect/protobuf streaming, tool decoding, and filters adapted from [standardagents/composer-api](https://github.com/standardagents/composer-api) (not the Cloudflare Worker HTTP bridge).

### Credentials

| Mechanism                                        | Used for                                                     |
| ------------------------------------------------ | ------------------------------------------------------------ |
| Request `Authorization: Bearer …` or `x-api-key` | HTTP → `credential: { type: "api_key", value }` on execute   |
| `CURSOR_API_KEY` env                             | Fallback when headers omit a key; provider integration tests |
| `GATEWAY_API_TOKEN`                              | **Not used** (planned gateway-only auth)                     |

Supported credential types on execute: `api_key`, `cursor_api_key` (see `packages/providers/cursor/src/credential.ts`).

**Never log or commit API keys.**

### Working directory

Chat/responses handlers pass the process current working directory unless overridden in future gateway config. Local Cursor tools operate relative to `local.cwd` on agent create/resume.

### Errors

SDK failures are normalized to **`CursorProviderError`** (stable `code`, optional `cause`) inside the provider package. HTTP layer maps failures to OpenAI-style JSON errors.

### Tests

| Suite                    | Command                                                                 | Needs `CURSOR_API_KEY` |
| ------------------------ | ----------------------------------------------------------------------- | ---------------------- |
| Unit / engine / protocol | `pnpm test`                                                             | No (live suites skip)  |
| Provider integration     | `pnpm --filter @agent-runtime-gateway/provider-cursor test:integration` | **Yes**                |
| Live HTTP                | `tests/api.integration.test.ts` inside `pnpm test`                      | **Yes**                |

Example:

```bash
export CURSOR_API_KEY=...
pnpm --filter @agent-runtime-gateway/provider-cursor test:integration
```

## Antigravity — `@agent-runtime-gateway/provider-antigravity`

### Capabilities

- Implements `AgentProvider` using the official `agy acp` CLI over ACP v1 stdio.
- Existing OpenAI-compatible execution routes select this provider through namespaced model IDs in the existing `model` field: `antigravity:<model-id>`.
- The provider starts `agy` from `PATH` or `~/.gemini/bin/agy`; `AGY_PATH` can override the executable path.
- `/v1/models` exposes the verified namespaced models: `antigravity:gemini-3.8-flash`, `antigravity:claude-sonnet-4-6`, `antigravity:claude-opus-4-6-thinking`, and `antigravity:gpt-oss-120b-medium`.
- Gateway session affinity maps to an ACP session ID in bounded in-memory state. Each execution uses a request-scoped ACP process, resumes or creates the ACP session, streams message deltas, and terminates the process after completion or cancellation.
- The provider is registered alongside Cursor in the same `ProviderRegistry`; no HTTP route, request field, header, or response shape is added.

### Credentials

- Gateway HTTP authentication follows the existing gateway middleware policy.
- Antigravity execution does not require a Cursor API key. The official CLI reuses its locally authenticated Google session through ACP `authenticate { methodId: "oauth-personal" }` when required.
- Google credentials are not read by the provider, exported to the process, transported over ACP, or logged. The subprocess inherits only operational environment variables; per-client explicit environment overrides remain available.

### Limitations

- Antigravity model IDs accept PNG and JPEG images through `image_url` (base64 data URLs and HTTP(S) URLs) and `input_image` content, up to 1 MiB decoded per image and 8 images per request. URL images are fetched with SSRF protection: validated addresses are pinned to the connection, redirects are revalidated, and at most 3 redirect hops are followed. OpenAI tool definitions remain rejected for Antigravity model IDs; Cursor behavior is unchanged.
- The gateway-to-ACP session mapping is in memory and does not survive an API process restart. ACP session history remains under the local `agy` CLI's control.
- Models are a static catalog of the values verified against `agy` 1.5.1. Update the catalog when supported agent configuration values change.

### Validation

- Offline provider and gateway tests use the ACP fixture and require no Google or Cursor credentials.
- Real `agy` tests are opt-in with `RUN_ANTIGRAVITY_ACP_TESTS=1`; they reuse the local Google session and can consume provider quota.

## Adding another provider

1. Create `packages/providers/<id>/` implementing `AgentProvider`.
2. Register in `createGatewayServices()`.
3. Extend HTTP routing only if clients need provider selection beyond current OpenAI mapping.

See [architecture.md](architecture.md) and [development.md](development.md).
