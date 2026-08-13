import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupStaleWorkspaces } from './workspace.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows may lock files briefly
    }
  }
});

describe('cleanupStaleWorkspaces', () => {
  it('removes only stale git checkouts under owner/name layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'pl-ws-'));
    dirs.push(root);
    mkdirSync(join(root, 'acme', 'shop', '.git'), { recursive: true });
    mkdirSync(join(root, 'acme', 'fresh', '.git'), { recursive: true });
    // non-checkout dir must survive
    mkdirSync(join(root, 'acme', 'notes'), { recursive: true });
    writeFileSync(join(root, 'acme', 'notes', 'a.txt'), 'x');
    // make 'shop' look old by touching mtime far in the past
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    // touch shop/.git dir mtime
    const gitDir = join(root, 'acme', 'shop', '.git');
    const { utimesSync } = require('node:fs');
    utimesSync(gitDir, old, old);
    utimesSync(join(root, 'acme', 'shop'), old, old);

    const removed = cleanupStaleWorkspaces(root, 7 * 24 * 60 * 60 * 1000);
    expect(removed).toContain('acme/shop');
    expect(existsSync(join(root, 'acme', 'shop'))).toBe(false);
    // fresh checkout kept, non-checkout dir kept
    expect(existsSync(join(root, 'acme', 'fresh'))).toBe(true);
    expect(existsSync(join(root, 'acme', 'notes'))).toBe(true);
  });

  it('never deletes symlinks/junctions', () => {
    const root = mkdtempSync(join(tmpdir(), 'pl-ws-link-'));
    dirs.push(root);
    mkdirSync(join(root, 'owner'), { recursive: true });
    const real = mkdtempSync(join(tmpdir(), 'pl-ws-real-'));
    dirs.push(real);
    mkdirSync(join(real, '.git'), { recursive: true });
    try {
      symlinkSync(real, join(root, 'owner', 'linked'), 'junction');
    } catch {
      return; // no symlink support on this platform
    }
    const removed = cleanupStaleWorkspaces(root, 0);
    expect(removed).toEqual([]);
    expect(existsSync(join(root, 'owner', 'linked'))).toBe(true);
    expect(existsSync(real)).toBe(true);
  });
});
