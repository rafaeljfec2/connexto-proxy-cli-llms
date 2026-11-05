# Security Audit — Connexto Proxy CLI LLMs

**Audit date:** 2026-11-05  
**Status:** Completed for source review and safe offline validation. No production code was changed.  
**Overall risk:** Medium. No Critical or High finding was confirmed.

## Executive Summary

The Pino request and provider logs currently use a small set of explicit fields. The inspected request paths do not log request headers, prompts, model output, cookies, or complete provider errors. The existing logging test captures emitted log records and verifies that a bearer token and prompt are absent from one streaming chat request. Pino itself has no configured redaction rules, so this property depends on call-site discipline.

The most direct data exposure occurs outside Pino: with `NODE_ENV` unset or set to a non-production value, Express's default error handler returns a stack trace for malformed JSON and writes the parser error, including the raw request body, to stderr. An offline reproduction confirmed both behaviors. Other confirmed concerns are missing gateway-level authorization when the service is reachable beyond loopback, raw provider error messages returned to clients, and provider streams continuing after the client disconnects.

The default bind address is `127.0.0.1`, which limits network exposure unless `HOST` is changed. `HOST` is configurable, and the API also accepts `CURSOR_API_KEY` as a fallback credential for any request. CORS is permissive for every origin. These conditions make deployment configuration material to the risk.

## Scope and Limitations

Inspected the API bootstrap, environment schema, logger, server lifecycle, every Express route, request utilities, gateway service wiring, response storage, Cursor provider/session code, the exported Cursor engine image-fetch path, OpenAI-compatible request preparation, logging and environment tests, `.env.example`, and `docs/logging.md`.

No `.env` contents or secret values were read, printed, or recorded. No live Cursor calls were made. Tests that can call Cursor using a configured key were excluded. The malformed-body, provider-error, stream-cancellation, and image-fetch checks used synthetic values and local mocks only.

The Snyk SCA tool did not scan the project because it reported that the folder is not trusted. Its trust operation explicitly requires authorization, so it was not invoked. `pnpm audit` was used for dependency vulnerability evidence instead. A live Cursor provider error and cross-account session-resume behavior remain unverified because they would require external calls.

## Methodology

- Traced request data from HTTP input through route preparation, provider invocation, logs, errors, and response serialization.
- Inspected all logger call sites and tested emitted records rather than relying on the logging documentation alone.
- Used source tracing and offline mock providers for error and disconnect behavior. A mocked fetch was used for the legacy image helper; it made no network request.
- Ran the automated test suite with both live-provider integration files excluded, then ran typecheck, lint, build, and dependency audits.
- Reported a vulnerability only where a concrete path was found. Conditional and currently unreachable paths are labelled as such.

## Surface Inventory

| Surface         | Effective behavior                                                                                                               | Security notes                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listener        | `server.ts` binds `HOST` and `PORT`; defaults are `127.0.0.1:3000`                                                               | A non-loopback `HOST` exposes the unauthenticated API to reachable clients.                                                                        |
| HTTP routes     | Metadata, health, models, chat completions, completions, Responses create/read/delete/input-items/cancel/compact/token endpoints | There is no global gateway authentication middleware. Provider routes resolve a Cursor key directly. Response lifecycle routes do not check a key. |
| Request parsing | `express.json()` with Express's default 100 KB limit                                                                             | There is no application error middleware after the JSON parser.                                                                                    |
| CORS            | `Access-Control-Allow-Origin: *`; allows `authorization` and `x-api-key`                                                         | Any origin can make browser requests where the browser permits access to the target host.                                                          |
| Logging         | Pino JSON by default; optional colorized `pino-pretty`                                                                           | No Pino `redact` configuration. Request logging is currently field-by-field and avoids bodies and headers.                                         |
| Cursor provider | Incoming bearer, `x-api-key`, or `CURSOR_API_KEY` environment fallback                                                           | The gateway does not authenticate callers separately from the provider credential.                                                                 |
| Session state   | Cursor agent sessions are stored by session ID; Responses are stored in a process-wide bounded map of 512 entries                | Session IDs and stored response IDs are not bound to an authenticated gateway principal.                                                           |
| Image engine    | Exported legacy engine fetches HTTP(S) image URLs                                                                                | Source path exists in the provider package, but the active Express handlers pass prompt text only and do not reach this helper.                    |

