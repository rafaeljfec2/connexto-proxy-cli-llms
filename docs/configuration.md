# Configuration

Environment variables and authentication behavior for the gateway API.

## Loading `.env`

On startup, `apps/api/src/server.ts`:

1. Calls `loadEnvFileIfPresent()` — uses Node’s `process.loadEnvFile()` when available.
2. Walks **upward from `process.cwd()`** until it finds a file named `.env` (see `findEnvFile()` in `apps/api/src/config/env.ts`).
3. Parses validated settings with Zod via `loadEnv()`.

**Recommendation:** keep `.env` at the **repository root** and run commands from that directory (`pnpm dev`, `pnpm test`).

## Server variables

Validated by `loadEnv()`:

| Variable            | Default     | Description                                                                            |
| ------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `HOST`              | `127.0.0.1` | Bind address. Use loopback unless you understand exposure risks.                       |
| `PORT`              | `3000`      | TCP port.                                                                              |
| `GATEWAY_API_TOKEN` | unset       | Gateway credential. Required for non-loopback binding; optional in loopback-only mode. |
| `LOG_FORMAT`        | `json`      | `json` (NDJSON) or `pretty` (colorized terminal via `pino-pretty`).                    |
| `LOG_LEVEL`         | `info`      | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent`.              |

### Local development example

```env
HOST=127.0.0.1
PORT=3000
GATEWAY_API_TOKEN=
LOG_FORMAT=pretty
LOG_LEVEL=debug
```

Without a gateway token, loopback binding is treated as a trusted local-only mode to preserve existing local clients. If a token is configured, private endpoints require it even on loopback.

### Container / production-style example

```env
HOST=0.0.0.0
PORT=3000
GATEWAY_API_TOKEN=<set-a-random-secret>
LOG_FORMAT=json
LOG_LEVEL=info
```

Startup fails when `HOST` is not a loopback address and `GATEWAY_API_TOKEN` is empty. Use a unique high-entropy value and expose remote access only through a trusted network or a TLS-terminating proxy. The gateway rejects configuration where this value equals `CURSOR_API_KEY`.

## Cursor provider variables

| Variable         | Required      | Description                                                                                                                          |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `CURSOR_API_KEY` | For real runs | Cursor API key used as **fallback** when a request does not send Bearer / `x-api-key`. Also used by some provider integration tests. |

**Never commit** this value. `.env` is gitignored.

## Gateway authentication

When `GATEWAY_API_TOKEN` is set, send it in the dedicated `X-Gateway-API-Key` header. It is checked independently from the Cursor credential. The gateway does not accept the token from a query string, `Authorization`, or `x-api-key`.

```http
X-Gateway-API-Key: <GATEWAY_API_TOKEN>
Authorization: Bearer <CURSOR_API_KEY>
```

When gateway authentication is enabled, the public endpoints are `GET /`, `GET /v1`, `GET /health`, `GET /v1/models`, and `GET /v1/models/:model`. All other application routes require the gateway token. Without a token, loopback binding remains the trusted local-only boundary. `OPTIONS` requests are handled as CORS preflight and do not access application data. CORS is not an authentication mechanism.

## Authentication

Provider routes (chat, completions, responses, etc.) resolve the **Cursor API key** via `resolveRequestApiKey()` in `apps/api/src/utils/auth.ts`:

1. **`Authorization: Bearer <token>`** — token must not be `local` or `dummy` (compatibility placeholders).
2. **`x-api-key: <token>`** — same rules.
3. **`process.env.CURSOR_API_KEY`** — trimmed; used if headers did not yield a key.

If no key is resolved, endpoints that call Cursor return **401** with an OpenAI-style error payload (`Missing Cursor API key`).

### Separate credentials

| Secret         | Purpose                                                         |
| -------------- | --------------------------------------------------------------- |
| Cursor API key | Authenticates **to Cursor** for agent execution                 |
| Gateway token  | Authenticates **to this gateway** before private route handling |

Keep the values different. A gateway token sent only in `X-Gateway-API-Key` is never treated as a Cursor key. `Authorization` and `x-api-key` continue to identify the caller to Cursor or use the configured Cursor fallback.

## Session affinity

Responses and chat flows accept session headers used by OpenCode-compatible clients (see `apps/api/src/utils/session.ts`), for example:

- `x-session-affinity`
- `x-opencode-session-id`
- `x-opencode-session`

These map to gateway `sessionId` values passed into the Cursor provider for resume/create behavior.

## CORS

The API sets permissive CORS (`Access-Control-Allow-Origin: *`) and exposes `X-Request-ID`. Restrict origins at a reverse proxy if you deploy beyond localhost.

## Further reading

- [logging.md](logging.md) — log fields and redaction
- [security/SECURITY-AUDIT.md](security/SECURITY-AUDIT.md) — exposure and backlog items
