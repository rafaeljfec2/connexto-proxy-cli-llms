# HTTP Error Handling Plan

## Intended outcome

Close AUD-01 and AUD-04 with a shared, classified HTTP error response path while preserving OpenAI/Composer success and error contracts.

## Delivery slices

1. Add failing HTTP tests for malformed, oversized, unsupported-content-type, truncated, and content-length-mismatch request bodies. Verify status, OpenAI envelope, request ID, and absence of synthetic body/stack/path data and stderr leakage.
2. Add failing tests for asynchronous and unexpected failures, already-sent headers, and provider errors. Verify fixed public messages, known status/category mapping, request correlation, and no duplicate response.
3. Add failing log assertions for parser and provider failures. Verify summaries retain status, route, request ID, and duration while excluding body, authorization data, stack, and arbitrary upstream messages.
4. Implement the smallest shared error classification/response utility and mount it after the routes and JSON parser. Reuse it from existing route catches and failed-run handling.
5. Run focused tests after each slice, then workspace tests, typecheck, lint, format check, and production build. Review the resulting diff and security scan evidence.

## Acceptance criteria

- Parser and unexpected errors use the OpenAI error envelope with stable public text and appropriate status.
- **Already passing — regression guard:** an unsupported JSON content type currently reaches route validation and returns the existing safe 400 envelope; keep that behavior and prevent body disclosure.
- Provider and failed-run messages, tokens, local paths, causes, and stacks never reach HTTP clients or logs.
- Known Cursor rate limits map to 429; Cursor credential failures map to upstream 502; unknown failures remain generic 500.
- Existing `HttpError` status/code/parameter behavior, gateway authentication, request IDs, CORS, and successful responses remain intact.
- Errors after headers are sent do not produce a second response and close the connection safely.

## Evidence

- **Claim:** All HTTP error paths covered by this change return classified OpenAI-compatible errors without exposing parser or provider internals, and preserve operational correlation without logging sensitive payloads.
- **Success type:** `test`.
- **Evidence path:** Vitest + Supertest against the real built app and a small Express fixture using the shared error middleware; capture Pino output and stderr with synthetic secrets and paths.
- **Budget:** Focused HTTP/error/logging tests for every acceptance criterion, followed by the full repository quality gate.
- **Affordance:** None; existing app construction, error contracts, stub provider, and log capture are sufficient.

## Validation record

- Red phase reproduced parser responses outside the OpenAI envelope, content-length mismatch classified as 500, raw provider messages, incorrect provider status mapping, and a compaction response summary that changed to 200 after an upstream failure.
- Focused green validation passed all 14 HTTP/provider error tests.
- Offline suite passed 228 tests across 25 files. Live Cursor integration files were excluded to honor the no-network constraint.
- Typecheck, lint, format check, and build passed.
- Coverage passed with `@vitest/coverage-v8` 4.1.12: 92.85% lines, 87.93% branches, and 100% functions for `error-handler.ts`.
- Remaining uncovered lines are defensive mappings for Cursor agent/SDK and unknown Cursor codes, unknown parser types, and exhaustion of the bounded cause-chain walk. Equivalent 502/500/fallback behavior is covered by provider, unknown-error, and parser tests; the six-level cause bound is a defensive stop condition.
- Snyk Code returned `SNYK-CODE-0005` (403). After explicit authorization, its attempt to enable the feature failed with 404 from the organization settings API. SAST remains unavailable; no setting changed.
- `@vitest/coverage-v8` 4.1.12 was added as a development dependency after explicit user approval.
