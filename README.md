# ProofLoop

Evidence-first verification for AI (and human) code changes.

**Not a chatbot. Not "LGTM from a model."** ProofLoop answers: what changed, what was claimed, what was actually executed, what remains unknown, and whether merge should be blocked.

## Prerequisites

- **Node.js >= 22.5** (the API uses `node:sqlite`; CLI-only usage works on 20+ with `--no-llm`)
- **pnpm 10** (install via `npm i -g pnpm` or `corepack enable && corepack prepare pnpm@10 --activate`)
- **git** (for diff analysis and worktree checkouts)
- **Python 3** (optional — enables real AST analysis instead of regex fallback)
- **Redis** (optional — async queue for multi-worker deployments)

## What you get

| Kind | Meaning | Merge impact |
|------|---------|--------------|
| **verified** | Linked executed check passed (unit / integration / security) | Evidence |
| **passed** | Broader suite association passed (weaker than direct link) | Evidence |
| **manual verification** | Human accept **bound to commit SHA** + reviewer + time + reason | Can clear high-risk unknown; **new commit invalidates it** |
| **inferred** | Heuristic / LLM only — never treated as fact | Warning / not evidence |
| **unknown** | Missing, skipped, timed out, or mock-only evidence | High-risk → **blocks merge** |
| **blocked** | Failed verification, policy block, or human **reject** | Blocks merge |

## Quick start (real repo, not a demo)

```bash
cd proofloop
pnpm install

# Point the CLI at your own repository
pnpm proofloop init --cwd /path/to/your/repo          # writes proofloop.yml from detected commands
pnpm proofloop check --cwd /path/to/your/repo --base main --head HEAD --no-llm

# Inspect and act on results
pnpm proofloop explain <run-id> --cwd /path/to/your/repo
pnpm proofloop report <run-id> --format json --cwd /path/to/your/repo
pnpm proofloop confirm <run-id> <claim-id> --accept --note "Reviewed offline" --reviewer you --cwd /path/to/your/repo
```

`check` produces `evidence.json` + `report.md` under `.proofloop/`. Exit codes: `0` ok / warnings, `1` failed / blocked / high-risk unknown, `2` config/system error.

The analyzers use **real static analysis**, not regex heuristics:

- TypeScript/JavaScript: full compiler module resolution — `tsconfig.json` `baseUrl`/`paths`, `node_modules` with `package.json` `exports`/`main`/`types`, ESM `.js` → `.ts` source mapping, `.d.ts` handling — plus a **type-checker call graph** (call sites resolved to their declaring files via `ts-morph`).
- Python: the stdlib `ast` parser via a subprocess JSON bridge (regex fallback only when no interpreter exists).
- Impact graph: real import/call edges plus **transitive impact** (which files depend on the change), with per-run coverage notes.

## Server + Dashboard (multi-tenant API)

```bash
pnpm db:migrate          # SQLite (Postgres-compatible schema in apps/api/src/db/schema.ts)
pnpm dev                 # API on :8787 + Dashboard on :5173
```

Open `http://localhost:5173` → register a repository (local path or GitHub/GitLab), run a check, review Evidence / Unknowns / Impact, accept or reject claims. Accepts are SHA-bound and written to `.proofloop/reviews.jsonl`.

The API is multi-tenant: **organizations** scope repositories (`GET/POST /api/organizations`, `GET /api/organizations/:id/repositories`). Repositories can be created with `organizationId`; `GET /api/repositories?organizationId=…` filters by tenant. Unassigned repositories fall into the `default` organization.

Demo bootstrap is **opt-in** (`PROOFLOOP_DEMO_PATH=…`); the API never implicitly registers bundled fixtures.

## GitHub App (production flow)

