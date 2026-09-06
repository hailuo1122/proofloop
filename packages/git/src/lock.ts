import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
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

interface LockPayload {
  pid: number;
  createdAt: number;
}

/** Age after which a lockfile is considered abandoned even if its PID looks alive. */
const STALE_LOCK_MS = 10 * 60_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Remove a lockfile only when it is provably abandoned: its owner PID is gone
 * (or its payload is unparsable and it is older than STALE_LOCK_MS). The file is
 * renamed before unlinking so exactly one waiter performs the recovery.
 */
function tryRecoverStaleLock(abs: string): void {
  let payload: LockPayload | null = null;
  let ageMs = 0;
  try {
    payload = JSON.parse(readFileSync(abs, 'utf8')) as LockPayload;
  } catch {
    payload = null;
  }
  try {
    ageMs = Date.now() - statSync(abs).mtimeMs;
  } catch {
    return; // lock already gone
  }
  const ownerDead = payload ? !pidAlive(payload.pid) : ageMs > STALE_LOCK_MS;
  const expired = ageMs > STALE_LOCK_MS;
  if (!ownerDead && !expired) return;
  const stalePath = `${abs}.${randomBytes(4).toString('hex')}.stale`;
  try {
    renameSync(abs, stalePath);
  } catch {
    return; // someone else recovered it first
  }
  try {
    unlinkSync(stalePath);
  } catch {
    /* ignore */
  }
}

/**
 * Cross-process exclusive lock via create-only lockfile (`wx`).
 * Used around git checkout so two API workers cannot force-checkout the same dir.
 * The lockfile records its owner PID; abandoned locks (dead PID or older than
 * STALE_LOCK_MS) are recovered automatically instead of blocking forever.
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
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      } catch (writeErr) {
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
        fd = null;
        throw writeErr;
      }
    } catch {
      tryRecoverStaleLock(abs);
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
