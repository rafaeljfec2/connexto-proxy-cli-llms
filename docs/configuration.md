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

| Variable                           | Default                            | Description                                                                                                                                                                                                                                          |
| ---------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                             | `127.0.0.1`                        | Bind address. Use loopback unless you understand exposure risks.                                                                                                                                                                                     |
| `PORT`                             | `3000`                             | TCP port.                                                                                                                                                                                                                                            |
| `GATEWAY_API_TOKEN`                | unset                              | Primary gateway credential. Required for non-loopback binding (unless `GATEWAY_API_TOKENS` is set); optional in loopback-only mode. Each distinct credential receives its own consumer identity with isolated stored Responses and session affinity. |
| `GATEWAY_API_TOKENS`               | unset                              | Optional comma-separated list of additional gateway credentials (independent consumer identities). Repeated entries are deduplicated at startup. A value equal to `GATEWAY_API_TOKEN` or `CURSOR_API_KEY` fails startup.                             |
| `CORS_ORIGINS`                     | unset                              | Comma-separated browser origins. Invalid values and wildcards fail startup.                                                                                                                                                                          |
| `LOG_FORMAT`                       | `json`                             | `json` (NDJSON) or `pretty` (colorized terminal via `pino-pretty`).                                                                                                                                                                                  |
| `LOG_LEVEL`                        | `info`                             | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent`.                                                                                                                                                                            |
| `LOG_HTTP_PAYLOADS`                | `true`                             | Log inbound/outbound HTTP JSON bodies (`http payload` events). Set `false` to disable.                                                                                                                                                               |
| `LOG_HTTP_PAYLOAD_MAX_BYTES`       | `262144`                           | Truncate logged bodies larger than this many UTF-8 bytes.                                                                                                                                                                                            |
| `GATEWAY_JSON_BODY_LIMIT_BYTES`    | `33554432`                         | Maximum JSON request body size accepted by `express.json()` (32 MiB). Codex/Composer clients with large tool schemas need this headroom; lower only if you intentionally cap ingress.                                                                |
| `CURSOR_DEFAULT_WORKING_DIRECTORY` | unset                              | Absolute path used as Cursor SDK `local.cwd` when requests do not carry a tool-context working directory. Set to `/workspace` in Docker Compose (see below). Startup fails if the path is configured but missing.                                    |
| `RESPONSE_TTL_MS`                  | `3600000`                          | TTL for terminal stored Responses (1 hour). In-flight Responses are pinned until the HTTP handler finishes.                                                                                                                                          |
| `RESPONSE_MAX_ENTRIES`             | `512`                              | Maximum stored Responses kept in memory. Active pins and running handlers are never evicted.                                                                                                                                                         |
| `SESSION_TTL_MS`                   | `86400000`                         | TTL for inactive Cursor and Antigravity session affinity records (24 hours). Sessions referenced by active executions are skipped.                                                                                                                   |
| `SESSION_STORAGE_DRIVER`           | `filesystem`                       | Storage driver for provider session persistence (`filesystem` or `memory`).                                                                                                                                                                          |
| `SESSION_STORAGE_PATH`             | `/var/lib/connexto-proxy/sessions` | Directory path for filesystem session storage adapter. Created automatically with restricted permissions (`0700`/`0600`). On loopback `HOST`, if the default path is not writable, `loadEnv` falls back to `~/.connexto-proxy/sessions` (see `.env.example`). |
| `LIFECYCLE_CLEANUP_INTERVAL_MS`    | `60000`                            | Interval for the in-process cleanup timer (1 minute). Uses `setInterval` with `unref()` so it does not keep the process alive alone.                                                                                                                 |

**Cursor local agent (ripgrep):** the SDK runs `rg` with flags such as `--no-require-git`, which **ripgrep 11.x** (`/usr/bin/rg` on many WSL installs) does not support. On startup the API prepends `@vscode/ripgrep` to `PATH`. Optional override: `RIPGREP_PATH=/full/path/to/rg`.

### Local development example

```env
HOST=127.0.0.1
PORT=3000
GATEWAY_API_TOKEN=
LOG_FORMAT=pretty
LOG_LEVEL=debug
```

Without `CORS_ORIGINS`, loopback binding allows browser origins whose host is `localhost` or a loopback IP. Set `CORS_ORIGINS` to an explicit list to replace that local policy, or set it to an empty value to disable browser CORS. Origin-less CLI and server-to-server calls continue normally. If a gateway token is configured, private endpoints require it even on loopback.

For a local browser application on port 5173, configure an exact origin when you want to replace the default local policy:

```env
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