The route preparation code validates request shapes, and `express.json()` applies Express's default 100 KB body limit. No explicit rate limiter, request concurrency cap, application timeout, or common security-header middleware was found in `app.ts`. These are hardening recommendations for any deployment reachable by multiple users; no standalone exploit was demonstrated for these omissions.

## Findings

### AUD-01 — Malformed JSON exposes parser body and stack through Express defaults

**Severity:** MEDIUM  
**Status:** Confirmed at runtime when `NODE_ENV` is unset or non-production  
**Files:** `apps/api/src/app.ts:12-20,53-79`

The JSON parser is installed after request logging, but the app defines no error middleware to convert parser errors into a safe response. Express's default handler returns a stack trace for malformed JSON in development mode and emits the parser error to stderr. The parser error retains the raw body.

**Reproduction:** With `NODE_ENV` unset, POST malformed JSON such as `{"prompt":"SENSITIVE_AUDIT_MARKER", broken}` with `Content-Type: application/json`. A local Supertest harness returned HTTP 400 with `SyntaxError` in the response and captured `SENSITIVE_AUDIT_MARKER` in stderr. No provider was called. The real marker used was synthetic.

**Impact:** Request content can be retained in process logs outside Pino, and the response reveals stack paths. This bypasses the structured logging discipline and can include prompt or other request data when malformed payloads contain it.

**Probability:** Medium when `NODE_ENV` is unset or non-production. `server.ts` does not set `NODE_ENV`, and `.env.example` does not define it.

**Recommendation:** Add a final Express error handler that maps parser errors to a bounded client error, logs only a safe classification and request ID, and never logs the parser's `body` property. Set production mode explicitly in deployed environments.

**Correction test:** Send malformed JSON containing a unique marker with `NODE_ENV` unset and production. Assert that neither response nor captured stdout/stderr contains the marker, stack, or filesystem paths, while the response retains the request ID header.

### AUD-02 — No gateway authorization protects provider use or stored Responses

**Severity:** MEDIUM  
**Status:** Confirmed code path; external impact depends on listener exposure  
**Files:** `apps/api/src/app.ts:53-76`, `apps/api/src/config/env.ts:20-25`, `apps/api/src/server.ts:14-20`, `apps/api/src/utils/auth.ts:3-24`, `apps/api/src/routes/responses/lifecycle.ts:10-45`, `.env.example:5-6`

There is no authentication middleware in `buildApp`. Provider routes accept a caller's bearer token or `x-api-key`, then fall back to the process `CURSOR_API_KEY`. Therefore, if `HOST` is set to a non-loopback address and `CURSOR_API_KEY` is configured, a reachable client can submit a provider request without presenting a gateway credential. CORS additionally allows every origin and permits both credential headers. `.env.example` lists `GATEWAY_API_TOKEN`, but the environment schema and request authentication code do not consume it.

The Responses GET, input-items, and DELETE handlers also access the global response store without checking any credential. Response IDs are UUID-based and difficult to guess, which reduces enumeration risk, but anyone who obtains an ID can read stored input/output items or delete the response.

**Reproduction:** Set `HOST=0.0.0.0` and configure `CURSOR_API_KEY`, then POST a valid request without Authorization or `x-api-key`. The route resolves the environment key and invokes the provider. This path is established by code; a live provider request was intentionally not made. Existing tests verify only that a request without any Cursor key is rejected.

**Impact:** Unauthorized use of the operator's Cursor quota and access to stored response data when its ID is disclosed. A malicious website may also invoke the service from a browser when network/browser policy permits reaching the configured host.

**Probability:** Low with the default loopback bind and a developer-only process; medium when configured for LAN or public access.

**Recommendation:** Require a separate gateway credential before processing provider and response lifecycle routes, make `GATEWAY_API_TOKEN` effective if retained, bind CORS to approved origins, and bind stored response ownership to the authenticated principal. Keep loopback as the default.

