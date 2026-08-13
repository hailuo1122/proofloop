# ProofLoop demo repo

Tiny TypeScript service with an intentional authentication boundary bug:

`createSession` accepts expired tokens unless the fix commit is applied.

Use with:

```bash
pnpm install
pnpm proofloop check --cwd fixtures/demo-repo --base HEAD~1 --head HEAD --no-llm
```
