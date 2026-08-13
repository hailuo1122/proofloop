import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { analyzeTypeScriptFiles } from './typescript.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe('analyzeTypeScriptFiles', () => {
  it('identifies imports exports functions and test association', () => {
    const root = join(tmpdir(), `pl-ts-${Date.now()}`);
    dirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'session.ts'),
      `import { createHash } from 'node:crypto';\nexport function createSession(token: string) { return token; }\nexport class SessionStore {}\n`,
    );
    writeFileSync(
      join(root, 'src', 'session.test.ts'),
      `import { createSession } from './session.js';\nit('works', () => { createSession('a'); });\n`,
    );
    const result = analyzeTypeScriptFiles(root, ['src/session.ts', 'src/session.test.ts']);
    const session = result.find((r) => r.file === 'src/session.ts')!;
    expect(session.imports).toContain('node:crypto');
    expect(session.exports).toContain('createSession');
    expect(session.functions).toContain('createSession');
    expect(session.classes).toContain('SessionStore');
    const test = result.find((r) => r.file === 'src/session.test.ts')!;
    expect(test.symbols.some((s) => s.isTestRelated)).toBe(true);
  });

  it('resolves call sites to their declaring files via the type checker', () => {
    const root = join(tmpdir(), `pl-ts-calls-${Date.now()}`);
    dirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'token.ts'),
      `export function issueToken(uid: string): string { return 't:' + uid; }\n`,
    );
    writeFileSync(
      join(root, 'src', 'session.ts'),
      `import { issueToken } from './token.js';\nexport function createSession(uid: string) { return issueToken(uid); }\n`,
    );
    const result = analyzeTypeScriptFiles(root, ['src/token.ts', 'src/session.ts']);
    const session = result.find((r) => r.file === 'src/session.ts')!;
    expect(session.callEdges?.some((e) => e.symbol === 'issueToken')).toBe(true);
    const edge = session.callEdges!.find((e) => e.symbol === 'issueToken')!;
    expect(edge.targetFile).toBe('src/token.ts');
    // Imported-but-unresolved calls are not mis-attributed to local files.
    expect(
      session.callEdges?.some((e) => e.targetFile === 'src/session.ts'),
    ).toBe(false);
  });

  it('marks calls to external/global targets as targetFile null', () => {
    const root = join(tmpdir(), `pl-ts-ext-${Date.now()}`);
    dirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'main.ts'),
      `import { createHash } from 'node:crypto';\nexport function digest(s: string): string {\n  return createHash('sha256').update(s).digest('hex');\n}\n`,
    );
    const result = analyzeTypeScriptFiles(root, ['src/main.ts']);
    const main = result.find((r) => r.file === 'src/main.ts')!;
    expect(main.callEdges?.some((e) => e.targetFile === null)).toBe(true);
    expect(main.callEdges?.some((e) => e.symbol === 'createHash')).toBe(true);
  });
});
