# CORS Hardening — Research

## Scope

This research covers only the CORS complement to security finding AUD-02. Gateway authentication is already implemented. No code or behavior is changed by this research document.

## Observed behavior

- `apps/api/src/app.ts` sets `Access-Control-Allow-Origin: *` on every request.
- The same inline middleware always sends the allowed-method, allowed-header, and exposed-header lists. Its header list includes `x-gateway-api-key`; it exposes `X-Request-ID`.
- Every `OPTIONS` request currently receives `204` before gateway authentication, regardless of `Origin` or requested method and headers.
- `apps/api/src/config/env.ts` validates `HOST`, `PORT`, `GATEWAY_API_TOKEN`, and logging settings. It has no `CORS_ORIGINS` setting.
- `buildApp` receives `HOST` and `GATEWAY_API_TOKEN`; application middleware applies CORS before gateway authentication.
- Gateway authentication protects private application routes when configured. Its preflight exception returns before route handlers and does not expose application data.
- `tests/composer-api.test.ts` expects an `OPTIONS` request without `Origin` to receive `204` and a wildcard origin header.
- `tests/gateway-auth.test.ts` covers a preflight without `Origin` and expects `x-gateway-api-key` in the response.
- `tests/logging.test.ts` expects CORS exposure headers on a response without an `Origin` header.
- `docs/configuration.md` describes wildcard CORS and delegates restriction to a reverse proxy. `docs/api.md` describes all routes as supporting `OPTIONS` with `204`.
- `.env.example` lists the gateway and provider credentials but has no CORS setting.

## Relevant files and boundaries

- Runtime: `apps/api/src/app.ts`, `apps/api/src/config/env.ts`, and `apps/api/src/utils/gateway-auth.ts`.
- Environment validation: `tests/env.test.ts`.
- HTTP, authentication, and request ID behavior: `tests/composer-api.test.ts`, `tests/gateway-auth.test.ts`, and `tests/logging.test.ts`.
- Operator and client guidance: `.env.example`, `docs/configuration.md`, and `docs/api.md`.
- Repository checks: root `package.json` scripts for Vitest, typecheck, lint, build, and Prettier.

## Constraints from the request

- CORS must not act as gateway authentication.
- Requests without `Origin` must remain usable under the existing authentication policy.
- Only configured HTTP origins may receive CORS authorization.
- The gateway request ID exposure and provider/client headers must remain compatible.
- No cookies, credentials mode, provider calls, or unrelated security phases are in scope.
