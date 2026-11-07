# Codex loop — correção operacional e smoke (2026-11-07)

## Alterações

- Proxy `.env`: `CURSOR_EXECUTION_MODE=auto` (antes `local`).
- Bridge/SDK: `CURSOR_SDK_BRIDGE_URL`, `ENCRYPTION_KEY`, timeouts e versões do client (ver `.env`).
- Bugfix: `defaultCursorEnv()` agora repassa `CURSOR_SDK_BRIDGE_*` para o provider (sem isso, hub com bridge ainda caía em `cursor_missing_backend_url`).
- `throwNormalized` preserva `ConfigurationError`; startup alerta `cursor_execution_mode_local_with_hub` se `local` + `GATEWAY_API_TOKEN`.

## Smoke HTTP (hub integrado)

Pedido: `POST /v1/responses` com `X-Gateway-API-Key`, tools `write`, cwd `ativeplus`, criar `teste.txt`.

| requestId | HTTP | error.code (antes → depois) |
|-----------|------|-----------------------------|
| `cef1da0a-b8ac-4fc4-baaf-b3377c3b2fd0` | 500 | `cursor_missing_backend_url` (bridge URL ignorada no env do provider) |
| `1783777e-05d8-4f4b-9b7b-62ce8fde70ef` | 502 | `upstream_error` (rota edge + bridge; bridge não estava no ar em 8792) |

Conclusão: o proxy passou a usar o caminho **edge_owned + SDK bridge**, não mais `local_runtime` com `requiresLocalTool` no disco do proxy (causa do loop Codex).

## Operador (Codex real)

1. Subir bridge: `cd ~/dev-outros/composer-api && node ./scripts/cursor-sdk-local-agent-bridge.mjs` (ou `docker compose up` com bridge exposto em 8792).
2. Proxy: `pnpm --filter @agent-runtime-gateway/api dev` na porta 9090.
3. IDE em `ativeplus`, Codex via AI Hub: pedido único para criar `teste.txt` — esperar **uma** rodada de `function_call` no cliente, sem loop de “verificando…”.

## Testes automatizados

- `pnpm test` (exceto 3 testes live de integração Cursor — 401/ambiente).
- `packages/providers/cursor/tests/errors.test.ts` e `tests/cursor-edge-env.test.ts` — OK.
