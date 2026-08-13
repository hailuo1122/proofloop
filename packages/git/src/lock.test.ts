import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { withMemoryLock, withPathLock } from './lock.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('locks', () => {
  it('serializes memory lock waiters', async () => {
    const order: number[] = [];
    await Promise.all([
      withMemoryLock('k', async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 30));
        order.push(2);
      }),
      withMemoryLock('k', async () => {
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('path lock is exclusive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pl-lock-'));
    dirs.push(root);
    const lock = join(root, 'x.lock');
    let concurrent = 0;
    let max = 0;
    await Promise.all(
      [1, 2, 3].map(() =>
        withPathLock(lock, async () => {
          concurrent += 1;
          max = Math.max(max, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent -= 1;
        }),
      ),
    );
    expect(max).toBe(1);
  });
});
