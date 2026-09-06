import { describe, expect, it } from 'vitest';
import { evaluateMergeGate, isHighRiskClaim, resolveClaimStatus } from './claim-machine.js';
import type { Claim, Verification } from '../types.js';

function claim(partial: Partial<Claim> & Pick<Claim, 'id' | 'title' | 'category'>): Claim {
  return {
    runId: 'run_1',
    description: '',
    source: 'diff_inference',
    status: 'unknown',
    confidence: 'low',
    riskWeight: 50,
    relatedFiles: [],
    relatedSymbols: [],
    evidenceRefs: [],
    ...partial,
  };
}

describe('policies', () => {
  it('requireDynamicVerificationFor expands which claims need dynamic evidence', () => {
    const functional = claim({
      id: 'c1',
      title: 'button label',
      category: 'functional',
      riskWeight: 20,
    });
    const lint: Verification = {
      id: 'v1',
      claimId: 'c1',
      runId: 'run_1',
      type: 'lint',
      command: 'pnpm lint',
      safeCommand: true,
      status: 'passed',
      exitCode: 0,
      startedAt: null,
      finishedAt: null,
      durationMs: 1,
      environmentFingerprint: 't',
      logArtifactId: null,
      resultSummary: 'ok',
      relatedClaimIds: ['c1'],
    };

    expect(resolveClaimStatus({ claim: functional, verifications: [lint] })).toBe('verified');
    expect(
      resolveClaimStatus({
        claim: functional,
        verifications: [lint],
        policies: {
          mode: 'blocking',
          blockOn: ['critical', 'high'],
          requireDynamicVerificationFor: ['functional'],
          maxTotalDurationSeconds: 600,
          allowNetwork: false,
        },
      }),
    ).toBe('unknown');
  });

  it('blockOn critical-only allows merge despite high-risk unknowns', () => {
    const high = claim({
      id: 'c1',
      title: 'auth boundary',
      category: 'security',
      riskWeight: 80,
      status: 'unknown',
    });
    expect(isHighRiskClaim(high)).toBe(true);

    const gate = evaluateMergeGate({
      claims: [high],
      verifications: [],
      findings: [],
      policies: {
        mode: 'blocking',
        blockOn: ['critical'],
        requireDynamicVerificationFor: ['security', 'data', 'compatibility'],
        maxTotalDurationSeconds: 600,
        allowNetwork: false,
      },
    });
    expect(gate.overallStatus).toBe('unknown_high_risk');
    expect(gate.allowMerge).toBe(true);
    expect(gate.reason).toMatch(/blockOn excludes high/);
  });

  it('advisory mode allows merge on high-risk unknowns but still blocks failed verifications', () => {
    const high = claim({
      id: 'c1',
      title: 'auth boundary',
      category: 'security',
      riskWeight: 80,
      status: 'unknown',
    });
    const advisory = {
      mode: 'advisory' as const,
      blockOn: ['critical', 'high'] as Array<'critical' | 'high' | 'medium' | 'low'>,
      requireDynamicVerificationFor: [
        'security',
        'data',
        'compatibility',
      ] as Array<'security' | 'data' | 'compatibility' | 'functional' | 'architecture' | 'performance' | 'ux'>,
      maxTotalDurationSeconds: 600,
      allowNetwork: false,
    };
    const unknownGate = evaluateMergeGate({
      claims: [high],
      verifications: [],
      findings: [],
      policies: advisory,
    });
    expect(unknownGate.overallStatus).toBe('unknown_high_risk');
    expect(unknownGate.allowMerge).toBe(true);
    expect(unknownGate.advisoryWouldBlock).toBe(true);
    expect(unknownGate.mode).toBe('advisory');
    expect(unknownGate.reason).toMatch(/advisory mode/);

    const failedGate = evaluateMergeGate({
      claims: [{ ...high, status: 'blocked' }],
      verifications: [
        {
          id: 'v1',
          claimId: 'c1',
          runId: 'run_1',
          type: 'unit_test',
          command: 'pnpm test',
          safeCommand: true,
          status: 'failed',
          exitCode: 1,
          startedAt: null,
          finishedAt: null,
          durationMs: 1,
          environmentFingerprint: 't',
          logArtifactId: null,
          resultSummary: 'fail',
          relatedClaimIds: ['c1'],
        },
      ],
      findings: [],
      policies: advisory,
    });
    expect(failedGate.allowMerge).toBe(false);
    expect(['failed', 'high_blocked', 'critical_blocked']).toContain(failedGate.overallStatus);
  });
});
