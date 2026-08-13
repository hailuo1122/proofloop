import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveImportPath } from './resolve-import.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('resolveImportPath (real TypeScript resolution)', () => {
  it('resolves tsconfig paths aliases to source files', () => {
    const root = join(tmpdir(), `pl-resolve-paths-${Date.now()}`);
    dirs.push(root);
    mkdirSync(join(root, 'src', 'lib'), { recursive: true });
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@app/*': ['src/*'] },
          moduleResolution: 'bundler',
        },
      }),
    );
    writeFileSync(join(root, 'src', 'lib', 'session.ts'), 'export const x = 1;\n');
    expect(resolveImportPath(root, 'src/index.ts', '@app/lib/session')).toBe('src/lib/session.ts');
    expect(resolveImportPath(root, 'src/index.ts', '@app/lib/session.ts')).toBe(
      'src/lib/session.ts',
    );
  });

  it('maps ESM .js specifiers to their .ts source', () => {
    const root = join(tmpdir(), `pl-resolve-jsmap-${Date.now()}`);
    dirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'token.ts'), 'export const t = 1;\n');
    expect(resolveImportPath(root, 'src/session.ts', './token.js')).toBe('src/token.ts');
  });

  it('resolves package.json exports inside the repo (workspace packages)', () => {
    const root = join(tmpdir(), `pl-resolve-exports-${Date.now()}`);
    dirs.push(root);
    mkdirSync(join(root, 'app'), { recursive: true });
    // node_modules lives inside the repo — the resolved file must be mapped back.
    mkdirSync(join(root, 'node_modules', 'my-pkg', 'dist'), { recursive: true });
    writeFileSync(
      join(root, 'node_modules', 'my-pkg', 'package.json'),
      JSON.stringify({
        name: 'my-pkg',
        version: '1.0.0',
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      }),
    );
    writeFileSync(join(root, 'node_modules', 'my-pkg', 'dist', 'index.js'), 'export const v = 1;\n');
    writeFileSync(
      join(root, 'node_modules', 'my-pkg', 'dist', 'index.d.ts'),
      'export declare const v: number;\n',
    );
    const resolved = resolveImportPath(root, 'app/main.ts', 'my-pkg');
    // Real resolver may surface the .d.ts (types condition) or the .js; must live in the repo.
    expect(resolved).toMatch(/^node_modules\/my-pkg\/dist\/index\.(d\.ts|js)$/);
  });

  it('returns null for node builtins and external packages', () => {
    const root = join(tmpdir(), `pl-resolve-ext-${Date.now()}`);
    dirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const x = 1;\n');
    expect(resolveImportPath(root, 'src/a.ts', 'node:crypto')).toBeNull();
    expect(resolveImportPath(root, 'src/a.ts', 'react')).toBeNull();
    expect(resolveImportPath(root, 'src/a.ts', '@scope/missing')).toBeNull();
  });

  it('falls back to heuristic resolution when no tsconfig exists', () => {
    const root = join(tmpdir(), `pl-resolve-fallback-${Date.now()}`);
    dirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'token.ts'), 'export const t = 1;\n');
    expect(resolveImportPath(root, 'src/index.ts', './token')).toBe('src/token.ts');
    expect(resolveImportPath(root, 'src/index.ts', './missing')).toBeNull();
  });
});
