# Stream Cancellation Plan

## Intended outcome

Close AUD-03 by tying each provider-backed HTTP request to an isolated AbortController. A premature client disconnect aborts that request, stops response event forwarding, and reaches the existing Cursor SDK cancellation hook. Normal response completion does not abort work.

## Frozen constraints

- Preserve OpenAI and Composer success contracts and all approved Phase 1 and Phase 2 behavior.
- Keep POST /v1/responses/:id/cancel restricted to the existing background-response contract. Background Responses remain unsupported; do not add synchronous Response cancellation.
- Do not modify the original composer-api repository.
- Do not make live Cursor calls, commits, or pull requests.
- Do not add dependencies or unrelated abstractions.
- Treat local stream shutdown, SDK cancellation dispatch, and actual remote termination as separate guarantees.

## Design

Add one request-scoped cancellation helper in apps/api/src/utils. It will create a fresh AbortController, observe req.aborted and res.close, and abort only when the response has not completed normally. It will expose a readonly signal and an idempotent dispose function that removes its listeners.

Pass the helper signal to RuntimeExecutor.execute in chat completions, legacy completions, Responses creation, and Responses compaction. Streaming loops will check the signal before writing each event and stop iteration after abort. Non-streaming event collection will return quietly when the HTTP signal is aborted. If the provider reports `cancelled` while the HTTP request is still connected, the gateway will send a safe terminal upstream error instead of leaving the response open. Route catches will suppress expected cancellation after the response has closed.

Update CursorProvider's run adapter to share one cancellation promise between the signal listener and AgentRun.cancel, skip SDK cancellation for terminal runs, and remove the signal listener when the run settles or cancellation completes. Keep the existing provider contract and SDK integration.

Check the signal before starting session acquisition and again after it resolves, so an abort during acquisition does not start agent.send. The SDK SendOptions type has no signal field. If agent.send has already started, the adapter will cancel the resulting Run as soon as the call returns.

No change is planned for apps/api/src/routes/responses/lifecycle.ts. Regression tests will retain the existing completed synchronous Response cancellation response and unsupported background behavior.

## Delivery boundaries

1. Request cancellation helper, route signal propagation, SSE forwarding guards, and non-streaming cancellation handling. Validate with focused HTTP tests using controlled local providers.
2. Cursor adapter cancellation idempotency and listener cleanup. Validate with mocked SDK Run objects.
3. Update the AUD-03 security audit, API documentation, and delivery report after code behavior is proven. Run offline regression and quality checks.

## TDD plan

- Use a local HTTP server and mocked provider to disconnect an SSE client after its first delta. Verify the request signal aborts, the provider cancellation hook runs once, and later events are not forwarded or drained.
- Already passing — regression guard: exercise the disconnect path on each stream-enabled HTTP route, including Chat Completions, legacy Completions, and Responses.
- Already passing — regression guard: closing the Cursor SDK event iterator early invokes `Run.cancel()` exactly once.
- Cover cancellation while execute is pending, simultaneous isolated requests, normal response completion, and expected AbortError handling.
- Exercise the signal path at chat completions, legacy completions, Responses creation, and Responses compaction.
- Mock Cursor SDK Run to verify signal-triggered cancel, repeated cancellation, completion-before-abort, and listener cleanup.
- Verify an abort during Cursor session acquisition prevents agent.send from starting.
- Preserve tests for successful response shapes and the existing synchronous Responses cancellation behavior.
- Exclude test files that can invoke Cursor from all offline-suite commands.

### Red phase evidence

Before the post-acquisition signal check was added, the provider test `does not send a Cursor message when the request aborts during agent acquisition` failed because `execute()` resolved with a Run after the signal had been aborted. The implementation now checks the signal after session acquisition and before calling `agent.send()`.

The independent review identified two additional red cases: a provider result with `status: "cancelled"` and no HTTP abort left the chat response open until the test timed out; a disconnect while chat `execute()` was pending still started the SSE event iterator after the Run resolved. The collector now sends the safe upstream error for provider cancellation without an HTTP abort, and the affected routes return immediately after execution when their request signal is aborted.

## Acceptance criteria

- Every provider-backed HTTP route passes a unique request-scoped AbortSignal.
- A premature response close aborts only the corresponding run; normal finish does not.
- No new SSE frames are written after cancellation and no duplicate HTTP response is attempted.
- Cancellation errors do not become HTTP 500 responses or ordinary provider-failure logs.
- A provider-reported cancelled run without an HTTP abort ends with a safe upstream response.
- Cursor SDK Run.cancel is invoked at most once per execution, and its abort listener is cleaned up.
- Concurrent executions remain isolated; successful OpenAI and Composer responses remain unchanged.
- Explicit Responses cancellation remains limited to the OpenAI background contract, which is unsupported by this gateway today.
- Documentation distinguishes local cancellation from SDK dispatch and unverified remote termination.
- Offline tests, typecheck, lint, formatting, build, and diff checks pass.

## Evidence

- **Claim:** A premature HTTP client disconnect aborts only its provider execution, invokes the supported Cursor SDK cancellation hook at most once, and prevents further SSE forwarding while preserving normal completion behavior.
- **Success type:** test.
- **Evidence path:** Vitest route integration tests with a loopback HTTP server and controlled provider streams, plus Cursor provider tests with mocked SDK Run objects. A separate offline suite excludes tests capable of live Cursor calls.
- **Budget:** Disconnect after a delta; disconnect before execute resolves; cancel two concurrent runs independently; verify successful completion is not aborted; verify cancellation is idempotent; verify AbortError is not returned as HTTP 500; verify route coverage, response compatibility, and listener cleanup.
- **Affordance:** Temporary controlled provider and SDK Run fixtures provide deterministic cancellation timing and observability without network access.
