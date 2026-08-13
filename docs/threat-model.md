# ProofLoop Threat Model

## Assets

- Repository source and diffs
- Evidence packs / logs / artifacts
- GitHub tokens and LLM API keys
- Merge gate decisions

## Trust boundaries

1. Developer workstation CLI
2. ProofLoop API process
3. Isolated git worktree command execution
4. GitHub webhook ingress
5. Optional LLM provider egress

## Threats and mitigations

| Threat | Mitigation |
|--------|------------|
| Arbitrary command execution | Allowlist + explicit `proofloop.yml` declarations; denylist for rm/sudo/terraform/kubectl/git push/migrations/curl |
| Secret leakage in logs/UI | Redaction of tokens/passwords/cookies/Authorization/private keys; API never returns raw unredacted secrets |
| Prompt injection / fabricated evidence | LLM outputs Zod-validated; cannot mark `verified`; facts vs inferences separated |
| Webhook spoofing | Optional `GITHUB_WEBHOOK_SECRET` HMAC verification |
| Silent mutation of user tree | Default worktree isolation; no auto-commit/merge/push |
| SSRF via verify commands | `allowNetwork: false` by default; curl/wget blocked |
| Path traversal in artifacts | Artifacts written under run-scoped storage paths |

## Non-goals

- Mathematical proof of program correctness
- Preventing all malicious local developers with shell access
- Multi-tenant enterprise SSO hardening in v0.1
