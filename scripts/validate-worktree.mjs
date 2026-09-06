/**
 * One-off validation: create a worktree of THIS monorepo and run `pnpm
 * typecheck` inside it. Before the junction fix, per-package node_modules were
 * missing in the worktree and typecheck failed with "cannot find module
 * 'vitest'/'zod'" — a false negative. This script must report `passed`.
 */
import { execFileSync } from 'node:child_process';
import { runVerifications } from '../packages/verifiers/src/runner.js';

const repoRoot = process.cwd();
const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();

const result = await runVerifications({
  repoRoot,
  runId: 'run_wt_validate',
  headSha,
  plans: [{ type: 'typecheck', command: 'pnpm typecheck', relatedClaimIds: [] }],
  storageRoot: `${repoRoot}/.proofloop/storage`,
  timeoutMsPerCommand: 300_000,
  declaredSafeCommands: ['pnpm typecheck'],
  useWorktree: true,
});

for (const v of result.verifications) {
  console.log(`${v.type}: ${v.status} (${v.durationMs}ms) exit=${v.exitCode}`);
  console.log((v.resultSummary ?? '').slice(0, 300));
}
if (result.verifications[0]?.status !== 'passed') {
  console.error('WORKTREE VALIDATION FAILED');
  process.exit(1);
}
console.log('WORKTREE VALIDATION OK');
