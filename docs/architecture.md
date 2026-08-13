# ProofLoop Architecture

ProofLoop is an evidence-first verification layer for AI and human code changes.

## Packages

| Path | Role |
|------|------|
| `apps/cli` | Local `init` / `check` / `explain` / `report` |
| `apps/api` | Fastify API, SQLite/Postgres-compatible schema, GitHub webhook |
| `apps/web` | Dashboard (Overview, Evidence, Unknowns, Impact, History, Rules) |
| `packages/core` | Domain types + claim/overall status machine |
| `packages/git` | Diff / worktree helpers |
| `packages/analyzers` | Project detection, TS/Python analysis, impact graph, deterministic claims |
| `packages/verifiers` | Allowlisted command runner + artifacts |
| `packages/security` | Command policy + log redaction |
| `packages/llm` | Optional OpenAI-compatible provider with Zod validation |
| `packages/evidence` | Evidence Pack + pipeline orchestration |
| `packages/ui` | Shared status/visual primitives |
| `fixtures/demo-repo` | Auth-boundary demo |

## Pipeline

1. Collect SHAs + diff + `proofloop.yml`
2. Understand (detect + analyze + optional LLM)
3. Plan verifications (allowlist)
4. Verify (worktree when safe; on Windows default to repo tree — set `PROOFLOOP_USE_WORKTREE=1` to opt in)
5. Score claims / merge gate
6. Emit `evidence.json` + `report.md`

> Note: recursive deletion of a Windows junction previously could wipe the real `node_modules`. The runner now unlinks dependency junctions before removing worktrees.

## Status semantics

- `verified` / `passed`: require linked executed verification
- `inferred`: LLM/heuristic only
- `unknown`: missing/skip/timeout/mock evidence
- `blocked`: policy block or failed verification

## Policies (`proofloop.yml`)

- `requireDynamicVerificationFor`: claim categories that need unit/integration/security/manual evidence (not lint/typecheck alone)
- `blockOn`: risk severities that keep merge blocked (`critical` / `high` by default)
- Policies are embedded in `evidence.json` so human confirm re-evaluates the same gate
- After API confirm, GitHub Check Run + summary comment are refreshed when token + PR metadata exist

## Human reviews (SHA-bound)

Each accept/reject records: `claimId`, `headSha`, `reviewer`, `at`, `note`, `verificationId`.

- Stored on the Evidence Pack (`humanReviews`) and appended to `.proofloop/reviews.jsonl`
- Manual verifications are ignored when `boundHeadSha !== run.headSha` (new commit → prior accept cannot green-wash new code)
- Identical confirm on the same SHA is idempotent (no duplicate active review)
- Reject keeps merge blocked and surfaces a re-run path in CLI/UI

## Control plane (API)

- **Rules**: SQLite rules merge into `proofloop.yml` policies for the next check; preview endpoint shows gate delta; save syncs yml when `localPath` exists
- **Async runs**: `POST /runs` returns immediately (`queued` → phases); `POST /cancel` sets durable `cancel_requested` + aborts `AbortSignal`; restart marks in-flight runs `interrupted_restart`. With `REDIS_URL`, jobs use BullMQ; otherwise in-process memory queue
- **GitLab**: `POST /api/gitlab/webhook` runs the same pipeline on MR open/update/reopen; posts commit status + MR note via `GITLAB_TOKEN`
- **Auth**: set `PROOFLOOP_API_TOKEN` to require Bearer token on mutating routes; production requires webhook secrets (`GITHUB_WEBHOOK_SECRET` / `GITLAB_WEBHOOK_SECRET`)
- **GitHub App / checkout**: `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` (+ installation id from webhook or `GITHUB_APP_INSTALLATION_ID`) preferred over PAT; without `localPath`, clones/fetches into `PROOFLOOP_WORKSPACE_ROOT` (default `.data/workspaces`)
- **Artifacts**: runner picks up JUnit / coverage / SARIF when present and folds summaries into verification evidence
- **Impact**: Evidence Pack + DB store node **edges** (`imports` / `imported_by` / `calls` / symbol relations); pipeline expands AST beyond the diff (dir-prioritized, configurable caps) so reverse-closure works; UI prefers stored edges. Coverage note states this is AST/module-resolution based, not a full runtime call graph.
- **Webhook idempotency**: durable `head_run_claims` unique on `(repository_id, head_sha)` — redeliveries return the claimed run even after completion
- **Store transactions**: `putRules` / `finalizeQueuedPack` / head claims use `BEGIN IMMEDIATE`
- **Checkout mutex**: path locks around git checkout + in-process repo job serialization
- **Rules**: UI/DB rules may only *tighten* `blockOn` / `requireDynamic` / network / duration vs `proofloop.yml`
- **Tenancy**: org-scoped API keys cannot list/create other orgs or bootstrap into the default tenant
- **History / explain**: `/history` aggregates runs + metric events; `/explain` and CLI `explain` separate facts vs inferences vs unknowns
