# Connexto development workflow (this repository)

Product repo wired for the forge skill **`connexto-development-workflow`**. Install skills once with `pnpm link:apply` in **my-skills-forge**.

## Config

| Item             | Value                                                        |
| ---------------- | ------------------------------------------------------------ |
| Adapter          | `connexto.project.json` at repo root                         |
| Run state        | `.connexto/runs/<DEMAND-ID>/` (gitignored)                   |
| AI Memory        | `rafael` / `connexto-proxy-cli-llms` (see `.ai-memory.toml`) |
| Validation gates | `pnpm test`, `pnpm lint`, `pnpm typecheck`                   |

```bash
python3 ../my-skills-forge/skills/engineering/connexto-development-workflow/scripts/cdw.py \
  check-config --repo "$(git rev-parse --show-toplevel)"
```

## How to run a demand (operator)

Open this repo in Cursor, OpenCode, or VS Code Codex. **You do not need to run `cdw init` yourself** unless you prefer CLI.

**New work:**

```text
Execute with connexto-development-workflow:
Type: FEATURE
Problem: …
Outcome: …
Scope: …
Acceptance: …
```

**Resume:**

```text
Continue FEAT-001 with connexto-development-workflow
```

The agent runs `cdw.py`, implements when `commands.implement` is null, runs independent review, and records AI Memory per the skill.

Approve only when the run is in `WAITING_APPROVAL`.

## Maintainer references

- Forge operator guide: `my-skills-forge/skills/engineering/connexto-development-workflow/references/operator-usage.md`
- Adapter schema: `my-skills-forge/skills/engineering/connexto-development-workflow/references/project-adapter.md`
- Forge scripts: `pnpm link:apply`, `pnpm workflow:test` in **my-skills-forge**
