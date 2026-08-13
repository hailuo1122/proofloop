import { createId } from '../ids.js';
import type {
  Claim,
  HumanReviewDecision,
  HumanReviewRecord,
  Verification,
} from '../types.js';
import { applyClaimStatuses, evaluateMergeGate, isHighRiskClaim } from './claim-machine.js';
import { filterEffectiveVerifications } from './manual-scope.js';
import type { PolicySlice } from './policy.js';

export { filterEffectiveVerifications } from './manual-scope.js';

export interface HumanConfirmationInput {
  runId: string;
  claimId: string;
  headSha: string;
  decision: HumanReviewDecision;
  note?: string;
  reviewer?: string;
  at?: string;
}

export function createManualVerification(input: HumanConfirmationInput): Verification {
  const at = input.at ?? new Date().toISOString();
  const accepted = input.decision === 'accept';
  const reviewer = input.reviewer?.trim();
  if (!reviewer) {
    throw new Error('reviewer_required');
  }
  const note = input.note?.trim() || '';
  if (!note) {
    throw new Error('note_required');
  }
  return {
    id: createId('verification'),
    claimId: input.claimId,
    runId: input.runId,
    type: 'manual',
    command: `human-review:${input.decision}`,
    safeCommand: true,
    status: accepted ? 'passed' : 'failed',
    exitCode: accepted ? 0 : 1,
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
    environmentFingerprint: `human-review@${input.headSha}`,
    logArtifactId: null,
    boundHeadSha: input.headSha,
    reviewer,
    reviewNote: note || null,
    resultSummary: [
      `Human ${input.decision}`,
      `sha=${input.headSha.slice(0, 12)}`,
      `by ${reviewer}`,
      note ? `reason: ${note}` : null,
    ]
      .filter(Boolean)
      .join(' · '),
    relatedClaimIds: [input.claimId],
  };
}

export function createHumanReviewRecord(input: {
  confirmation: HumanConfirmationInput;
  verificationId: string;
  status?: HumanReviewRecord['status'];
  invalidationReason?: string;
}): HumanReviewRecord {
  const at = input.confirmation.at ?? new Date().toISOString();
  return {
    id: createId('review'),
    runId: input.confirmation.runId,
    claimId: input.confirmation.claimId,
    headSha: input.confirmation.headSha,
    decision: input.confirmation.decision,
    reviewer: input.confirmation.reviewer?.trim() || '',
    note: input.confirmation.note?.trim() || '',
    at,
    verificationId: input.verificationId,
    status: input.status ?? 'active',
    invalidationReason: input.invalidationReason,
  };
}

export function invalidateStaleManualReviews(
  reviews: HumanReviewRecord[],
  headSha: string,
): HumanReviewRecord[] {
  return reviews.map((r) => {
    if (r.status !== 'active') return r;
    if (r.headSha === headSha) return r;
    return {
      ...r,
      status: 'invalidated' as const,
      invalidationReason: `head moved: bound ${r.headSha.slice(0, 8)} ≠ current ${headSha.slice(0, 8)}`,
    };
  });
}

export function findActiveReview(
  reviews: HumanReviewRecord[],
  claimId: string,
  headSha: string,
): HumanReviewRecord | undefined {
  return [...reviews]
    .reverse()
    .find((r) => r.claimId === claimId && r.headSha === headSha && r.status === 'active');
}

