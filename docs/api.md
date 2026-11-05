# HTTP API

OpenAI-compatible surface served by `@agent-runtime-gateway/api` (Express 5). Base URL: `http://<HOST>:<PORT>` (default `http://127.0.0.1:3000`).

## Authentication

Send a **Cursor API key** on each request **or** set `CURSOR_API_KEY` in the environment:

```http
Authorization: Bearer <CURSOR_API_KEY>
```

Alternative:

```http
x-api-key: <CURSOR_API_KEY>
```

## Meta & health

| Method | Path      | Auth | Description                                                        |
| ------ | --------- | ---- | ------------------------------------------------------------------ |
| `GET`  | `/health` | No   | Liveness: `{ "status": "ok", "service": "agent-runtime-gateway" }` |
| `GET`  | `/`       | No   | Service metadata and model id list                                 |
| `GET`  | `/v1`     | No   | Same as `/`                                                        |

## Models

| Method | Path                | Auth | Description                                |
| ------ | ------------------- | ---- | ------------------------------------------ |
| `GET`  | `/v1/models`        | No   | OpenAI-style model list (Composer catalog) |
| `GET`  | `/v1/models/:model` | No   | Single model object or 404                 |

Catalog includes ids such as `composer-2.5`, `composer-2.5-fast`, and Grok aliases — see `@agent-runtime-gateway/compatibility-openai` `models.ts`.

## Chat Completions

| Method | Path                   | Auth    | Description                                  |
| ------ | ---------------------- | ------- | -------------------------------------------- |
| `POST` | `/v1/chat/completions` | **Yes** | OpenAI Chat Completions (JSON or SSE stream) |

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

| Method | Path              | Auth    | Description                         |
| ------ | ----------------- | ------- | ----------------------------------- |
| `POST` | `/v1/completions` | **Yes** | Text completions API (legacy shape) |

## Responses API

Registered under `apps/api/src/routes/responses.ts`:

| Method   | Path                            | Auth    | Description                      |
| -------- | ------------------------------- | ------- | -------------------------------- |
| `POST`   | `/v1/responses`                 | **Yes** | Create response (stream or JSON) |
| `POST`   | `/v1/responses/input_tokens`    | **Yes** | Input token estimation           |
| `POST`   | `/v1/responses/compact`         | **Yes** | Compact transcript helper        |
| `GET`    | `/v1/responses/:id`             | Varies  | Fetch stored response            |
| `GET`    | `/v1/responses/:id/input_items` | Varies  | Input items for a response       |
| `POST`   | `/v1/responses/:id/cancel`      | **Yes** | Cancel in-flight response        |
| `DELETE` | `/v1/responses/:id`             | Varies  | Delete stored response           |

In-memory response storage is provided by `ResponseSessionStore` in the compatibility package (bounded LRU).

## CORS & preflight

All routes support `OPTIONS` with `204`. Allowed methods: `GET`, `POST`, `DELETE`.

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
