import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'demo-python');

function git(args: string[]) {
  execFileSync('git', args, { cwd: root, stdio: 'inherit' });
}

function gitOut(args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

writeFileSync(
  join(root, '.gitignore'),
  ['__pycache__/', '*.pyc', '.pytest_cache/', '.proofloop/', '.venv/', 'venv/'].join('\n') + '\n',
);

writeFileSync(
  join(root, 'proofloop.yml'),
  `project:
  language: python
  packageManager: pip
commands:
  unit: python -m pytest -q
policies:
  blockOn:
    - critical
    - high
  requireDynamicVerificationFor:
    - security
    - data
  maxTotalDurationSeconds: 300
  allowNetwork: false
redaction:
  enabled: true
`,
);

mkdirSync(join(root, 'pkg'), { recursive: true });
mkdirSync(join(root, 'tests'), { recursive: true });
writeFileSync(join(root, 'pkg', '__init__.py'), '"""ProofLoop Python demo package."""\n');

if (existsSync(join(root, '.proofloop'))) {
  rmSync(join(root, '.proofloop'), { recursive: true, force: true });
}
if (existsSync(join(root, '.git'))) {
  rmSync(join(root, '.git'), { recursive: true, force: true });
}

git(['init']);
git(['config', 'user.email', 'demo@proofloop.dev']);
git(['config', 'user.name', 'ProofLoop Demo']);

writeFileSync(
  join(root, 'pkg', 'auth.py'),
  `from typing import Optional


def create_session(token: str, expired: bool = False) -> Optional[str]:
    """Intentionally buggy: expired tokens still create sessions."""
    return token


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, str] = {}

    def put(self, user_id: str, session: str) -> None:
        self._sessions[user_id] = session
`,
);

writeFileSync(
  join(root, 'tests', 'test_auth.py'),
  `from pkg.auth import SessionStore, create_session


def test_create_session_valid():
    assert create_session("abc") == "abc"


def test_create_session_expired():
    assert create_session("abc", expired=True) is None


def test_store_put():
    store = SessionStore()
    store.put("u1", "s1")
`,
);

git(['add', '-A']);
git(['commit', '-m', 'feat: add python session helper (buggy expiry)']);

writeFileSync(
  join(root, 'pkg', 'auth.py'),
  `from typing import Optional


def create_session(token: str, expired: bool = False) -> Optional[str]:
    """Demo PR head: expired tokens must not create sessions."""
    if expired:
        return None
    return token


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, str] = {}

    def put(self, user_id: str, session: str) -> None:
        self._sessions[user_id] = session
`,
);

git(['add', '-A']);
git(['commit', '-m', 'fix: reject expired tokens in create_session']);

// Ensure pytest is available for the demo check.
try {
  execFileSync('python', ['-m', 'pytest', '--version'], { cwd: root, stdio: 'inherit' });
} catch {
  console.warn('python -m pytest not available; install pytest to run verifications');
}

console.log('Python demo repo ready');
console.log('HEAD~1', gitOut(['rev-parse', '--short', 'HEAD~1']));
console.log('HEAD  ', gitOut(['rev-parse', '--short', 'HEAD']));
