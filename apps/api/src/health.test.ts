import { afterAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { resetDbForTests } from './db/client.js';

describe('GET /api/health', () => {
  afterAll(() => {
    resetDbForTests();
    try {
      rmSync('./.data/test-health.db', { force: true });
    } catch {
      // ignore
    }
  });

  it('returns 200', async () => {
    process.env.DATABASE_URL = 'file:./.data/test-health.db';
    resetDbForTests();
    const { buildApp } = await import('./app.js');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.requestId).toBeTruthy();
    expect(['memory', 'redis']).toContain(body.queue);
    await app.close();
  });
});

describe('check conclusion mapping', () => {
  it('maps overallStatus', async () => {
    const { mapCheckConclusionForTest } = await import('./github.js');
    expect(mapCheckConclusionForTest('passed')).toBe('success');
    expect(mapCheckConclusionForTest('unknown_high_risk')).toBe('action_required');
  });
});