### Container / production-style example

```env
HOST=0.0.0.0
PORT=3000
GATEWAY_API_TOKEN=<set-a-random-secret>
CORS_ORIGINS=https://app.example.com,https://admin.example.com
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

`CORS_ORIGINS` accepts a comma-separated list of HTTP(S) origins, including scheme and optional port. Host casing, default ports, and one trailing root slash are normalized; duplicates are removed. Non-root paths, query strings, fragments, credentials, wildcards, non-HTTP(S) schemes, malformed values, and empty entries are rejected at startup. Add one exact origin per browser application; its port and scheme are part of the origin.

When `GATEWAY_API_TOKEN` is set, send it in the dedicated `X-Gateway-API-Key` header. It is checked independently from the Cursor credential. The gateway does not accept the token from a query string, `Authorization`, or `x-api-key`.

```http
X-Gateway-API-Key: <GATEWAY_API_TOKEN>
Authorization: Bearer <CURSOR_API_KEY>
```

When gateway authentication is enabled, the public endpoints are `GET /`, `GET /v1`, `GET /health`, `GET /v1/models`, and `GET /v1/models/:model`. All other application routes require the gateway token. Without a token, loopback binding remains the trusted local-only boundary. A permitted CORS preflight is handled before authentication because it does not access application data; the resulting request still requires normal gateway authentication. CORS is a browser access policy, not authentication.

If `Origin` is absent, the API sends no CORS authorization headers and handles the request under its normal route and authentication rules. A disallowed origin is never reflected in `Access-Control-Allow-Origin`. Preflight requests from an allowed origin must use an allowed API method and request headers; unsupported preflights receive `403`, and successful preflights grant only the requested method and allowed requested headers. The API does not enable cookies or `Access-Control-Allow-Credentials`.

Preflight methods are `GET`, `POST`, `DELETE`, and `OPTIONS`. Allowed request headers are `authorization`, `content-type`, `x-api-key`, `x-gateway-api-key`, `idempotency-key`, `x-session-affinity`, `x-opencode-session-id`, `x-opencode-session`, and `x-request-id`.

## Authentication

Provider routes (chat, completions, responses, etc.) resolve the **Cursor API key** via `resolveRequestApiKey()` in `apps/api/src/utils/auth.ts`:

1. **`Authorization: Bearer <token>`** — token must not be `local` or `dummy` (compatibility placeholders).
2. **`x-api-key: <token>`** — same rules.
3. **`process.env.CURSOR_API_KEY`** — trimmed; used if headers did not yield a key **and** the request omits `X-Gateway-API-Key` (direct local clients). When `X-Gateway-API-Key` is set (for example AI Hub), the Cursor key must be sent in `Authorization` or `x-api-key`; the environment fallback is not used.

If no key is resolved, endpoints that call Cursor return **401** with an OpenAI-style error payload (`Missing Cursor API key`).

### Separate credentials

| Secret         | Purpose                                                         |
| -------------- | --------------------------------------------------------------- |
| Cursor API key | Authenticates **to Cursor** for agent execution                 |
| Gateway token  | Authenticates **to this gateway** before private route handling |

Keep the values different. A gateway token sent only in `X-Gateway-API-Key` is never treated as a Cursor key. With `X-Gateway-API-Key`, `Authorization` or `x-api-key` must carry the Cursor key. Without that header, direct local clients may still use the configured `CURSOR_API_KEY` fallback.

## Session affinity

Responses and chat flows accept session headers used by OpenCode-compatible clients (see `apps/api/src/utils/session.ts`), for example:

- `x-session-affinity`
- `x-opencode-session-id`
- `x-opencode-session`

These map to gateway `sessionId` values passed into the Cursor provider for resume/create behavior.

## CORS

The API does not use wildcard CORS. With a loopback `HOST` and no `CORS_ORIGINS`, the local policy permits only HTTP(S) origins on `localhost` or loopback IP addresses. An explicit `CORS_ORIGINS` list replaces that policy. A remote bind has no browser origins allowed unless they are explicitly listed. Origin-less CLI and server-to-server requests continue to work and remain subject to gateway authentication.

## Further reading

- [logging.md](logging.md) — log fields and redaction
- [security/SECURITY-AUDIT.md](security/SECURITY-AUDIT.md) — exposure and backlog items
