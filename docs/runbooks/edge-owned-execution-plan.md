# Runbook: Edge-owned workspace (thin proxy) for AI Hub + Codex

**Audience:** Any autonomous agent (Cursor, Codex, Connexto CDW) working on Class B providers (`cursor`, `antigravity`) behind AI Hub.

**Status:** Action plan (post BUG-002). BUG-002 fixed silent wrong defaults; this runbook closes the **architecture gap** between product intent and `local_runtime` implementation.

**Related:**

- [architecture.md](../architecture.md) — current request flow
- [providers.md](../providers.md) — Cursor local agents and `local.cwd`
- [configuration.md](../configuration.md) — `CURSOR_DEFAULT_WORKING_DIRECTORY`, hub integration
- AI Hub: opaque forward via `ConnextoProxyClient` (no workspace injection)
- Completed proxy demand: **BUG-002** (agent-first cwd, 422 without workspace, session cwd invalidation)

---

## 1. Problem statement

| Symptom | Example |
|--------|---------|
| Composer via AI Hub describes **AI Hub** instead of the IDE-open repo | Codex on `ativeplus`, model `composer-2.5` |
| `gpt-6-luna` (direct API) behaves correctly | Class A: Codex owns sandbox and tools |

**Root cause (architecture):**

- **Product intent:** AI Hub + Connexto Proxy are **transports**; the **edge agent (Codex)** owns workspace, tools, and sandbox.
- **Current Class B implementation:** Proxy runs **Cursor SDK local agents** (`Agent.create` / `resume` with `local.cwd`). Tool filesystem is the **proxy process** (inside Docker: the container), not optional metadata.

Docker bind-mounting one repo (`../connexto-aihub` → `/workspace`) is a **dev convenience**, not multi-repo Codex workflow.

---

## 2. Target invariant (freeze as acceptance)

1. **AI Hub** must not rewrite `instructions` / `input` or inject workspace paths (forward opaque + credentials only).
2. **Proxy (hub-integrated requests):** Must not silently use `CURSOR_DEFAULT_WORKING_DIRECTORY` when the edge agent declares another workspace (BUG-002).
3. **Long-term:** For `X-Gateway-API-Key` + Codex-class clients, prefer **`edge_owned`** execution: inference/streaming through Cursor (or Antigravity) **without** a second local tool loop on proxy disk.
4. **`local_runtime`** remains available for headless direct proxy clients (no hub header), with explicit mounts/docs.

---

## 3. Execution modes (decision table)

| Mode | Who runs file tools | Proxy `local.cwd` | Docker mount |
|------|---------------------|-------------------|--------------|
| `edge_owned` | **Codex** (edge) | Not used for tool loop | Not required for user repos |
| `local_runtime` | **Cursor SDK** in proxy | Required | Required if paths are host-absolute |

**Default when `X-Gateway-API-Key` is set:** `edge_owned` (after this epic).

**Auto-selection rule (implement):**

```
if request has X-Gateway-API-Key and client is hub-integrated:
  prefer edge_owned when SDK/API path exists for the request profile
else:
  local_runtime with CURSOR_DEFAULT_WORKING_DIRECTORY fallback allowed
```

Document the rule in `docs/architecture.md` after implementation.

---

## 4. Prerequisites for any agent

1. Read [connexto-workflow.md](../connexto-workflow.md); use **Connexto CDW** for delivery (`connexto.project.json` at repo root).
2. Repos in scope:
   - **Primary:** `connexto-proxy-cli-llms`
   - **Secondary (regression only):** `connexto-aihub` — no workspace mutation
3. Quality gates: `pnpm test`, `pnpm lint`, `pnpm typecheck`
4. Do not commit secrets or enable `LOG_HTTP_PAYLOADS` in shared environments without redaction.

**Suggested demand id:** `FEAT-003` (type `FEATURE`) or `REFACTOR-003` if mostly structural.

---

## 5. Phase 0 — Evidence spike (blocking)

**Goal:** Prove whether Cursor SDK/API can serve Composer **without** `Agent.create` + local tools for Codex-like payloads (tools + reasoning in body).

### Step 0.1 — Capture payloads

