import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'demo-repo');

function git(args: string[]) {
  execFileSync('git', args, { cwd: root, stdio: 'inherit' });
}

function gitOut(args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

writeFileSync(
  join(root, '.gitignore'),
  ['node_modules/', 'dist/', '.proofloop/', '*.log', '.DS_Store', 'package-lock.json'].join('\n') +
    '\n',
);

writeFileSync(
  join(root, 'package.json'),
  `{
  "name": "proofloop-demo-repo",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "lint": "node scripts/lint.mjs",
    "typecheck": "node ./node_modules/typescript/bin/tsc --noEmit",
    "test": "node ./node_modules/vitest/vitest.mjs run",
    "build": "node ./node_modules/typescript/bin/tsc -p tsconfig.json --outDir dist"
  },
  "devDependencies": {
    "typescript": "^5.8.2",
    "vitest": "^3.0.8"
  }
}
`,
);

if (existsSync(join(root, '.proofloop'))) {
  rmSync(join(root, '.proofloop'), { recursive: true, force: true });
}
if (existsSync(join(root, 'dist'))) {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
}

execFileSync('npm', ['install'], { cwd: root, stdio: 'inherit', shell: true });
if (!existsSync(join(root, 'node_modules', 'vitest')) || !existsSync(join(root, 'node_modules', 'typescript'))) {
  throw new Error('demo-repo npm install incomplete: vitest/typescript missing');
}

if (existsSync(join(root, '.git'))) {
  rmSync(join(root, '.git'), { recursive: true, force: true });
}

git(['init']);
git(['config', 'user.email', 'demo@proofloop.dev']);
git(['config', 'user.name', 'ProofLoop Demo']);

const sessionPath = join(root, 'src', 'auth', 'session.ts');
mkdirSync(dirname(sessionPath), { recursive: true });
writeFileSync(
  sessionPath,
  `export interface Session {
  userId: string;
  createdAt: number;
}

export interface TokenPayload {
  userId: string;
  exp: number;
}

/** Intentionally buggy: expired tokens still create sessions. */
export function createSession(token: TokenPayload, now = Date.now()): Session | null {
  return {
    userId: token.userId,
    createdAt: now,
  };
}

export function isSessionActive(session: Session, now = Date.now(), ttlMs = 3_600_000): boolean {
  return now - session.createdAt < ttlMs;
}
`,
);

git(['add', '-A']);
git(['commit', '-m', 'feat: add session helper (buggy expiry)']);

writeFileSync(
  sessionPath,
  `export interface Session {
  userId: string;
  createdAt: number;
}

export interface TokenPayload {
  userId: string;
  exp: number;
}

/**
 * Demo PR head: expired tokens must not create sessions.
 */
export function createSession(token: TokenPayload, now = Date.now()): Session | null {
  if (token.exp <= now) return null;
  return {
    userId: token.userId,
    createdAt: now,
  };
}

export function isSessionActive(session: Session, now = Date.now(), ttlMs = 3_600_000): boolean {
  return now - session.createdAt < ttlMs;
}
`,
);

git(['add', '-A']);
git(['commit', '-m', 'fix: reject expired tokens in createSession']);

console.log('Demo repo ready');
console.log('HEAD~1', gitOut(['rev-parse', '--short', 'HEAD~1']));
console.log('HEAD  ', gitOut(['rev-parse', '--short', 'HEAD']));
