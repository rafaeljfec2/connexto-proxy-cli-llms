# Stream Cancellation Research

## Scope

This research covers AUD-03 only. It excludes Responses background execution, session isolation, dependency hardening, and any change to the Composer API source repository.

## Current execution flow

1. The Express routes for chat completions, legacy completions, Responses creation, and Responses compaction call RuntimeExecutor.execute.
2. RuntimeExecutor forwards AgentExecutionInput to the selected provider without transformation.
3. AgentExecutionInput already defines an optional AbortSignal in packages/core/src/contracts/execution.ts.
4. CursorProvider passes that signal to adaptCursorRun. The adapter registers an abort listener that calls the SDK Run.cancel method.
5. The adapter exposes SDK run.stream events through AgentRun.events. For JSON responses, apps/api/src/utils/run.ts drains the events and then calls run.wait.
6. Streaming routes write provider deltas to the Express response. No route currently observes a premature response close or passes a signal to execute.

## Confirmed gaps

- The provider cancellation hook exists but is unreachable from current HTTP execution because all four provider-backed routes omit signal.
- The stream loops do not stop forwarding events after a client disconnect.
- The provider adapter does not deduplicate cancellation initiated through both the signal and AgentRun.cancel, and does not remove its abort listener when the run becomes terminal.
- A cancelled run result is not distinguished from successful completion by collectRunText.
- apps/api/src/app.ts attaches response close only for access-summary logging; it does not cancel provider work.

## Response cancellation contract

The OpenAI Responses cancel endpoint is for responses created with background=true. The current compatibility parser rejects background=true, and the lifecycle handler preserves the existing error for a completed synchronous response. This phase keeps that behavior and does not add explicit cancellation for synchronous Responses.

The repository API documentation currently describes the endpoint as cancelling an in-flight response. That text must be corrected to state that background Responses and explicit cancellation are not currently supported.

## Provider cancellation evidence boundary

The installed Cursor SDK exposes Run.cancel. Its local SDK implementation calls client.cancelRun and aborts its local controller. Offline tests can prove the adapter calls Run.cancel exactly once. Without a live Cursor request, this work cannot prove that remote processing has stopped; documentation must state this limit.

Cursor SDK SendOptions does not accept an AbortSignal. If cancellation occurs while CursorProvider is acquiring a session, the provider can check the signal before starting agent.send. If agent.send is already pending, the provider cannot interrupt that call; once it returns a Run, the adapter receives the aborted signal and dispatches Run.cancel.

## Sources

- apps/api/src/routes/chat-completions.ts
- apps/api/src/routes/completions.ts
- apps/api/src/routes/responses/create.ts
- apps/api/src/routes/responses/tokens-compact.ts
- apps/api/src/utils/run.ts
- packages/core/src/contracts/execution.ts
- packages/core/src/runtime/runtime-executor.ts
- packages/providers/cursor/src/provider.ts
- packages/compatibility/openai/src/protocol/prepare.ts
- apps/api/src/routes/responses/lifecycle.ts
- https://developers.openai.com/api/reference/resources/responses/methods/cancel