1. On operator machine: proxy with `LOG_HTTP_PAYLOADS=true` ([logging.md](../logging.md)).
2. One successful **gpt-6-luna** request via AI Hub (reference: Class A).
3. One **composer-2.5** request via AI Hub with IDE context + Work locally, repo **not** AI Hub.
4. Save redacted JSON fixtures under:
   - `packages/compatibility/openai/tests/fixtures/codex/` (new directory)
   - Name: `hub-composer-redacted.json`, `hub-luna-redacted.json`

### Step 0.2 — Map code path

| Check | Location | Record in `research.md` |
|-------|----------|-------------------------|
| Where `execute()` creates local agent | `packages/providers/cursor/src/provider.ts` | agent create/resume |
| Where cwd is set | `apps/api/src/routes/responses/create.ts`, `chat-completions.ts` | `resolveExecutionWorkingDirectory` |
| Prepare mode agent vs ask | `packages/compatibility/openai/src/protocol/prepare.ts` | `tools.length`, `prompt.mode` |

### Step 0.3 — SDK/API spike

1. Read Cursor SDK docs (link in [docs/README.md](../README.md)).
2. List candidate APIs: remote chat/responses vs local `Agent` only.
3. **Decision output** in `research.md`:
   - **GO:** remote path exists → proceed Phase 2 with named API
   - **NO-GO:** only local agent → document constraint; implement Phase 2b (co-location) as interim

### Phase 0 exit criteria

- `research.md` contains line `Implemented: no` until epic merge (CDW rule).
- Clear **GO/NO-GO** for `edge_owned` with evidence (fixture + SDK note).

---

## 6. Phase 1 — Design (PLAN artifacts)

Write under `.connexto/runs/<DEMAND-ID>/`:

- `spec.md` — `## Behavior` for mode selection and invariants above
- `plan.md` — `## Acceptance criteria` enumerated below
- `tasks.md` — open tasks only until done

### 6.1 — ADR (repo doc)

Create `docs/adr/ADR-NNN-edge-owned-vs-local-runtime.md` (English):

- Context, decision, consequences
- Link to this runbook
- Hub Class A vs Class B table (mirror AI Hub `docs/architecture.md` when updated)

### 6.2 — Configuration contract

| Variable | Purpose |
|----------|---------|
| `CURSOR_EXECUTION_MODE` | `auto` \| `edge` \| `local` (proposed) |
| `X-Gateway-API-Key` | When present, `auto` prefers `edge` |

Update [configuration.md](../configuration.md) in Phase 2.

---

## 7. Phase 2 — Implementation (proxy)

Execute only after Phase 0 **GO** or explicit operator acceptance of NO-GO path.

### 7.1 — Mode resolution module

**Add:** `apps/api/src/utils/cursor-execution-mode.ts` (or under `packages/providers/cursor`)

- Inputs: `Request`, `PreparedRequest`, env
- Output: `edge_owned` \| `local_runtime`
- Unit tests: `tests/cursor-execution-mode.test.ts`

### 7.2 — `edge_owned` path in Cursor provider

**Files:** `packages/providers/cursor/src/provider.ts`, possibly new `remote-*.ts`

Steps:

1. Branch in `execute()` on execution mode.
2. **`edge_owned`:** Call remote/inference path (from spike); **do not** call `sessions.acquireAgent` with local tool loop.
3. **`local_runtime`:** Keep existing `acquireAgent` + BUG-002 cwd rules.
4. Ensure streaming/SSE contract unchanged for clients ([api.md](../api.md)).

### 7.3 — Handlers

**Files:** `apps/api/src/routes/responses/create.ts`, `chat-completions.ts`

1. Pass execution mode into `executor.execute` (extend `AgentExecutionInput` if needed — **core** package).
2. For `edge_owned` + hub: **remove** requirement to resolve host `workingDirectory` for filesystem (may keep parsing for logging only).
3. For `local_runtime` + hub: keep 422 when cwd missing (BUG-002).

### 7.4 — Antigravity (if in scope)

**Files:** `packages/providers/antigravity/src/provider.ts`

- Same mode concept if ACP always local → document **Antigravity stays `local_runtime`** until ACP remote exists; hub-integrated Antigravity keeps cwd/mount rules.

### 7.5 — Tests

| Test | Purpose |
|------|---------|
| Fixture tests from Phase 0 | `prepareResponsesRequest` / routing |
| Hub header + composer → no `createLocalAgent` mock calls | `edge_owned` |
| Direct proxy without header → `createLocalAgent` still called | `local_runtime` |
| Regression: `tests/gateway-auth.test.ts`, `session-isolation.test.ts` | Update if contract changes |

