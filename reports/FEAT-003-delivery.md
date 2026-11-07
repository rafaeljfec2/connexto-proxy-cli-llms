# Relatório de entrega — FEAT-003

**Repositório:** connexto-proxy-cli-llms  
**Data:** 2026-11-07  
**Status:** implementado localmente (sem commit — `allow_commit: false`)

## Objetivo

Corrigir identidade de repositório do Composer via AI Hub/Codex, evitando `Agent.create` no disco do proxy.

## Entregas

- Modo `edge_owned` padrão para `X-Gateway-API-Key`
- Branch no `CursorProvider` (engine/SDK remoto)
- Propagação de `tool_calls` no chat e Responses (stream + JSON)
- `requiresLocalTool: false` em `edge_owned`
- ADR-001, docs de configuração e arquitetura
- Fase 0: `research.md` + fixture Codex

## Verificação automatizada

```text
pnpm test   → 553 testes
pnpm typecheck → OK
pnpm lint   → OK
```

## Smoke manual (operador)

1. Rebuild/restart do proxy (`pnpm dev` no host recomendado)
2. IDE em repo **R** (não AI Hub)
3. Codex: `composer-2.5` + AI Hub + IDE context
4. Perguntar: descreva este repositório → deve descrever **R**
5. Regressão: `gpt-6-luna` inalterado

## AI Hub

Regressão existente: `connexto_proxy_test.go` preserva body/headers opacos — sem mudanças de código no hub neste ciclo.

## Riscos / follow-ups

- Cancelamento em `edge_owned` não aborta stream upstream (melhoria futura)
- `CURSOR_EXECUTION_MODE=edge` global afeta clientes diretos
