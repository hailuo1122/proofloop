import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCheckPipeline } from './pipeline.js';

const demoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/demo-python',
);

describe('demo-python end-to-end pipeline', () => {
  it.skipIf(!existsSync(join(demoRoot, '.git')))(
    'detects python project and runs pytest when available',
    async () => {

    const { pack } = await runCheckPipeline({
      cwd: demoRoot,
      base: 'HEAD~1',
      head: 'HEAD',
      repositoryName: 'proofloop/demo-python',
      noLlm: true,
    });

    expect(pack.claims.length).toBeGreaterThanOrEqual(3);
    expect(pack.verifications.length).toBeGreaterThanOrEqual(1);
    const unit = (pack.verifications as Array<Record<string, unknown>>).find(
      (v) => v.type === 'unit_test',
    );
    expect(unit).toBeTruthy();
    // If pytest missing, command is blocked/failed — still must be recorded.
    expect(['passed', 'failed', 'blocked', 'skipped']).toContain(unit!.status);
    expect(pack.schemaVersion).toBe('1.0');
    },
    120_000,
  );
});
