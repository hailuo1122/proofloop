import { closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const memoryGates = new Map<string, Promise<unknown>>();

/**
 * Process-local async mutex keyed by an arbitrary string (e.g. repo checkout path).
 * Chains waiters so concurrent jobs for the same key never overlap.
 */
export async function withMemoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = memoryGates.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const tracked = prev.then(() => gate);
  memoryGates.set(key, tracked);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (memoryGates.get(key) === tracked) memoryGates.delete(key);
  }
}

/**
 * Cross-process exclusive lock via create-only lockfile (`wx`).
 * Used around git checkout so two API workers cannot force-checkout the same dir.
 */
export async function withPathLock<T>(
  lockFile: string,
  fn: () => Promise<T>,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<T> {
  const abs = resolve(lockFile);
  mkdirSync(dirname(abs), { recursive: true });
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const pollMs = opts?.pollMs ?? 100;
  const start = Date.now();
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(abs, 'wx');
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`lock_timeout:${abs}`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(abs);
    } catch {
      /* ignore */
    }
  }
}

export function checkoutLockPath(workspaceRoot: string, owner: string, name: string): string {
  return join(resolve(workspaceRoot), '.locks', owner, `${name}.lock`);
}

export function pathLockForDir(dir: string): string {
  return join(resolve(dir), '.proofloop', 'checkout.lock');
}
