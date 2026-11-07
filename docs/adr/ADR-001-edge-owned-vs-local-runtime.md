# ADR-001: Edge-owned vs local-runtime Cursor execution

## Status

Accepted (FEAT-003, 2026-11-07)

## Context

AI Hub forwards Codex payloads to Connexto Proxy without mutating workspace or instructions. Class B providers (Composer) historically used Cursor `Agent.create` with `local.cwd` on proxy disk, which tied repo identity to Docker mounts instead of the IDE-open project.

See [runbooks/edge-owned-execution-plan.md](../runbooks/edge-owned-execution-plan.md).

## Decision

1. Introduce execution modes `edge_owned` and `local_runtime`.
2. Default `CURSOR_EXECUTION_MODE=auto`: hub requests (`X-Gateway-API-Key`) use `edge_owned` (remote engine/SDK); direct clients use `local_runtime`.
3. `edge_owned` must not run a local SDK tool loop on proxy disk; client tools are returned to the hub/Codex via OpenAI-compatible `tool_calls` / Responses `function_call` events.
4. Workspace **422** (BUG-002) applies only when hub + `local_runtime` and cwd cannot be resolved.

## Consequences

- Hub Composer no longer depends on mounting the user repo at proxy `local.cwd` for identity.
- `CURSOR_DEFAULT_WORKING_DIRECTORY` remains for direct `local_runtime` clients.
- Tool-heavy Codex flows require HTTP layers to surface `tool.call` agent events (implemented in FEAT-003).
- Forcing `CURSOR_EXECUTION_MODE=edge` for non-hub clients shifts them to remote inference without local tools on disk.

## References

- `apps/api/src/utils/cursor-execution-mode.ts`
- `packages/providers/cursor/src/provider.ts` (`executeEdgeOwned`)
- `packages/providers/cursor/src/edge-run.ts`