**Correction test:** With `CURSOR_API_KEY` configured but no valid gateway credential, assert provider routes and stored response reads/deletes are rejected. Verify valid credentials are isolated by principal and CORS rejects unapproved origins.

### AUD-03 — Client disconnects do not cancel provider streams

**Severity:** MEDIUM  
**Status:** Confirmed with a local mock provider  
**Files:** `apps/api/src/routes/chat-completions.ts:68-99`, `apps/api/src/routes/completions.ts:59-95`, `apps/api/src/routes/responses/create.ts:78-118`, `packages/core/src/contracts/execution.ts:3-10`, `packages/providers/cursor/src/provider.ts:149-160`

The runtime contract supports an `AbortSignal`, and the Cursor provider cancels its run when that signal aborts. The HTTP routes do not create or pass a signal and do not stop consuming the event stream when the response closes. The request summary's `close` listener only logs completion.

**Reproduction:** A local HTTP client disconnected after the first SSE bytes while a mocked provider yielded three deltas. All three provider events were still produced and `run.cancel()` was not called. No external provider was used.

**Impact:** Disconnected clients can leave provider work running and consume quota, connections, and process resources. Repeated requests can amplify this availability and cost impact.

**Probability:** Medium for clients or intermediaries that commonly cancel or time out streaming requests.

**Recommendation:** Create an `AbortController` per request, pass its signal to `executor.execute`, and abort when the response closes before normal completion. Stop writing and draining events after cancellation and ensure the provider run is cancelled once.

**Correction test:** Disconnect a mocked SSE client after its first delta. Assert the provider is cancelled once, no later deltas are consumed, and concurrent requests remain unaffected.

### AUD-04 — Provider error text is returned without sanitization

**Severity:** LOW  
**Status:** Confirmed message pass-through; sensitive contents depend on the provider error  
**Files:** `apps/api/src/utils/logger.ts:18-31`, `apps/api/src/utils/run.ts:16-27`, `apps/api/src/routes/chat-completions.ts:185-200`, `apps/api/src/routes/completions.ts:171-185`, `apps/api/src/routes/responses/create.ts:218-232`, `apps/api/src/routes/responses/tokens-compact.ts:67-70`, `packages/providers/cursor/src/errors.ts:15-58`, `packages/providers/cursor/src/engine/auth-api.ts:124-133,150-163`

Route catches return `safeErr.message` to the client. `toSafeError` preserves the original `Error.message`; failed runs return `result.error.message`; the token-compaction handler returns `error.message` directly. The Cursor error normalizer also preserves SDK error messages, and upstream HTTP errors can derive a message from the response body. Request error logs generally include only type and code, so this is a response exposure, not a demonstrated Pino leak.

**Reproduction:** Replace the provider with a local mock that throws `Error("UPSTREAM_INTERNAL_MARKER")`, then POST to `/v1/chat/completions`. The route returned HTTP 500 and the marker in `error.message`. No external provider was used.

**Impact:** Internal paths, account details, or other provider diagnostics could reach API clients if the upstream error contains them. No real Cursor error body was inspected, so exposure of a particular secret is unconfirmed.

**Probability:** Low; depends on the contents of provider or SDK error messages.

**Recommendation:** Return a stable generic message and safe error code to callers. Keep upstream detail in a separately reviewed, sanitized diagnostic channel if operationally required.

**Correction test:** Inject errors containing synthetic credentials, URLs, and multiline text through every provider route. Assert these values are absent from HTTP responses and emitted logs.

### AUD-05 — Caller-controlled session affinity is not bound to a principal

**Severity:** MEDIUM  
**Status:** Potential cross-session exposure; no external provider validation was performed  
**Files:** `apps/api/src/utils/session.ts:3-13`, `apps/api/src/routes/chat-completions.ts:66-77`, `apps/api/src/routes/responses/create.ts:76-89`, `packages/providers/cursor/src/sessions.ts:13-47`, `packages/providers/cursor/src/provider.ts:85-115`

`x-session-affinity` and `x-opencode-session` are accepted without validation and used as the session map key. The shared `CursorSessionManager` indexes sessions only by that string, not by a gateway identity or credential. The environment key fallback can make requests from multiple callers use the same Cursor account. If two callers use the same known affinity value, the second request can resume the agent associated with the first value.

