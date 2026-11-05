# HTTP Error Handling Research

## Scope

This research covers AUD-01 and AUD-04 from `docs/security/SECURITY-AUDIT.md`. It excludes gateway authentication, CORS, request ID generation, provider cancellation, and successful response behavior.

## Current behavior

- `apps/api/src/app.ts` installs `express.json()` and registers routes, but has no final error middleware. Parser failures therefore reach Express's default handler.
- Chat completions, completions, and Responses creation catch provider failures and pass `toSafeError(error).message` to `openAiErrorPayload`; `toSafeError` returns `Error.message` unchanged.
- `apps/api/src/utils/run.ts` also returns `AgentResult.error.message` in an upstream error response.
- `packages/core/src/runtime/runtime-executor.ts` wraps provider failures in `ProviderExecutionError` and retains the original failure as `cause`.
- Cursor failures have stable codes in `packages/providers/cursor/src/errors.ts`; rate-limit errors are marked retryable. `CursorProviderError` carries the code and retryable flag.
- The OpenAI compatibility package provides `HttpError` with an explicit status, code, and optional parameter, plus the shared `openAiErrorPayload` envelope.
- Request correlation and access summaries already exist in `app.ts`. Route error logs include request IDs and error type/code, and omit the error message.
- `raw-body@3.0.2` emits `request.size.invalid` when the received byte count differs from `Content-Length`; it assigns status 400.

## Design constraints

- Keep the existing OpenAI error envelope and explicitly classified `HttpError` contract.
- Use fixed public messages for parser, provider, and unexpected failures. Do not serialize arbitrary provider messages, bodies, stacks, paths, causes, or headers.
- Treat Cursor authentication failures as upstream failures (502), distinct from gateway authentication (401). Map known Cursor rate limits to 429. Map unclassified errors to a generic 500.
- Preserve parser status for malformed or aborted JSON (400) and oversized JSON (413). An unsupported JSON content type remains a route-level 400 as it is today.
- Log only reviewed fields needed for operation and correlation. Never pass parser errors or causes to Pino.
- When the response is already committed, destroy the response without attempting a second payload.

## Evidence sources

- `apps/api/src/app.ts`
- `apps/api/src/utils/logger.ts`
- `apps/api/src/utils/run.ts`
- `apps/api/src/routes/chat-completions.ts`
- `apps/api/src/routes/completions.ts`
- `apps/api/src/routes/responses/create.ts`
- `apps/api/src/routes/responses/tokens-compact.ts`
- `packages/core/src/errors.ts`
- `packages/core/src/runtime/runtime-executor.ts`
- `packages/providers/cursor/src/errors.ts`
- `packages/providers/cursor/src/provider-error.ts`
- `packages/compatibility/openai/src/http.ts`
