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

## Meta & health

| Method | Path      | Gateway auth | Description                                                        |
| ------ | --------- | ------------ | ------------------------------------------------------------------ |
| `GET`  | `/health` | No           | Liveness: `{ "status": "ok", "service": "agent-runtime-gateway" }` |
| `GET`  | `/`       | No           | Service metadata and model id list                                 |
| `GET`  | `/v1`     | No           | Same as `/`                                                        |

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

In-memory response storage is provided by `ResponseSessionStore` in the compatibility package (bounded LRU).

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