Webhook URL: `POST /api/github/webhook` — events:
- `pull_request` (`opened`, `synchronize`, `reopened`) — queues a check asynchronously, publishes Check Run + summary when it finishes (webhook stays inside GitHub's 10s window)
- `check_suite` (`requested`, `rerequested`) — re-runs on demand from the GitHub UI
- `installation` (`created`, `deleted`, …) — tracks installs per account
- `marketplace_purchase` — tracks plan changes / cancellations

Signature: **required**. `GITHUB_WEBHOOK_SECRET` must be set; payloads are verified against the exact raw bytes (`X-Hub-Signature-256`), never a re-serialized body.

Permissions: Contents read · Pull requests read & write · Checks write · Metadata read.

Ops endpoints (App diagnostics):
- `GET /api/github/app` — App metadata (slug, permissions, events) via App JWT
- `POST /api/github/app/installations/:id/token` — mint/rotate an installation token (never echoes the token)

Preferred credentials (App over PAT):

```bash
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
GITHUB_APP_INSTALLATION_ID=...   # optional if webhook payload includes installation
GITHUB_TOKEN=...                 # fallback PAT
GITHUB_WEBHOOK_SECRET=...        # required
PROOFLOOP_WORKSPACE_ROOT=./.data/workspaces   # auto clone/fetch when localPath missing
PROOFLOOP_AUTO_REGISTER=1
```

Installation tokens are cached in-process and rotated 5 minutes before expiry, so long-running workers never hit an expired token. GitHub API transient failures (429/5xx) are retried with backoff.

Never auto-merges or pushes fixes. Human confirm via API refreshes Check Run + summary when credentials exist.

## GitLab webhook

```bash
GITLAB_URL=https://gitlab.com          # or self-hosted origin
GITLAB_TOKEN=glpat-...                 # api scope for notes + commit status + clone
GITLAB_WEBHOOK_SECRET=...              # matches webhook "Secret token" (X-Gitlab-Token)
PROOFLOOP_WORKSPACE_ROOT=./.data/workspaces
PROOFLOOP_AUTO_REGISTER=1
```

Webhook URL: `POST /api/gitlab/webhook` — MR events (`open`, `update`, `reopen`). Publishes a `ProofLoop` commit status and an updatable MR note. Never auto-merges.

## Configuration

See `proofloop.yml` (generated by `proofloop init`). Unknown commands are not guessed as safe.

- `policies.requireDynamicVerificationFor` — categories that cannot be cleared by lint/typecheck alone
- `policies.blockOn` — risk levels that keep merge blocked (default `critical`, `high`)
- Dashboard **Rules** merge into these policies (preview → save → next check); syncs `proofloop.yml` when `localPath` exists
- Optional API lock: `PROOFLOOP_API_TOKEN` (Bearer). Production requires webhook secrets
- Async checks return immediately; cancel with `POST /api/runs/:id/cancel`
- Optional Redis queue: `REDIS_URL=redis://localhost:6379` (BullMQ). Without it, jobs run in-memory in the API process

## LLM (optional)

```bash
LLM_API_KEY=...
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

Without LLM, the core pipeline still runs with deterministic intent/claims. With LLM, outputs are Zod-validated; schema failures fall back and record `llm_schema_error`.

## Tests

```bash
pnpm test
```

## Directory map

| Path | Purpose |
|------|---------|
| `apps/web` | Web Dashboard |
| `apps/api` | Multi-tenant API + GitHub/GitLab webhooks |
| `apps/cli` | `proofloop` CLI |
| `packages/core` | Domain model + status machine |
| `packages/git` | Git diff / worktree |
| `packages/analyzers` | Project detect + real module resolution + call graph |
| `packages/verifiers` | Safe command execution |
| `packages/llm` | Optional LLM provider |
| `packages/evidence` | Evidence Pack + pipeline |
| `packages/security` | Allowlist + redaction |
| `packages/ui` | Shared UI primitives |
| `fixtures/demo-repo` | Optional TypeScript demo fixture (opt-in) |
| `fixtures/demo-python` | Python analyzer fixture (opt-in) |
| `docs` | Architecture, API, threat model |

## Optional demo

`fixtures/demo-repo` (TypeScript auth-boundary fixture) and `fixtures/demo-python` exist for quick smoke checks. They are **opt-in** and not part of any default path:

```bash
pnpm demo:setup     # create the demo fixture commits
pnpm demo           # run a one-shot check (typically exits 1 — high-risk unknown blocks merge, by design)
pnpm demo:story     # regenerate docs/demo-transcript.txt (bug → block → confirm → merge=yes)
pnpm demo:python    # Python fixture
```

The `pnpm demo` exit code of `1` is intentional: without dynamic evidence the IdP/revocation claim stays `unknown` and merge is blocked (`needs-human-review`). Clear it with a SHA-bound manual verification (`pnpm demo:story` or `confirm --accept`), or add real tests. To drive the same flow from the API, set `PROOFLOOP_DEMO_PATH=./fixtures/demo-repo` before starting the server.

## Docs

- [Architecture](docs/architecture.md)
- [API](docs/api.md)
- [OpenAPI](docs/openapi.yaml)
- [Threat model](docs/threat-model.md)
