import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './db/migrate.js';
import { resetDbForTests } from './db/client.js';
import {
  createQueuedRun,
  createRepository,
  getRun,
  updateRunProgress,
  listMetricEvents,
  requestRunCancel,
  markInterruptedRuns,
} from './store.js';

const dirs: string[] = [];

beforeEach(() => {
  resetDbForTests();
  const dir = mkdtempSync(join(tmpdir(), 'pl-store-'));
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
      // Windows may briefly lock the sqlite file
    }
  }
});

describe('queued runs store', () => {
  it('creates queued run with phase and metric event', () => {
    const repo = createRepository({
      provider: 'local',
      owner: 'o',
      name: 'n',
      localPath: '/tmp/x',
    });
    const run = createQueuedRun({
      id: 'run_test_1',
      repositoryId: repo.id,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      source: 'api',
    });
    expect(run.status).toBe('queued');
    expect(run.phase).toBe('queued');
    updateRunProgress(run.id, { status: 'verifying', phase: 'verifying' });
    expect(getRun(run.id)?.phase).toBe('verifying');
    expect(listMetricEvents(repo.id).some((e) => e.eventType === 'check_started')).toBe(true);
    expect(requestRunCancel(run.id)).toBe(true);
    expect(getRun(run.id)?.cancelRequested).toBe(true);
    expect(getRun(run.id)?.status).toBe('cancelled');
  });

  it('marks in-flight runs interrupted on restart helper', () => {
    const repo = createRepository({
      provider: 'local',
      owner: 'o',
      name: 'n2',
      localPath: '/tmp/y',
    });
    createQueuedRun({
      id: 'run_test_2',
      repositoryId: repo.id,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      source: 'api',
    });
    updateRunProgress('run_test_2', { status: 'analyzing', phase: 'understanding' });
    expect(markInterruptedRuns()).toBeGreaterThanOrEqual(1);
    expect(getRun('run_test_2')?.errorCode).toBe('interrupted_restart');
  });
});
