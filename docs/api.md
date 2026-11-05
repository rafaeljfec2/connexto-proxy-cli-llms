# HTTP API

OpenAI-compatible surface served by `@agent-runtime-gateway/api` (Express 5). Base URL: `http://<HOST>:<PORT>` (default `http://127.0.0.1:3000`).

## Authentication

When `GATEWAY_API_TOKEN` is configured, send the gateway token separately from the Cursor API key:

```http
X-Gateway-API-Key: <GATEWAY_API_TOKEN>
Authorization: Bearer <CURSOR_API_KEY>
```

Use `x-api-key` instead of `Authorization` when that is the provider client's supported header:

```http
x-api-key: <CURSOR_API_KEY>
```

The gateway token is required for private routes whenever configured. A non-loopback server cannot start without it. Loopback-only mode may omit it to preserve local client compatibility; configure a token locally when local processes should also authenticate. The token is not accepted in query strings or as a Cursor credential.

When gateway authentication is enabled, the public endpoints are explicitly limited to health and model metadata:

- `GET /health`
- `GET /` and `GET /v1`
- `GET /v1/models` and `GET /v1/models/:model`
- `OPTIONS` preflight requests, which do not access route data

All other routes listed below require gateway authentication when a gateway token is configured. In loopback-only mode without a gateway token, the listener is the trust boundary and existing local clients remain unauthenticated. `CURSOR_API_KEY` remains an optional provider fallback and never substitutes for the gateway token.

### Consumer identities and resource ownership

Each gateway credential represents an independent consumer. `GATEWAY_API_TOKEN` remains the primary credential; `GATEWAY_API_TOKENS` accepts a comma-separated list of additional credentials (deduplicated at load time, none may equal `GATEWAY_API_TOKEN` or `CURSOR_API_KEY`). Every credential maps to an internal principal derived as a one-way SHA-256 digest — the raw token is never stored, logged, or exposed, and principal identifiers never appear in responses or logs. In loopback-only mode without tokens, all local requests share the single trusted local principal.

Stored Responses belong to the principal that created them, and that association is stamped server-side at creation; client input cannot change or choose it. Every individualized operation — reading a Response, reading its input items, cancelling or deleting it, and chaining onto `previous_response_id` — requires ownership. Resources with an unknown ID, owned by a different consumer, or without a recorded owner (legacy entries) respond identically with `404 {"error":{"message":"Response not found","code":"not_found"}}`; knowing or guessing a Response ID reveals nothing about existence or ownership.

### Session affinity

Consumers may attach continuity to provider execution with the `x-session-affinity` (or legacy `x-opencode-session`) header. The value is never used raw: the gateway binds it to the authenticated principal via a one-way digest, so consumers cannot collide on a provider session or resume another consumer's agent by submitting the same affinity value. When a request carries both an affinity header and `previous_response_id`, the affinity header takes precedence over the chained session key (pre-Phase-4 priority order preserved). Requests without an affinity header continue a chained `previous_response_id` with its original session key, and fresh executions without either input receive a new server-generated session.

## Meta & health

| Method | Path      | Gateway auth | Description                                                                                                                                     |
| ------ | --------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health` | No           | Liveness plus local runtime counters (stored Responses/sessions, active executions, process memory). No response bodies or secrets are exposed. |
| `GET`  | `/`       | No           | Service metadata and model id list                                                                                                              |
| `GET`  | `/v1`     | No           | Same as `/`                                                                                                                                     |

## Models

| Method | Path                | Gateway auth | Description                                |
| ------ | ------------------- | ------------ | ------------------------------------------ |
| `GET`  | `/v1/models`        | No           | OpenAI-style model list (Composer catalog) |
| `GET`  | `/v1/models/:model` | No           | Single model object or 404                 |

Catalog includes ids such as `composer-2.5`, `composer-2.5-fast`, and Grok aliases — see `@agent-runtime-gateway/compatibility-openai` `models.ts`.

## Chat Completions

| Method | Path                   | Gateway auth | Description                                  |
| ------ | ---------------------- | ------------ | -------------------------------------------- |
| `POST` | `/v1/chat/completions` | **Yes**      | OpenAI Chat Completions (JSON or SSE stream) |

**Non-stream body (minimal):**

```json
{
  "model": "composer-2.5",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": false
}
```

**Stream:** set `"stream": true` — response is `text/event-stream` with OpenAI-style chunks and `[DONE]`.

Successful JSON responses may include extension fields (e.g. `cursor_run_id`) in addition to standard OpenAI fields.

## Legacy completions

| Method | Path              | Gateway auth | Description                         |
| ------ | ----------------- | ------------ | ----------------------------------- |
| `POST` | `/v1/completions` | **Yes**      | Text completions API (legacy shape) |

## Responses API

Registered under `apps/api/src/routes/responses.ts`:

| Method   | Path                            | Gateway auth | Description                      |
| -------- | ------------------------------- | ------------ | -------------------------------- |
| `POST`   | `/v1/responses`                 | **Yes**      | Create response (stream or JSON) |
| `POST`   | `/v1/responses/input_tokens`    | **Yes**      | Input token estimation           |
| `POST`   | `/v1/responses/compact`         | **Yes**      | Compact transcript helper        |
| `GET`    | `/v1/responses/:id`             | **Yes**      | Fetch stored response            |
| `GET`    | `/v1/responses/:id/input_items` | **Yes**      | Input items for a response       |
| `POST`   | `/v1/responses/:id/cancel`      | **Yes**      | Cancel a background Response     |
| `DELETE` | `/v1/responses/:id`             | **Yes**      | Delete stored response           |

In-memory response storage is provided by `ResponseSessionStore` in the compatibility package (TTL plus bounded capacity with active-run protection).

OpenAI's cancel endpoint applies only to Responses created with `background: true`. This gateway currently rejects background Responses, so explicit Response cancellation is unavailable. A client disconnect still cancels the provider execution associated with that HTTP request.

## CORS & preflight

Browser origins follow the configured `CORS_ORIGINS` policy described in [configuration.md](configuration.md). The gateway never returns `Access-Control-Allow-Origin: *`. A preflight from an allowed origin receives `204` only when its requested method and headers are supported; the response grants only that method and the allowed request headers it asked for. An unconfigured origin or unsupported method/header receives `403` without CORS authorization headers. `OPTIONS` without an `Origin` continues to return an empty `204` without CORS authorization.

CORS preflight does not authenticate or authorize access to API data. The actual request must still pass gateway authentication when enabled. Requests without `Origin`, including CLI and server-to-server clients, continue through the normal route and authentication rules.

## Correlation id

Every response includes:

```http
X-Request-ID: <uuid>
```

Also listed in `Access-Control-Expose-Headers`.

## Error shape

Validation and provider errors generally follow OpenAI-style JSON:

```json
{
  "error": {
    "message": "...",
    "type": "...",
    "param": "..."
  }
}
```

## Native agent run API

`POST /v1/agents/run` (gateway-native contract from the product roadmap) is **not implemented**. Execution today goes through the OpenAI-compatible routes above.

## Examples

See [../README.md](../README.md) for `curl` quick starts. For protocol details and tool/MCP behavior, see `packages/compatibility/openai/src/protocol/` and phase report [reports/phase-3-composer-api-port.md](reports/phase-3-composer-api-port.md).
