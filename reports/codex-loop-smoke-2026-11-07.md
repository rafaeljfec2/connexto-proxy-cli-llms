# Codex tool-loop smoke history (2026-11-07)

## Historical bridge attempt

The original smoke attempt used `CURSOR_EXECUTION_MODE=auto` and an external SDK bridge. This section preserves the failed results as historical evidence; the bridge setup is no longer an operator step.

| Request ID                             | HTTP result | Historical outcome                                                                          |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `cef1da0a-b8ac-4fc4-baaf-b3377c3b2fd0` | 500         | `cursor_missing_backend_url`; the bridge URL was not forwarded to the provider environment. |
| `1783777e-05d8-4f4b-9b7b-62ce8fde70ef` | 502         | `upstream_error`; the external bridge was unavailable on port 8792.                         |

Those attempts demonstrated that the bridge was an additional runtime dependency and did not establish a successful Codex tool cycle.

## Current execution path

Hub-integrated Cursor requests use an in-process `@cursor/sdk` agent. Client tool calls are returned to Codex through the OpenAI-compatible response stream; the proxy does not execute them against the IDE workspace. No `composer-api` checkout, second process, or port 8792 listener is part of the current runbook.

## Validation status

Automated validation for the replacement path passed: `pnpm test`, `pnpm lint`, and `pnpm typecheck` completed with `CURSOR_API_KEY` empty. The HTTP fixture and SDK runner tests are mocked; they are not evidence of a live Codex + AI Hub + `ativeplus` smoke. Do not run authenticated smoke tests until the outstanding credential-rotation question is resolved.
