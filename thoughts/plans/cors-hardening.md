# CORS Hardening — Plan

## Intent

Replace wildcard CORS authorization with validated, explicit origins while preserving local browser development, origin-less CLI/server-to-server use, and the existing gateway authentication boundary.

## Constraints

- Change only the CORS complement to AUD-02; do not start security phases 2–5.
- No provider calls, dependency changes, cookies, or `Access-Control-Allow-Credentials`.
- Keep `X-Request-ID` exposed and preserve the API's required request headers and methods.
- Invalid `CORS_ORIGINS` must fail environment loading with a stable error that does not echo values.
- Remote binds must not inherit the local loopback-origin policy.

## Decisions

- `CORS_ORIGINS` is an optional comma-separated allowlist of HTTP(S) origins. Normalize host casing, default ports, and one trailing slash; reject wildcard, credentials, paths, query, fragment, empty list entries, and non-HTTP(S) schemes. Deduplicate normalized values.
- If the variable is absent and `HOST` is loopback, use a documented local policy accepting HTTP(S) origins whose host is `localhost` or an IP in loopback space. This keeps local browser clients usable without configuration.
- If the variable is explicitly empty, allow no browser origin. If `HOST` is remote and the variable is absent or empty, allow no browser origin.
- A configured list is exact and overrides the local policy. Unknown or malformed origins never receive `Access-Control-Allow-Origin`.
- All responses vary on `Origin`; preflight responses also vary on requested method and headers so caches keep variants separate. Origin-less requests receive no CORS authorization headers and continue through the existing gateway-auth and route pipeline. Origin-less `OPTIONS` keeps the existing empty `204` behavior without CORS authorization headers.
- Allowed non-preflight responses receive their exact origin value, `Vary: Origin`, and `Access-Control-Expose-Headers: X-Request-ID`.
- A valid preflight from an allowed origin receives `204` only when its requested method and headers are on the API allowlist. It returns only the origin, method, and header permissions needed for that preflight. Other preflights receive `403` and no `Access-Control-Allow-*` headers. Preflight itself does not access route data; the subsequent request still requires gateway authentication.

## Acceptance criteria

- [x] Local loopback origins are allowed by the implicit local policy; non-loopback origins are not.
- [x] A remote origin explicitly configured in `CORS_ORIGINS` is allowed.
- [x] An explicit list supports multiple normalized and deduplicated HTTP(S) origins.
- [x] Wildcards, malformed values, non-origin URL components, and empty list entries fail configuration loading.
- [x] Explicitly empty configuration disables origins; remote binding without a list also allows none.
- [x] Requests without `Origin` keep normal route and gateway-auth behavior and receive no CORS authorization.
- [x] Allowed preflight verifies requested method and requested headers and returns only required headers.
- [x] Disallowed origins, methods, or headers do not receive CORS authorization.
- [x] No response uses `Access-Control-Allow-Origin: *` or `Access-Control-Allow-Credentials`.
- [x] `X-Gateway-API-Key` remains an allowed request header; `X-Request-ID` remains exposed on permitted responses.
- [x] CORS permission does not bypass gateway authentication.
- [x] Configuration, API docs, and `.env.example` describe local and remote behavior.

## Implementation tasks

- [x] Add failing environment tests for default/empty settings, normalization, multiple origins, and invalid entries. Red run: parser expectations failed because the setting was ignored.
- [x] Add failing HTTP tests for local and configured remote origins, no `Origin`, denied origins, preflight method/header validation, required headers, and gateway-auth independence. Red run: wildcard authorization and unchecked preflights failed the new assertions.
- [x] Tighten the preflight response to grant only the requested allowed method and request headers. TDD red run: the previous response returned all methods and headers; the focused Supertest assertion failed before the middleware change.
- [x] Implement origin parsing and environment integration.
- [x] Implement centralized CORS middleware and replace the inline wildcard middleware.
- [x] Update prior preflight expectations to use a permitted browser origin and assert no wildcard.
- [x] Update `.env.example`, `docs/configuration.md`, and `docs/api.md`.
- [x] Run targeted tests after each behavior change, then the full offline suite, typecheck, lint, build, formatting, and diff checks. Final offline suite: 214 passed, 2 skipped; typecheck, lint, build, Prettier, and `git diff --check` passed. Final focused HTTP suite: 52 passed.
- [x] Perform the final `senior-code-review-judge` pass and record evidence in AI Memory. Verdict: `APPROVED_WITH_NOTES`; no open code findings, with Snyk Code unavailable.

## Verification limits

- `tests/api.integration.test.ts` was excluded to avoid live Cursor calls.
- Snyk Code reported `SNYK-CODE-0005`. The user authorized enabling it for this scan, but the integration's activation request to the organization settings API returned `404 Not Found`; SAST findings are unavailable until an administrator enables the feature manually.

## External references

- RPI process: https://blog.codedimension.com.br/post/rpi-research-plan-implement-com-ia-e-openspec/
- MDN CORS guidance on origin allowlists, preflight, and `Vary: Origin`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS

## Research quality

- **Factual:** Current wildcard headers, `204` preflight behavior, environment schema, auth middleware order, and existing test expectations were verified in the repository.
- **Actionable:** The changed runtime, configuration, tests, and documentation boundaries are named above.
- **Relevant:** Scope is limited to the CORS portion of AUD-02.

## Plan quality

- **Feasible:** Uses the existing Zod environment schema, Express middleware, Supertest, and workspace scripts.
- **Atomic:** Tests precede parser, middleware, docs, and final validation changes.
- **Clear:** Empty/unset, local/remote, origin, method, and header behaviors are distinguished.
- **Testable:** Each security property has an observable HTTP response or environment parse result.
- **Scoped:** No authentication redesign or other audit finding is included.