**Evidence and uncertainty:** The local session map and resume path are confirmed. Whether a resumed Cursor agent exposes prior context in a caller-visible way depends on provider behavior and was not tested with a live account.

**Impact:** Potential conversation context mixing between callers that share a Cursor credential and affinity ID.

**Probability:** Low to medium; requires a shared Cursor account and an affinity value reused or disclosed across callers.

**Recommendation:** Authenticate callers and scope session keys to a stable principal or credential identity. Prefer server-issued opaque session IDs and validate accepted header length and format.

**Correction test:** With a mocked session manager, submit identical affinity values under two principals and assert they map to separate remote agent records. Add a provider integration test only when an approved test account is available.

### AUD-06 — Exported image engine can fetch arbitrary HTTP(S) URLs

**Severity:** LOW  
**Status:** Conditional library-path risk; not reachable from the current Express route path  
**Files:** `packages/providers/cursor/src/engine/images.ts:10-43,46-88`, `packages/providers/cursor/src/engine/stream.ts:40-48`, `packages/providers/cursor/src/cursor.ts:22-28`, `packages/providers/cursor/src/index.ts:19-22`, `apps/api/src/routes/chat-completions.ts:72-76`, `packages/providers/cursor/src/provider.ts:101-105`

The exported `createCursorCompletion` engine accepts image URLs and calls `fetchImageBytes`. The helper accepts any parsed `http:` or `https:` URL, follows the platform fetch redirect behavior, does not reject loopback, private, or link-local destinations, and buffers the complete response before `resolveCursorImages` checks its 1 MB limit. A mocked fetch to `http://127.0.0.1:9/internal` was accepted and returned image bytes without making a network request.

The current Express handlers pass `prepared.prompt.text` to the executor. The active `CursorProvider.execute` passes only `input.message` to `agent.send`, so the HTTP routes do not reach this legacy image helper. This finding is conditional on another caller using the exported engine API or future HTTP wiring.

**Impact:** For consumers of the exported engine API, a caller-controlled image URL could target internal services. Large or slow responses could also consume memory or hold resources before the post-buffer limit is applied.

**Probability:** Low in the current gateway; higher if the engine API is wired to untrusted HTTP image inputs.

**Recommendation:** Before exposing this path to HTTP, enforce destination policy after DNS resolution and every redirect, reject loopback/private/link-local ranges, bound redirects and time, and enforce byte limits while streaming the body.

**Correction test:** Use local mock DNS/HTTP responders for loopback, private, link-local, redirect-to-private, oversized, and slow responses. Assert prohibited requests are blocked before body buffering.

### AUD-07 — Vulnerable development dependency `minimatch`

**Severity:** MEDIUM (dependency advisory; development tooling only)  
**Status:** Confirmed by `pnpm audit`  
**Files:** `pnpm-lock.yaml`; dependency path through `typescript-eslint` / `@typescript-eslint/typescript-estree`

The full audit found one moderate advisory, GHSA-g3hv-75wg-m249, for `minimatch` versions `>=7.0.0 <11.0.1`. The resolved version on the affected path is `10.2.6`. `pnpm why minimatch` shows the affected path under the root development dependency `typescript-eslint`; a separate `minimatch@3.1.5` is also present and is outside the advisory range. `pnpm audit --prod` found no known production dependency vulnerabilities.

**Impact:** The advisory describes potential denial of service through globparts amplification when the vulnerable package processes attacker-controlled patterns. The package is used by development tooling, not the production gateway request path.

**Probability:** Low for production runtime; depends on untrusted patterns being processed in development or CI tooling.

**Recommendation:** Update the compatible `typescript-eslint` dependency tree or use a reviewed package-manager override to resolve the affected path to `minimatch >=11.0.1`. Confirm compatibility and run the full audit again.

**Correction test:** Run `pnpm why minimatch` and `pnpm audit`; verify the affected path is patched and the audit no longer reports GHSA-g3hv-75wg-m249.

### AUD-08 — No explicit rate limits or standard security headers

