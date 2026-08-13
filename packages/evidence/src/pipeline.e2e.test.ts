import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EvidencePackSchema } from './schema.js';
import { runCheckPipeline } from './pipeline.js';

const demoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/demo-repo',
);

describe('demo-repo end-to-end pipeline', () => {
  it('produces verified, passed, and unknown claims with a stable Evidence Pack', async () => {
    if (!existsSync(join(demoRoot, '.git'))) {
      throw new Error('Run `pnpm demo:setup` before e2e tests');
    }

    const { pack, evidencePath, reportPath } = await runCheckPipeline({
      cwd: demoRoot,
      base: 'HEAD~1',
      head: 'HEAD',
      repositoryName: 'proofloop/demo-repo',
      noLlm: true,
    });

    expect(existsSync(evidencePath)).toBe(true);
    expect(existsSync(reportPath)).toBe(true);
    expect(EvidencePackSchema.parse(JSON.parse(readFileSync(evidencePath, 'utf8')))).toBeTruthy();

    expect(pack.claims.length).toBeGreaterThanOrEqual(3);
    const statuses = new Set(pack.claims.map((c) => c.status));
    expect(statuses.has('verified')).toBe(true);
    expect(statuses.has('passed') || statuses.has('verified')).toBe(true);
    expect(statuses.has('unknown') || statuses.has('blocked')).toBe(true);

    expect(pack.verifications.length).toBeGreaterThanOrEqual(3);
    for (const v of pack.verifications as Array<Record<string, unknown>>) {
      expect(v.command).toBeTruthy();
      expect(v.environmentFingerprint).toBeTruthy();
      expect(['passed', 'failed', 'skipped', 'timed_out', 'blocked']).toContain(v.status);
    }

    expect(pack.mergeGate).toBeTruthy();
    expect(pack.run.overallStatus).toBeTruthy();
    // High-risk IdP unknown should block merge in the demo fixture.
    expect(pack.mergeGate?.allowMerge).toBe(false);
    expect(pack.run.overallStatus).toBe('unknown_high_risk');
  }, 120_000);
});
