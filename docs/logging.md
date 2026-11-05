# Gateway Correlated Logging

## Overview

The gateway provides structured, correlated logging using [Pino](https://github.com/pinojs/pino) across the HTTP gateway lifecycle: from incoming request to provider execution (Cursor) and completion (including Server-Sent Events streams).

## Configuration

The logger is configured via environment variables loaded on server startup:

| Variable     | Values                                                                   | Default | Description                                                                                                         |
| ------------ | ------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `LOG_FORMAT` | `json` \| `pretty`                                                       | `json`  | Log output format. `json` outputs NDJSON; `pretty` uses `pino-pretty` for human-readable colorized terminal output. |
| `LOG_LEVEL`  | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent` | `info`  | Minimum log severity to emit.                                                                                       |

### Switching Between JSON and Pretty Output

In your `.env` file:

```bash
# For local development with human-friendly logs:
LOG_FORMAT=pretty
LOG_LEVEL=debug

# For production / container deployments with structured JSON:
LOG_FORMAT=json
LOG_LEVEL=info
```

## Request Correlation (`X-Request-ID`)

- Every incoming HTTP request is assigned a unique server-generated UUID v4 correlation ID.
- The ID is exposed to clients via the `X-Request-ID` response header.
- CORS configuration allows `x-request-id` in `Access-Control-Allow-Headers` and exposes it via `Access-Control-Expose-Headers: X-Request-ID`.
- Client-supplied IDs are not accepted; IDs are always generated on the server.

## Logged Events & Fields

### 1. Request Completion Summary

Emitted on `res.finish` / `res.close`:

```json
{
  "level": 30,
  "time": "2026-11-05T01:46:02.813Z",
  "requestId": "981fbd28-599c-4743-92b6-62619b578b08",
  "method": "GET",
  "route": "/health",
  "status": 200,
  "durationMs": 2.62,
  "msg": "request completed"
}
```

- `route`: Normalized route path (e.g. `/v1/models/:model`), preventing leakage of dynamic path parameters or query strings.
- `durationMs`: Total request turnaround time in milliseconds.

### 2. Provider Execution Summary

Emitted when the provider execution completes:

**Non-streaming execution:**

```json
{
  "level": 30,
  "time": "2026-11-05T01:46:11.569Z",
  "requestId": "599a22ac-00b2-4d4e-aaa8-8de37dc6b9cb",
  "provider": "cursor",
  "model": "composer-2.5",
  "status": "completed",
  "durationMs": 142.5,
  "msg": "provider execution completed"
}
```

**Streaming execution (SSE):**

```json
{
  "level": 30,
  "time": "2026-11-05T01:46:11.572Z",
  "requestId": "3b8494eb-9731-4a32-a5f6-170f8c45dade",
  "provider": "cursor",
  "model": "composer-2.5",
  "status": "completed",
  "durationMs": 350.2,
  "timeToFirstDeltaMs": 85.4,
  "msg": "provider stream completed"
}
```

- `timeToFirstDeltaMs`: Latency from execution invocation until the first chunk delta arrives.

## Data Redaction & Security Invariants

In accordance with security requirements:

- No prompt messages or user text.
- No model output or assistant text.
- No API keys, Bearer tokens, or credentials.
- No tool execution content or raw function call arguments.
- Error entries contain only safe classifications (`errorType`, `errorCode`, safe message).
