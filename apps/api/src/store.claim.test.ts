import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db/migrate.js';
import { resetDbForTests } from './db/client.js';
import {
  claimOrGetHeadRun,
  createRepository,
  getRun,
  putRules,
  listRules,
} from './store.js';

const dirs: string[] = [];

beforeEach(() => {
  resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), 'pl-claim-'));
  dirs.push(dir);
  process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`;
  migrate(process.env.DATABASE_URL);
});

afterEach(() => {
  resetDbForTests();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('head run claims', () => {
  it('returns the same run for duplicate head claims', () => {
    const repo = createRepository({
      provider: 'github',
      owner: 'o',
      name: 'n',
      localPath: '/tmp/x',
    });
    const head = 'a'.repeat(40);
    const first = claimOrGetHeadRun({
      id: 'run_1',
      repositoryId: repo.id,
      baseSha: 'b'.repeat(40),
      headSha: head,
      source: 'github_pr',
      prNumber: 1,
    });
    expect(first.created).toBe(true);
    const second = claimOrGetHeadRun({
      id: 'run_2',
      repositoryId: repo.id,
      baseSha: 'b'.repeat(40),
      headSha: head,
      source: 'github_pr',
      prNumber: 1,
    });
    expect(second.created).toBe(false);
    expect(second.run.id).toBe('run_1');
    expect(getRun('run_2')).toBeUndefined();
  });

  it('putRules replaces atomically', () => {
    const repo = createRepository({
      provider: 'local',
      owner: 'o',
      name: 'n2',
      localPath: '/tmp/y',
    });
    putRules(repo.id, [
      {
        key: 'a',
        description: 'a',
        ruleType: 'security',
        config: { blockOn: ['critical', 'high', 'medium'] },
        enabled: true,
      },
    ]);
    putRules(repo.id, [
      {
        key: 'b',
        description: 'b',
        ruleType: 'security',
        config: { blockOn: ['critical', 'high'] },
        enabled: true,
      },
    ]);
    const rules = listRules(repo.id);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.key).toBe('b');
  });
});
