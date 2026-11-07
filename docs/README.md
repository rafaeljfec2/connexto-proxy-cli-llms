# Documentation

English technical documentation for **agent-runtime-gateway**.

## Getting started

1. [../README.md](../README.md) — install, run, first API call
2. [configuration.md](configuration.md) — `.env`, logging, authentication
3. [api.md](api.md) — HTTP routes and examples

## Engineering

| Doc                                | Purpose                                      |
| ---------------------------------- | -------------------------------------------- |
| [development.md](development.md)   | Workspace, scripts, quality gates, roadmap   |
| [architecture.md](architecture.md) | Packages and request flow                    |
| [providers.md](providers.md)       | Cursor and Antigravity providers/credentials |
| [testing.md](testing.md)           | Test layers and live integration             |
| [logging.md](logging.md)           | Pino, `X-Request-ID`, redaction rules        |
| [runbooks/edge-owned-execution-plan.md](runbooks/edge-owned-execution-plan.md) | **Agent runbook:** thin proxy vs local SDK (`edge_owned` / `local_runtime`) |


## Security & delivery

| Doc                                                                          | Purpose                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------- |
| [security/SECURITY-AUDIT.md](security/SECURITY-AUDIT.md)                     | Known gaps (e.g. gateway token not enforced) |
| [reports/phase-0-bootstrap.md](reports/phase-0-bootstrap.md)                 | Phase 0 evidence                             |
| [reports/phase-1-core.md](reports/phase-1-core.md)                           | Core runtime                                 |
| [reports/phase-2-cursor.md](reports/phase-2-cursor.md)                       | Cursor provider                              |
| [reports/phase-3-composer-api-port.md](reports/phase-3-composer-api-port.md) | Composer API port                            |
| [reports/migration-express.md](reports/migration-express.md)                 | Fastify → Express                            |

## Related repositories

- Reference implementation: [standardagents/composer-api](https://github.com/standardagents/composer-api)
- Cursor SDK docs: https://cursor.com/docs/api/sdk/typescript
