import { describe, expect, it } from 'vitest';
import type { Claim, Verification } from '../types.js';
import { applyClaimStatuses, evaluateMergeGate } from './claim-machine.js';
import {
  applyHumanConfirmation,
  claimEvidenceKind,
  claimsNeedingHumanReview,
  filterEffectiveVerifications,
} from './human-review.js';

function claim(partial: Partial<Claim> & Pick<Claim, 'id' | 'title'>): Claim {
  return {
    runId: 'run_1',
    description: '',
    category: 'security',
    source: 'diff_inference',
    status: 'unknown',
    confidence: 'low',
    riskWeight: 80,
    relatedFiles: ['src/auth/session.ts'],
    relatedSymbols: [],
    ...partial,
  };
}

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('human review', () => {
  it('lists high-risk unknowns as needing review', () => {
    const claims = [
      claim({ id: 'c1', title: 'idp' }),
      claim({
        id: 'c2',
        title: 'copy',
        category: 'ux',
        riskWeight: 10,
        relatedFiles: [],
      }),
    ];
    expect(claimsNeedingHumanReview(claims).map((c) => c.id)).toEqual(['c1']);
  });

  it('accepting a high-risk unknown via manual verification unblocks merge', () => {
    const claims = [claim({ id: 'c1', title: 'idp revocation' })];
    const before = evaluateMergeGate({ claims, verifications: [], findings: [] });
    expect(before.allowMerge).toBe(false);
    expect(before.overallStatus).toBe('unknown_high_risk');

    const { claims: next, verifications, review } = applyHumanConfirmation({
      claims,
      verifications: [],
      confirmation: {
        runId: 'run_1',
        claimId: 'c1',
        headSha: SHA_A,
        decision: 'accept',
        note: 'Reviewed IdP behavior offline',
        reviewer: 'alice',
      },
    });

    expect(next[0].status).toBe('verified');
    expect(review.headSha).toBe(SHA_A);
    expect(review.reviewer).toBe('alice');
    expect(review.note).toBe('Reviewed IdP behavior offline');
    expect(verifications[0].boundHeadSha).toBe(SHA_A);
    const gate = evaluateMergeGate({
      claims: next,
      verifications,
      findings: [],
      headSha: SHA_A,
    });
    expect(gate.allowMerge).toBe(true);
    expect(gate.overallStatus).toBe('passed');
    expect(claimEvidenceKind(next[0], verifications, SHA_A)).toBe('manual');
  });

  it('rejecting marks the claim blocked', () => {
    const claims = [claim({ id: 'c1', title: 'idp' })];
    const { claims: next, review } = applyHumanConfirmation({
      claims,
      verifications: [],
      confirmation: {
        runId: 'run_1',
        claimId: 'c1',
        headSha: SHA_A,
        decision: 'reject',
        note: 'Still unsafe',
        reviewer: 'bob',
      },
    });
    expect(next[0].status).toBe('blocked');
    expect(review.decision).toBe('reject');
    expect(review.note).toBe('Still unsafe');
  });

  it('manual confirmation is a real verification, not LLM inferred', () => {
    const claims = [claim({ id: 'c1', title: 'idp' })];
    const { claims: next, verifications } = applyHumanConfirmation({
      claims,
      verifications: [],
      confirmation: {
        runId: 'run_1',
        claimId: 'c1',
        headSha: SHA_A,
        decision: 'accept',
        reviewer: 'alice',
        note: 'Reviewed offline',
      },
    });
    const scored = applyClaimStatuses(next, verifications, { headSha: SHA_A });
    expect(scored[0].status).toBe('verified');
    expect(verifications[0].type).toBe('manual');
    expect(verifications[0].command).toBe('human-review:accept');
  });

  it('invalidates manual verification after head SHA changes', () => {
    const claims = [claim({ id: 'c1', title: 'idp' })];
    const { claims: accepted, verifications } = applyHumanConfirmation({
      claims,
      verifications: [],
      confirmation: {
        runId: 'run_1',
        claimId: 'c1',
        headSha: SHA_A,
        decision: 'accept',
        reviewer: 'alice',
        note: 'ok on old tip',
      },
    });
    expect(accepted[0].status).toBe('verified');

    const effective = filterEffectiveVerifications(verifications, SHA_B);
    expect(effective.filter((v) => v.type === 'manual')).toHaveLength(0);

    const rescored = applyClaimStatuses(claims, verifications, { headSha: SHA_B });
    expect(rescored[0].status).toBe('unknown');
    const gate = evaluateMergeGate({
      claims: rescored,
      verifications,
      findings: [],
      headSha: SHA_B,
    });
    expect(gate.allowMerge).toBe(false);
    expect(gate.overallStatus).toBe('unknown_high_risk');
  });

  it('repeated identical confirm is idempotent', () => {
    const claims = [claim({ id: 'c1', title: 'idp' })];
    const first = applyHumanConfirmation({
      claims,
      verifications: [],
      confirmation: {
        runId: 'run_1',
        claimId: 'c1',
        headSha: SHA_A,
        decision: 'accept',
        reviewer: 'alice',
        note: 'same',
      },
    });
    const second = applyHumanConfirmation({
      claims: first.claims,
      verifications: first.verifications,
      reviews: first.reviews,
      confirmation: {
        runId: 'run_1',
        claimId: 'c1',
        headSha: SHA_A,
        decision: 'accept',
        reviewer: 'alice',
        note: 'same',
      },
    });
    expect(second.idempotent).toBe(true);
    expect(second.verifications.filter((v) => v.type === 'manual')).toHaveLength(1);
    expect(second.reviews.filter((r) => r.status === 'active')).toHaveLength(1);
  });

  it('changing decision supersedes prior active review', () => {
    const claims = [claim({ id: 'c1', title: 'idp' })];
    const accepted = applyHumanConfirmation({
      claims,
      verifications: [],
      confirmation: {
        runId: 'run_1',
        claimId: 'c1',
        headSha: SHA_A,
        decision: 'accept',
        reviewer: 'alice',
        note: 'ok',
      },
    });
    const rejected = applyHumanConfirmation({
      claims: accepted.claims,
      verifications: accepted.verifications,
      reviews: accepted.reviews,
      confirmation: {
        runId: 'run_1',
        claimId: 'c1',
        headSha: SHA_A,
        decision: 'reject',
        reviewer: 'alice',
        note: 'changed mind',
      },
    });
    expect(rejected.idempotent).toBe(false);
    expect(rejected.claims[0].status).toBe('blocked');
    expect(rejected.reviews.filter((r) => r.status === 'superseded')).toHaveLength(1);
    expect(rejected.reviews.filter((r) => r.status === 'active')).toHaveLength(1);
  });
});
