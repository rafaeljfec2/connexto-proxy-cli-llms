# Providers

## Cursor (`@agent-runtime-gateway/provider-cursor`)

Uses the official **`@cursor/sdk`** local agent path:

- `Cursor.models.list` for model discovery
- `Agent.create` / `Agent.resume` for session continuity
- `agent.send`, `run.stream`, `run.wait`, `run.cancel` for execution

Gateway **Bearer token** (`GATEWAY_API_TOKEN`) is separate from the **Cursor API key** passed as `ProviderCredential` on execute (or `CURSOR_API_KEY` for listing during development).

### Integration test (real)

```bash
export CURSOR_API_KEY=...
pnpm --filter @agent-runtime-gateway/provider-cursor test:integration
```

## Antigravity

Not implemented (Phase 7).