**Severity:** INFO  
**Status:** Hardening recommendation; no standalone vulnerability confirmed  
**Files:** `apps/api/src/app.ts:12-79`, `apps/api/src/config/env.ts:20-25`

The Express setup has no explicit rate limiter, concurrent provider-run limit, request timeout, or middleware for common headers such as `X-Content-Type-Options` and `Referrer-Policy`. The JSON parser uses its framework default body-size limit of 100 KB, which provides a basic bound but not a provider concurrency limit.

**Impact:** When deployed for multiple users, a reachable client can submit requests as quickly as the service and provider permit. Browsers and downstream proxies also receive fewer defensive response headers.

**Probability:** Low for a single-user loopback process; higher for a shared or non-loopback deployment.

**Recommendation:** After establishing an authenticated deployment boundary, add rate and concurrency controls appropriate to provider quotas, explicit timeouts, and a small set of headers that fit this API's response behavior.

**Correction test:** Exercise rate and concurrency limits with mocked providers and assert rejected requests do not start provider runs. Assert the selected response headers on success and error responses.

## Logging, Request IDs, and Streaming Assessment

### Logging and redaction

- `createLogger` configures Pino level and format but does not set `redact` or request serializers (`apps/api/src/utils/logger.ts:33-57`). The current route log calls enumerate safe fields and do not pass `Request`, `Response`, headers, prompts, model output, or complete errors.
- `tests/logging.test.ts:126-163` captures actual Pino output and asserts that a bearer token and prompt are absent for one streaming chat completion. It does not cover cookies, `x-api-key`, all routes, malformed JSON, upstream failures, image data, or stream cancellation.
- A manual Pino check emitted zero bytes at `LOG_LEVEL=silent`. `LOG_FORMAT=pretty` enables `colorize: true` and human-formatted timestamps (`logger.ts:47-53`); this is operationally unsuitable for machine-parsed production logs and can introduce terminal escape sequences. No direct sensitive-data leak from `pretty` was demonstrated.
- No direct `console.*` logging calls were found in application source. The confirmed stderr path in AUD-01 comes from Express's default error handler.
- The logging documentation claims safe error fields (`docs/logging.md:96-104`), but malformed parser errors bypass that policy.
- No prompt, response, credential, cookie, or complete request/response object was found in normal Pino call sites. The absence of Pino redaction remains a regression risk rather than a demonstrated leak in those call sites.

### Request IDs

- The middleware always creates a server-side UUID and ignores the client-supplied `X-Request-ID` (`apps/api/src/app.ts:15-20`). An existing test confirms a custom value is not reflected (`tests/logging.test.ts:79-86`). This prevents client-controlled log correlation IDs and header injection through this field.
- The middleware stores the ID in request-local `res.locals`, sets the response header, and closes over the same ID for the completion log (`app.ts:18-20,35-43`). Provider route logs use that same value. SSE responses retain the header and provider stream log correlation.
- Error JSON does not include the ID in its body, but the response header remains available. Provider SDK/upstream requests generate their own internal IDs; the gateway ID is not propagated as an upstream request ID.
- Request ID state is created within each middleware invocation, so concurrent requests do not share a mutable global correlation value. No dedicated concurrency stress test was present.

### Streaming and cancellation

SSE event payloads include generated output by design, but the inspected stream loops do not log deltas or accumulated output. The concrete streaming issue is resource cancellation: route loops continue after client disconnect, as demonstrated in AUD-03. There was no evidence of response-store data crossing requests through the request ID mechanism. Session affinity and stored Responses are covered separately in AUD-02 and AUD-05.

## Validation Evidence

