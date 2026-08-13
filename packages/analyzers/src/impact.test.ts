import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildImpactGraph } from './impact.js';
import { analyzeTypeScriptFiles } from './typescript.js';

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('buildImpactGraph', () => {
  it('emits edges from changed files to imports/symbols', () => {
    const graph = buildImpactGraph({
      runId: 'run_1',
      diffFiles: [{ path: 'src/auth/session.ts', status: 'modified' }],
      ts: [
        {
          file: 'src/auth/session.ts',
          imports: ['./token'],
          resolvedImports: [{ specifier: './token', resolvedPath: null }],
          exports: ['createSession'],
          functions: ['createSession'],
          classes: [],
          callTargets: [],
          symbols: [
            {
              name: 'createSession',
              kind: 'function',
              file: 'src/auth/session.ts',
              isTestRelated: false,
            },
          ],
        },
      ],
    });
    expect(graph.nodes.length).toBeGreaterThan(1);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.edges.every((e) => e.fromNodeId && e.toNodeId)).toBe(true);
  });

  it('resolves relative imports into imported_by and calls edges', () => {
    const root = mkdtempSync(join(tmpdir(), 'pl-impact-'));
    temps.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'token.ts'),
      `export function issueToken() { return 't'; }\n`,
    );
    writeFileSync(
      join(root, 'src', 'session.ts'),
      `import { issueToken } from './token';\nexport function createSession() { return issueToken(); }\n`,
    );
    const ts = analyzeTypeScriptFiles(root, ['src/token.ts', 'src/session.ts']);
    const graph = buildImpactGraph({
      runId: 'run_2',
      diffFiles: [{ path: 'src/token.ts', status: 'modified' }],
      ts,
    });
    const relations = new Set(graph.edges.map((e) => e.relation));
    expect(relations.has('imports')).toBe(true);
    expect(relations.has('imported_by')).toBe(true);
    expect(relations.has('calls')).toBe(true);
    expect(graph.coverageNote).toMatch(/file-level edges/i);
    // Transitive impact: files depending on changed files surface in affectedFiles.
    expect(graph.affectedFiles).toContain('src/session.ts');
    expect(graph.affectedFiles).not.toContain('src/token.ts');
    expect(graph.coverageNote).not.toMatch(/partial/i);
    expect(graph.coverageNote).toMatch(/transitively affected/i);
  });

  it('computes transitive impact across import chains', () => {
    const root = mkdtempSync(join(tmpdir(), 'pl-impact-chain-'));
    temps.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'lib.ts'), `export const x = 1;\n`);
    writeFileSync(join(root, 'src', 'api.ts'), `import { x } from './lib.js';\nexport const y = x + 1;\n`);
    writeFileSync(
      join(root, 'src', 'app.ts'),
      `import { y } from './api.js';\nexport const z = y + 1;\n`,
    );
    const ts = analyzeTypeScriptFiles(root, ['src/lib.ts', 'src/api.ts', 'src/app.ts']);
    const graph = buildImpactGraph({
      runId: 'run_3',
      diffFiles: [{ path: 'src/lib.ts', status: 'modified' }],
      ts,
    });
    // lib.ts changed → api.ts imports it → app.ts imports api.ts
    expect(graph.affectedFiles).toEqual(
      expect.arrayContaining(['src/api.ts', 'src/app.ts']),
    );
  });
});