### 7.6 — Documentation

- [architecture.md](../architecture.md): diagram with two modes
- [docker.md](../docker.md): `local_runtime` only; edge + Codex → recommend host `pnpm dev` or no user-repo mount
- [providers.md](../providers.md): when local agents are used

---

## 8. Phase 2b — Interim if Phase 0 is NO-GO

If Cursor SDK cannot do `edge_owned` yet:

1. **Product doc:** Class B + Codex multi-repo **requires** proxy on host (`pnpm dev`), not default Docker single-repo mount.
2. **Compose:** document `HOST_PROJECTS_ROOT` pattern; do not default to `connexto-aihub` in operator runbooks.
3. **Optional:** path rewrite host → mount prefix (`/home/rafael/dev-rafael` → `/projects`) **only** when `CURSOR_WORKSPACE_MOUNT_PREFIX` set — explicit opt-in, never default to AI Hub repo.

Do not claim “thin proxy” complete in this path; label as **interim co-location**.

---

## 9. Phase 3 — AI Hub (regression only)

Repo: `connexto-aihub`

1. Confirm `internal/providers/connexto_proxy.go` still forwards body unchanged.
2. Add/extend test: fixture Codex payload bytes equal upstream.
3. Short paragraph in `docs/architecture.md`: Agent context invariant + Class A/B (English).
4. **No** injection of `X-Agent-Working-Directory` generated by hub.

Validate: `go test ./internal/providers/... ./internal/gateway/... -count=1`

---

## 10. Phase 4 — Validation (operator + automated)

### Automated

```bash
cd connexto-proxy-cli-llms
pnpm test && pnpm lint && pnpm typecheck
```

CDW: `validate` must pass all required gates in `connexto.project.json`.

### Manual (operator)

| Step | Action | Pass |
|------|--------|------|
| 1 | Open repo **R** (not AI Hub) in IDE | — |
| 2 | Codex: `composer-2.5`, provider AI Hub, IDE context on | — |
| 3 | Ask: describe this repository | Text describes **R**, not AI Hub |
| 4 | Switch folder to **S**, same thread or new | Describes **S** |
| 5 | Repeat with `gpt-6-luna` | Regress Class A |

Record in `delivery.md` / AI Memory: `decisions/<DEMAND-ID>-edge-owned.md`.

---

## 11. Acceptance criteria (epic complete)

- [ ] Hub-integrated Composer does **not** depend on proxy container mount of AI Hub for correct repo identity (`edge_owned` GO path), **or** NO-GO documented with interim co-location runbook published.
- [ ] `X-Gateway-API-Key` requests default to `edge_owned` when GO.
- [ ] Direct proxy clients can still use `local_runtime` + `CURSOR_DEFAULT_WORKING_DIRECTORY`.
- [ ] AI Hub unchanged except docs/tests (no workspace injection).
- [ ] All proxy quality gates green; independent CDW review recorded.

---

## 12. Agent checklist (single page)

```
[ ] Init CDW demand (FEAT-003 / REFACTOR-003) on connexto-proxy-cli-llms
[ ] Phase 0: fixtures + SDK GO/NO-GO in research.md
[ ] Phase 1: spec/plan/tasks + ADR
[ ] Phase 2: execution mode + provider branch + tests + docs
[ ] Phase 3: aihub regression (if touched)
[ ] validate + review + deliver + memory_write_page
[ ] Operator manual smoke documented in delivery
```

---

## 13. Out of scope

- Changing Codex closed-source client behavior
- OpenRouter / OpenCode (Class A) execution model
- Production deploy or merge to main without operator gate (CDW `allow_commit`)

---

## 14. References (code)

| Topic | Path |
|-------|------|
| BUG-002 cwd policy | `apps/api/src/utils/execution-working-directory.ts` |
| Cursor sessions | `packages/providers/cursor/src/sessions.ts` |
| Cursor client cwd | `packages/providers/cursor/src/client.ts` |
| Hub forward | `connexto-aihub/internal/providers/connexto_proxy.go` |
| Test helper IDE context | `tests/helpers/codex-workspace.ts` |

---

## Revision history

| Date | Change |
|------|--------|
| 2026-11-07 | Initial runbook after BUG-002 and edge-owned product discussion |
