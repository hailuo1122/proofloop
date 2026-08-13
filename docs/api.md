# ProofLoop API

Base URL: `http://localhost:8787`

All responses include `requestId`. Errors:

```json
{
  "error": { "code": "not_found", "message": "..." },
  "requestId": "..."
}
```

## Endpoints

- `GET /api/health`
- `GET /api/organizations` / `POST /api/organizations` — multi-tenant orgs
- `GET /api/organizations/:id/repositories` — repos scoped to an org
- `GET /api/github/app` — GitHub App metadata via App JWT
- `POST /api/github/app/installations/:id/token` — mint/rotate installation token (diagnostics)
- `POST /api/demo/bootstrap` — **opt-in** demo fixture (requires `PROOFLOOP_DEMO_PATH`; never falls back to bundled fixtures)
- `GET /api/repositories` — optional `?organizationId=` filter
- `POST /api/repositories`
- `GET /api/repositories/:id/runs`
- `POST /api/repositories/:id/runs`
- `GET /api/runs/:id`
- `GET /api/runs/:id/claims`
- `GET /api/runs/:id/verifications`
- `GET /api/runs/:id/impact-graph`
- `GET /api/runs/:id/evidence-pack`
- `POST /api/runs/:id/cancel`
- `POST /api/runs/:id/claims/:claimId/confirm` — human accept/reject (note required); refreshes GitHub Check/comment when available
- `GET /api/runs/:id/explain` — facts vs inferences vs unknowns
- `POST /api/runs/:id/cancel` — abort in-flight async run
- `GET /api/repositories/:id/history` — runs + metric events
- `GET /api/repositories/:id/rules`
- `POST /api/repositories/:id/rules/preview` — policy delta before save
- `PUT /api/repositories/:id/rules` — persists + merges into next check / proofloop.yml
- `POST /api/github/webhook`
- `POST /api/gitlab/webhook` — MR open/update/reopen; commit status + MR note when `GITLAB_TOKEN` is set

Auth: set `PROOFLOOP_API_TOKEN` to require `Authorization: Bearer …` on mutating routes. Production requires webhook secrets (`GITHUB_WEBHOOK_SECRET` / `GITLAB_WEBHOOK_SECRET`).

Queue: set `REDIS_URL` to use BullMQ; without it, checks run in-process (in-memory). Health reports `queue: "redis" | "memory"`.

OpenAPI machine-readable file: [`openapi.yaml`](./openapi.yaml)
