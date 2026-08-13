import { describe, expect, it } from 'vitest';
import type { Claim, RiskFinding, Verification } from '../types.js';
import {
  applyClaimStatuses,
  computeOverallStatus,
  evaluateMergeGate,
  mapOverallToCheckConclusion,
  resolveClaimStatus,
  verificationImpliesFailure,
} from './claim-machine.js';

function claim(partial: Partial<Claim> & Pick<Claim, 'id' | 'title'>): Claim {
  return {
    runId: 'run_1',
    description: '',
    category: 'functional',
    source: 'diff_inference',
    status: 'unknown',
    confidence: 'medium',
    riskWeight: 20,
    relatedFiles: [],
    relatedSymbols: [],
    ...partial,
  };
}

function verification(
  partial: Partial<Verification> & Pick<Verification, 'id' | 'status'>,
): Verification {
  return {
    claimId: null,
    runId: 'run_1',
    type: 'unit_test',
    command: 'pnpm test',
    safeCommand: true,
    exitCode: partial.status === 'passed' ? 0 : 1,
    startedAt: null,
    finishedAt: null,
    durationMs: 10,
    environmentFingerprint: 'env',
    logArtifactId: null,
    resultSummary: '',
    ...partial,
  };
}

describe('resolveClaimStatus', () => {
  it('cannot become verified without a real verification', () => {
    const c = claim({ id: 'c1', title: 'works', category: 'security', riskWeight: 80 });
    expect(resolveClaimStatus({ claim: c, verifications: [] })).toBe('unknown');
    expect(
      resolveClaimStatus({ claim: c, verifications: [], fromLlmOnly: true }),
    ).toBe('inferred');
  });

  it('LLM cannot directly mark verified', () => {
    const c = claim({ id: 'c1', title: 'llm', source: 'pr_description' });
    expect(
      resolveClaimStatus({ claim: c, verifications: [], fromLlmOnly: true }),
    ).not.toBe('verified');
  });

  it('failed verification blocks related claim', () => {
    const c = claim({ id: 'c1', title: 'auth', category: 'security', riskWeight: 80 });
    const v = verification({
      id: 'v1',
      claimId: 'c1',
      status: 'failed',
      type: 'unit_test',
    });
    expect(resolveClaimStatus({ claim: c, verifications: [v] })).toBe('blocked');
  });

  it('skipped verification keeps unknown', () => {
    const c = claim({ id: 'c1', title: 'x' });
    const v = verification({ id: 'v1', claimId: 'c1', status: 'skipped' });
    expect(resolveClaimStatus({ claim: c, verifications: [v] })).toBe('unknown');
  });

  it('timed_out verification degrades to unknown, not blocked', () => {
    const c = claim({ id: 'c1', title: 'x' });
    const v = verification({ id: 'v1', claimId: 'c1', status: 'timed_out' });
    expect(resolveClaimStatus({ claim: c, verifications: [v] })).toBe('unknown');
  });

  it('verificationImpliesFailure excludes timed_out', () => {
    expect(verificationImpliesFailure('failed')).toBe(true);
    expect(verificationImpliesFailure('blocked')).toBe(true);
    expect(verificationImpliesFailure('timed_out')).toBe(false);
  });

  it('high-risk claim needs dynamic verification to be verified', () => {
    const c = claim({
      id: 'c1',
      title: 'token expiry',
      category: 'security',
      riskWeight: 80,
      relatedFiles: ['src/auth/session.ts'],
    });
    const lint = verification({
      id: 'v1',
      claimId: 'c1',
      status: 'passed',
      type: 'lint',
    });
    expect(resolveClaimStatus({ claim: c, verifications: [lint] })).toBe('unknown');
    const test = verification({
      id: 'v2',
      claimId: 'c1',
      status: 'passed',
      type: 'unit_test',
    });
    expect(resolveClaimStatus({ claim: c, verifications: [test] })).toBe('verified');
    const associated = verification({
      id: 'v3',
      claimId: 'other',
      status: 'passed',
      type: 'unit_test',
      relatedClaimIds: ['c1'],
    });
    expect(resolveClaimStatus({ claim: c, verifications: [associated] })).toBe('passed');
  });
});

describe('overallStatus and merge gate', () => {
  it('high-risk unknown blocks merge; low-risk unknown warns', () => {
    const high = claim({
      id: 'c1',
      title: 'auth boundary',
      category: 'security',
      riskWeight: 80,
      status: 'unknown',
    });
    const low = claim({
      id: 'c2',
      title: 'copy tweak',
      category: 'ux',
      riskWeight: 10,
      status: 'unknown',
    });
    const highGate = evaluateMergeGate({
      claims: [high],
      verifications: [],
      findings: [],
    });
    expect(highGate.overallStatus).toBe('unknown_high_risk');
    expect(highGate.allowMerge).toBe(false);

    const lowGate = evaluateMergeGate({
      claims: [low],
      verifications: [],
      findings: [],
    });
    expect(lowGate.overallStatus).toBe('passed_with_warnings');
    expect(lowGate.allowMerge).toBe(true);
  });

  it('maps overallStatus to check conclusions', () => {
    expect(mapOverallToCheckConclusion('passed')).toBe('success');
    expect(mapOverallToCheckConclusion('passed_with_warnings')).toBe('neutral');
    expect(mapOverallToCheckConclusion('unknown_high_risk')).toBe('action_required');
    expect(mapOverallToCheckConclusion('failed')).toBe('failure');
    expect(mapOverallToCheckConclusion('critical_blocked')).toBe('failure');
  });

  it('critical blocked findings take priority', () => {
    const findings: RiskFinding[] = [
      {
        id: 'f1',
        runId: 'run_1',
        severity: 'critical',
        title: 'secret leak',
        description: 'x',
        evidenceRefs: [],
        remediation: 'rotate',
        blocking: true,
        source: 'policy',
      },
    ];
    expect(
      computeOverallStatus({
        claims: [],
        verifications: [],
        findings,
      }),
    ).toBe('critical_blocked');
  });

  it('applyClaimStatuses updates evidence refs', () => {
    const claims = [claim({ id: 'c1', title: 'ok', category: 'functional' })];
    const vers = [
      verification({ id: 'v1', claimId: 'c1', status: 'passed', type: 'lint' }),
    ];
    const updated = applyClaimStatuses(claims, vers);
    expect(updated[0].status).toBe('verified');
    expect(updated[0].evidenceRefs).toEqual(['v1']);
  });
});
