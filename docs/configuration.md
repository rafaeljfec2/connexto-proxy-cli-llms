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

| Variable     | Default     | Description                                                               |
| ------------ | ----------- | ------------------------------------------------------------------------- |
| `HOST`       | `127.0.0.1` | Bind address. Use loopback unless you understand exposure risks.          |
| `PORT`       | `3000`      | TCP port.                                                                 |
| `LOG_FORMAT` | `json`      | `json` (NDJSON) or `pretty` (colorized terminal via `pino-pretty`).       |
| `LOG_LEVEL`  | `info`      | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent`. |

### Local development example

```env
HOST=127.0.0.1
PORT=3000
LOG_FORMAT=pretty
LOG_LEVEL=debug
```

### Container / production-style example

```env
HOST=0.0.0.0
PORT=3000
LOG_FORMAT=json
LOG_LEVEL=info
```

If you bind to non-loopback addresses, combine with firewall rules and a planned **gateway credential** (not implemented yet).

## Cursor provider variables

| Variable         | Required      | Description                                                                                                                          |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `CURSOR_API_KEY` | For real runs | Cursor API key used as **fallback** when a request does not send Bearer / `x-api-key`. Also used by some provider integration tests. |

**Never commit** this value. `.env` is gitignored.

## Gateway token (planned)

| Variable            | Status                                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GATEWAY_API_TOKEN` | Listed in `.env.example` only — **not read** by the current Express app. Future work: separate gateway auth from Cursor provider auth. |

## Authentication

Provider routes (chat, completions, responses, etc.) resolve the **Cursor API key** via `resolveRequestApiKey()` in `apps/api/src/utils/auth.ts`:

1. **`Authorization: Bearer <token>`** — token must not be `local` or `dummy` (compatibility placeholders).
2. **`x-api-key: <token>`** — same rules.
3. **`process.env.CURSOR_API_KEY`** — trimmed; used if headers did not yield a key.

If no key is resolved, endpoints that call Cursor return **401** with an OpenAI-style error payload (`Missing Cursor API key`).

### Two different secrets (conceptual)

| Secret                 | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| Cursor API key         | Authenticates **to Cursor** for agent execution                 |
| Gateway token (future) | Would authenticate **to this gateway** before any provider work |

Today only the Cursor key path is active.

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