export function applyHumanConfirmation(input: {
  claims: Claim[];
  verifications: Verification[];
  reviews?: HumanReviewRecord[];
  confirmation: HumanConfirmationInput;
  llmClaimIds?: Set<string>;
  policies?: PolicySlice;
}): {
  claims: Claim[];
  verifications: Verification[];
  reviews: HumanReviewRecord[];
  manual: Verification;
  review: HumanReviewRecord;
  idempotent: boolean;
} {
  const claim = input.claims.find((c) => c.id === input.confirmation.claimId);
  if (!claim) {
    throw new Error(`claim_not_found:${input.confirmation.claimId}`);
  }
  if (!input.confirmation.headSha) {
    throw new Error('head_sha_required');
  }
  if (!input.confirmation.note?.trim()) {
    throw new Error('note_required');
  }
  if (!input.confirmation.reviewer?.trim()) {
    throw new Error('reviewer_required');
  }

  const existingReviews = input.reviews ?? [];
  const active = findActiveReview(
    existingReviews,
    input.confirmation.claimId,
    input.confirmation.headSha,
  );

  if (
    active &&
    active.decision === input.confirmation.decision &&
    active.reviewer === input.confirmation.reviewer.trim() &&
    active.note === input.confirmation.note.trim()
  ) {
    const manual =
      input.verifications.find((v) => v.id === active.verificationId) ??
      createManualVerification(input.confirmation);
    const verifications = filterEffectiveVerifications(
      input.verifications.some((v) => v.id === manual.id)
        ? input.verifications
        : [...input.verifications, manual],
      input.confirmation.headSha,
    );
    const claims = applyClaimStatuses(input.claims, verifications, {
      llmClaimIds: input.llmClaimIds,
      policies: input.policies,
      headSha: input.confirmation.headSha,
    });
    return {
      claims,
      verifications: input.verifications.some((v) => v.id === manual.id)
        ? input.verifications
        : [...input.verifications, manual],
      reviews: existingReviews,
      manual,
      review: active,
      idempotent: true,
    };
  }

  const manual = createManualVerification(input.confirmation);
  const review = createHumanReviewRecord({
    confirmation: input.confirmation,
    verificationId: manual.id,
  });

  let reviews = invalidateStaleManualReviews(existingReviews, input.confirmation.headSha).map(
    (r) => {
      if (
        r.status === 'active' &&
        r.claimId === input.confirmation.claimId &&
        r.headSha === input.confirmation.headSha
      ) {
        return {
          ...r,
          status: 'superseded' as const,
          invalidationReason: `superseded by ${review.id}`,
        };
      }
      return r;
    },
  );
  reviews = [...reviews, review];

  const verifications = [...input.verifications, manual];
  const effective = filterEffectiveVerifications(verifications, input.confirmation.headSha);
  const claims = applyClaimStatuses(input.claims, effective, {
    llmClaimIds: input.llmClaimIds,
    policies: input.policies,
    headSha: input.confirmation.headSha,
  });

  return { claims, verifications, reviews, manual, review, idempotent: false };
}

export function claimsNeedingHumanReview(claims: Claim[], policies?: PolicySlice): Claim[] {
  return claims.filter(
    (c) =>
      isHighRiskClaim(c, policies) &&
      (c.status === 'unknown' || c.status === 'inferred'),
  );
}

export function reviewSummary(
  claims: Claim[],
  verifications: Verification[],
  policies?: PolicySlice,
  headSha?: string,
) {
  const effective = filterEffectiveVerifications(verifications, headSha);
  const scored = applyClaimStatuses(claims, effective, { policies, headSha });
  const gate = evaluateMergeGate({
    claims: scored,
    verifications: effective,
    findings: [],
    policies,
  });
  const needing = claimsNeedingHumanReview(scored, policies);
  return {
    needsHumanReview: needing.length > 0 || gate.overallStatus === 'unknown_high_risk',
    pendingClaimIds: needing.map((c) => c.id),
    allowMerge: gate.allowMerge,
    overallStatus: gate.overallStatus,
    reason: gate.reason,
  };
}

export function claimEvidenceKind(
  claim: Claim,
  verifications: Verification[],
  headSha?: string,
): 'verified' | 'passed' | 'manual' | 'inferred' | 'unknown' | 'blocked' {
  if (claim.status === 'blocked') return 'blocked';
  if (claim.status === 'inferred') return 'inferred';
  if (claim.status === 'unknown') return 'unknown';
  const effective = filterEffectiveVerifications(verifications, headSha);
  const manuals = effective.filter(
    (v) =>
      v.type === 'manual' &&
      v.status === 'passed' &&
      (v.claimId === claim.id || v.relatedClaimIds?.includes(claim.id)),
  );
  if (manuals.length && (claim.status === 'verified' || claim.status === 'passed')) {
    return 'manual';
  }
  if (claim.status === 'verified') return 'verified';
  if (claim.status === 'passed') return 'passed';
  return claim.status;
}
