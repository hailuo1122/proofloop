import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzePythonFiles, analyzePythonFilesViaAst } from './python.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('analyzePythonFiles', () => {
  it('identifies module deps pytest tests and functions', () => {
    const root = join(tmpdir(), `pl-py-${Date.now()}`);
    dirs.push(root);
    mkdirSync(join(root, 'pkg'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(
      join(root, 'pkg', 'auth.py'),
      `import hashlib\nfrom typing import Optional\n\ndef create_session(token: str) -> Optional[str]:\n    return token\n\nclass Store:\n    pass\n`,
    );
    writeFileSync(
      join(root, 'tests', 'test_auth.py'),
      `from pkg.auth import create_session\n\ndef test_create_session():\n    assert create_session('x') == 'x'\n`,
    );
    const result = analyzePythonFiles(root, ['pkg/auth.py', 'tests/test_auth.py']);
    const auth = result.find((r) => r.file === 'pkg/auth.py')!;
    expect(auth.imports).toEqual(expect.arrayContaining(['hashlib', 'typing']));
    expect(auth.functions).toContain('create_session');
    expect(auth.classes).toContain('Store');
    const test = result.find((r) => r.file === 'tests/test_auth.py')!;
    expect(test.isPytest).toBe(true);
    expect(test.functions).toContain('test_create_session');
  });
});

describe('analyzePythonFilesViaAst (stdlib ast bridge)', () => {
  it('returns [] for empty file lists without needing a Python runtime', async () => {
    const root = join(tmpdir(), `pl-py-ast-empty-${Date.now()}`);
    dirs.push(root);
    const result = await analyzePythonFilesViaAst(root, []);
    expect(result).toEqual([]);
  });

  it('parses real Python with the stdlib ast when a runtime exists', async () => {
    const root = join(tmpdir(), `pl-py-ast-${Date.now()}`);
    dirs.push(root);
    mkdirSync(join(root, 'pkg'), { recursive: true });
    writeFileSync(
      join(root, 'pkg', 'auth.py'),
      `import hashlib\nfrom typing import Optional\n\nasync def create_session(token: str) -> Optional[str]:\n    return token\n\nclass Store:\n    def __init__(self) -> None:\n        pass\n`,
    );
    const result = await analyzePythonFilesViaAst(root, ['pkg/auth.py']);
    if (result === null) {
      // No Python interpreter on this machine — regex fallback covers it elsewhere.
      return;
    }
    const auth = result.find((r) => r.file === 'pkg/auth.py')!;
    expect(auth.imports).toEqual(expect.arrayContaining(['hashlib', 'typing']));
    expect(auth.functions).toContain('create_session');
    expect(auth.classes).toContain('Store');
    expect(auth.isPytest).toBe(false);
  });

  it('handles relative and aliased imports via ast', async () => {
    const root = join(tmpdir(), `pl-py-ast-rel-${Date.now()}`);
    dirs.push(root);
    mkdirSync(join(root, 'pkg', 'sub'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'sub', 'mod.py'), `def helper():\n    return 1\n`);
    writeFileSync(
      join(root, 'pkg', 'auth.py'),
      `from .sub.mod import helper as h\nfrom .. import other\n\nh()\nother()\n`,
    );
    const result = await analyzePythonFilesViaAst(root, ['pkg/auth.py', 'pkg/sub/mod.py']);
    if (result === null) return;
    const auth = result.find((r) => r.file === 'pkg/auth.py')!;
    expect(auth.imports).toContain('.sub.mod');
    expect(auth.imports).toContain('..');
    expect(auth.callTargets).toEqual(expect.arrayContaining(['h', 'other']));
  });
});
