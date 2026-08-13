import type { Claim, EvidencePack, Verification } from '../api';

/** Map claim + linked evidence to the product-facing status kind. */
export function claimEvidenceKind(
  claim: Claim,
  verifications: Verification[],
  headSha?: string,
): string {
  if (claim.status === 'blocked') return 'blocked';
  if (claim.status === 'inferred') return 'inferred';
  if (claim.status === 'unknown') return 'unknown';

  const manuals = verifications.filter((v) => {
    if (v.type !== 'manual' || v.status !== 'passed') return false;
    if (!(v.claimId === claim.id || v.relatedClaimIds?.includes(claim.id))) return false;
    const bound = (v as { boundHeadSha?: string | null }).boundHeadSha;
    if (headSha && bound && bound !== headSha) return false;
    if (headSha && !bound) return false;
    return true;
  });
  if (manuals.length && (claim.status === 'verified' || claim.status === 'passed')) {
    return 'manual';
  }
  return claim.status;
}

export function activeReviews(pack: EvidencePack) {
  return (pack.humanReviews ?? []).filter((r) => r.status === 'active');
}

export function rejectedReviews(pack: EvidencePack) {
  return (pack.humanReviews ?? []).filter(
    (r) => r.status === 'active' && r.decision === 'reject',
  );
}