| Command or check                                                                                                                        | Exit/result                                                                                 | Notes                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `rtk pnpm exec vitest run --exclude tests/api.integration.test.ts --exclude packages/providers/cursor/tests/cursor.integration.test.ts` | Exit 0; 20 files passed, 170 tests passed                                                   | Excluded tests that can call the real Cursor provider when a key is configured.         |
| `rtk pnpm typecheck`                                                                                                                    | Exit 0; no TypeScript errors                                                                | Includes workspace and test typechecks.                                                 |
| `rtk pnpm lint`                                                                                                                         | Exit 0                                                                                      | ESLint completed.                                                                       |
| `rtk pnpm build`                                                                                                                        | Exit 0                                                                                      | Workspace build completed; API TypeScript build reported `Done`.                        |
| `rtk pnpm audit --prod`                                                                                                                 | Exit 0; no known vulnerabilities                                                            | Production dependency tree only.                                                        |
| `rtk pnpm audit`                                                                                                                        | Exit 1; one moderate vulnerability                                                          | Affected `minimatch@10.2.6` path is development tooling.                                |
| Snyk SCA MCP scan                                                                                                                       | Not run; tool rejected the untrusted folder                                                 | Did not invoke the separate trust operation because it requires explicit authorization. |
| Malformed JSON local reproduction                                                                                                       | HTTP 400; response contained stack; captured stderr contained synthetic request-body marker | `NODE_ENV` unset; no provider call.                                                     |
| Provider error local reproduction                                                                                                       | HTTP 500; response contained synthetic provider error marker                                | Mock provider only; no external call.                                                   |
| SSE disconnect local reproduction                                                                                                       | Three mocked events produced after disconnect; `run.cancel()` was not called                | Local loopback server and mock provider only.                                           |
| Pino silent-level check                                                                                                                 | Zero output bytes                                                                           | Emitted info and error at `level: "silent"`.                                            |
| Exported image helper mock                                                                                                              | Passed `http://127.0.0.1:9/internal` to mocked fetch and returned three bytes               | Mock fetch only; no network call.                                                       |

## False Positives and Discarded Hypotheses

- **Client-controlled request ID injection:** Not present. The application ignores the incoming value and generates a UUID. The existing test verifies that behavior.
- **Prompts and bearer credentials in normal Pino route logs:** Not observed. Current fields are selected explicitly, and the emitted-log test checks the streaming chat path. The parser error path is a separate Express stderr leak and remains a finding.
- **SSRF through current `/v1` image requests:** Not demonstrated. Although the exported legacy engine helper fetches arbitrary HTTP(S) URLs, the active Express route passes prompt text only and does not call that helper. AUD-06 records the conditional exported-library risk without claiming that the current HTTP routes are exploitable through images.
- **Cross-session data disclosure from Cursor resume:** Not confirmed. The caller-controlled session key reaches a shared session map, but actual provider behavior was not validated against a live account.
- **Production dependency vulnerability:** Not found by `pnpm audit --prod`. The full audit finding is confined to the development dependency tree.

## Prioritized Correction Plan

1. **P1 — Close the gateway access boundary.** Decide whether the service is strictly local or shared. Require a gateway credential for provider and stored-response routes when shared, consume or remove the unused `GATEWAY_API_TOKEN` setting, constrain CORS, and bind stored records to the authenticated caller.
2. **P1 — Handle Express errors safely.** Add a final parser/error handler, prevent stack/body output from reaching HTTP responses or stderr, and set `NODE_ENV=production` explicitly in deployed environments.
3. **P1 — Cancel provider runs on disconnect.** Pass request-scoped abort signals through all streaming and non-streaming routes and stop consuming the run after the response closes.
4. **P2 — Sanitize provider errors.** Return stable public error messages and retain only reviewed classifications/codes in logs and responses.
5. **P2 — Isolate session affinity.** Require caller identity and namespace affinity IDs by that identity; use server-issued opaque identifiers where possible.
6. **P2 — Patch the development dependency tree.** Resolve the affected `minimatch` path to `>=11.0.1`, verify the lockfile, and rerun audit and tooling checks.
7. **P3 — Add API resource controls and response headers for shared deployments.** Test request and provider limits without external calls.
8. **P3 — Harden the exported image engine before exposing it to HTTP.** Add destination, redirect, timeout, and streaming byte limits, then test SSRF destinations with local mocks.

## Audit Conclusion

The source scope, primary data exposure paths, request correlation, SSE cancellation behavior, configuration, and available dependency findings were inspected. Offline reproductions and automated checks are recorded above. The audit is complete for the requested no-provider-call constraint; validation of real Cursor error contents and live session ownership remains intentionally outside the executed scope.
