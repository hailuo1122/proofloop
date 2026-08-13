import { describe, expect, it } from 'vitest';
import type { Claim, Verification } from '@proofloop/core';
import { buildEvidencePack, renderMarkdownReport } from './pack.js';
import { EvidencePackSchema } from './schema.js';

describe('EvidencePack', () => {
  it('is schema-stable and serializable', () => {
    const claims: Claim[] = [
      {
        id: 'claim_1',
        runId: 'run_1',
        title: '过期 token 不应创建 session',
        description: 'x',
        category: 'security',
        source: 'diff_inference',
        status: 'unknown',
        confidence: 'medium',
        riskWeight: 85,
        relatedFiles: ['src/auth/session.ts'],
        relatedSymbols: ['createSession'],
      },
    ];
    const verifications: Verification[] = [
      {
        id: 'verification_1',
        claimId: 'claim_1',
        runId: 'run_1',
        type: 'unit_test',
        command: 'pnpm test -- --run',
        safeCommand: true,
        status: 'passed',
        exitCode: 0,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 12,
        environmentFingerprint: 'abc',
        logArtifactId: null,
        resultSummary: 'ok',
        relatedClaimIds: ['claim_1'],
      },
    ];
    const pack = buildEvidencePack({
      runId: 'run_1',
      repository: 'owner/repo',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      source: 'cli',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      totalDurationMs: 100,
      intent: {
        id: 'intent_1',
        runId: 'run_1',
        summary: 'Fix session expiry',
        sourceText: 'Fix session expiry',
        confidence: 'medium',
        assumptions: [],
        generatedAt: new Date().toISOString(),
      },
      claims,
      verifications,
      impactNodes: [],
      artifacts: [],
    });
    const json = JSON.stringify(pack);
    const parsed = EvidencePackSchema.parse(JSON.parse(json));
    expect(parsed.schemaVersion).toBe('1.0');
    expect(parsed.claims[0].status).toBe('verified');
    expect(renderMarkdownReport(parsed)).toContain('ProofLoop Evidence Report');
  });
});
