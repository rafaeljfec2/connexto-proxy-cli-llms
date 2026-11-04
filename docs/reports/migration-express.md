# Architecture Decision & Migration — Express HTTP Framework

## Objective

Migrate `apps/api` from Fastify to Express with TypeScript, preserving existing HTTP contracts (`GET /health`), isolating Core and Providers from HTTP framework details, and updating tests to Supertest.

## Changes

1. **Dependencies (`apps/api/package.json`):**
   - Removed: `fastify`
   - Added: `express` (^5.3.0), `@types/express` (^5.0.6)
2. **Test Dependencies (`package.json`):**
   - Added: `supertest` (^7.3.1), `@types/supertest` (^7.2.1)
3. **HTTP Server (`apps/api/src`):**
   - `apps/api/src/routes/health.ts`: routes registered on Express instance returning identical payload `{ status: "ok", service: "agent-runtime-gateway" }`.
   - `apps/api/src/app.ts`: instantiates Express, attaches `express.json()`, and mounts health routes.
   - `apps/api/src/server.ts`: starts HTTP server via `app.listen(port, host)`.
4. **Integration Test (`tests/health.test.ts`):**
   - Migrated from Fastify `app.inject()` to `supertest(app).get("/health")`.
5. **Core and Providers:**
   - Zero changes to `@agent-runtime-gateway/core` and `@agent-runtime-gateway/provider-cursor`. Fully framework-agnostic.

## Verification

- `pnpm install`: Clean lockfile update.
- `pnpm typecheck`: Clean across all packages and tests.
- `pnpm lint`: Clean.
- `pnpm test`: 8 passed, 1 skipped (26 tests passed, 2 integration tests skipped due to missing API key).
- `pnpm format:check`: Clean.
- `pnpm --filter @agent-runtime-gateway/api build`: Clean tsc compilation to `dist/`.

