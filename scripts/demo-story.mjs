#!/usr/bin/env node
/**
 * 30–60s story: bug fixture → check → unknown_high_risk → confirm → merge=yes
 * Writes docs/demo-transcript.txt for README.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cwd = join(root, 'fixtures', 'demo-repo');
const outPath = join(root, 'docs', 'demo-transcript.txt');
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const proofloop = join(root, 'scripts', 'proofloop.mjs');
const setupScript = join(root, 'scripts', 'setup-demo-repo.ts');

function runNode(args, opts = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd: opts.cwd ?? root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { code: r.status ?? 1, text };
}

const lines = [];
function log(s = '') {
  lines.push(s);
  console.log(s);
}

log('$ pnpm demo:setup');
const setup = runNode([tsx, setupScript]);
if (setup.code !== 0) {
  console.error(setup.text);
  process.exit(setup.code);
}
log('# fixture ready (auth-boundary bug commit)');
log('');

log('$ pnpm proofloop check --cwd ./fixtures/demo-repo --base HEAD~1 --head HEAD --no-llm');
const check = runNode([
  proofloop,
  'check',
  '--cwd',
  './fixtures/demo-repo',
  '--base',
  'HEAD~1',
  '--head',
  'HEAD',
  '--no-llm',
]);
const checkLines = check.text
  .split(/\r?\n/)
  .filter(
    (l) =>
      /Overall|merge=|Run id|unknown|verified|passed|Claim|Evidence|needs-human|risk/i.test(l) ||
      l.startsWith('Run ') ||
      l.startsWith('- ['),
  )
  .slice(0, 40);
for (const l of checkLines) log(l);
if (!/unknown_high_risk|merge=no/i.test(check.text)) {
  log(check.text.trim().slice(-800));
}
log('');

const runsDir = join(cwd, '.proofloop', 'runs');
const runId = existsSync(runsDir)
  ? readdirSync(runsDir)
      .filter((d) => existsSync(join(runsDir, d, 'evidence.json')))
      .sort()
      .at(-1)
  : null;
if (!runId) {
  console.error('No run found');
  process.exit(1);
}
const pack = JSON.parse(readFileSync(join(runsDir, runId, 'evidence.json'), 'utf8'));
const unknown =
  pack.claims.find((c) => c.status === 'unknown' && (c.riskWeight ?? 0) >= 70) ??
  pack.claims.find((c) => c.status === 'unknown');
if (!unknown) {
  console.error('No unknown claim');
  process.exit(1);
}

log(
  `$ pnpm proofloop confirm ${runId} ${unknown.id} --accept --note "IdP path reviewed" --reviewer demo --cwd ./fixtures/demo-repo`,
);
const confirm = runNode([
  proofloop,
  'confirm',
  runId,
  unknown.id,
  '--accept',
  '--note',
  'IdP path reviewed',
  '--reviewer',
  'demo',
  '--cwd',
  './fixtures/demo-repo',
]);
for (const l of confirm.text.split(/\r?\n/).filter(Boolean).slice(-12)) log(l);
if (confirm.code !== 0) {
  console.error(confirm.text);
  process.exit(confirm.code);
}
log('');
log('# Story complete: bug → unknown_high_risk → manual verification → merge=yes');
log('# Note: a new commit invalidates this accept (SHA-bound).');

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`\nWrote ${outPath}`);
process.exit(0);
