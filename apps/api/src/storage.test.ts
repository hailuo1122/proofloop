import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEvidenceStorage, resetEvidenceStorageForTests } from './storage.js';

const dirs: string[] = [];

beforeEach(() => {
  resetEvidenceStorageForTests();
  delete process.env.S3_BUCKET;
  delete process.env.S3_ENDPOINT;
  delete process.env.S3_ACCESS_KEY_ID;
  delete process.env.S3_SECRET_ACCESS_KEY;
  const dir = mkdtempSync(join(tmpdir(), 'pl-storage-'));
  dirs.push(dir);
  process.env.PROOFLOOP_EVIDENCE_ROOT = dir;
});

afterEach(() => {
  resetEvidenceStorageForTests();
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('getEvidenceStorage (local backend)', () => {
  it('round-trips a pack under the configured root', async () => {
    const storage = getEvidenceStorage();
    await storage.put('evidence/run_1.json', '{"ok":true}');
    expect(await storage.get('evidence/run_1.json')).toBe('{"ok":true}');
    expect(await storage.get('evidence/missing.json')).toBeNull();
  });

  it('falls back to local disk when S3 is not configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pl-storage-fallback-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'evidence.json'), '{"x":1}');
    expect(getEvidenceStorage()).toBeDefined();
  });

  it('rejects path traversal keys', async () => {
    const storage = getEvidenceStorage();
    await expect(storage.put('../escape.json', 'x')).rejects.toThrow();
  });
});

describe('S3 configuration', () => {
  it('requires credentials when S3_BUCKET is set', async () => {
    process.env.S3_BUCKET = 'proofloop';
    process.env.S3_ENDPOINT = 'http://localhost:9000';
    expect(() => getEvidenceStorage()).toThrow(/S3_ACCESS_KEY_ID/);
  });
});
