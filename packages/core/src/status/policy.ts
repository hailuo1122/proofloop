import type { Claim, ClaimCategory, RiskLevel } from '../types.js';
import type { ProofloopConfig } from '../config.js';

export type PolicySlice = ProofloopConfig['policies'];

const RISK_RANK: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const DEFAULT_DYNAMIC: ClaimCategory[] = ['security', 'data', 'compatibility'];

export function categoryRequiresDynamic(
  category: ClaimCategory,
  policies?: PolicySlice,
): boolean {
  const list = policies?.requireDynamicVerificationFor ?? DEFAULT_DYNAMIC;
  return (list as ClaimCategory[]).includes(category);
}

/** True when claim needs dynamic tests or human confirmation under policy. */
export function claimRequiresDynamic(claim: Claim, policies?: PolicySlice): boolean {
  if (claim.riskWeight >= 70) return true;
  if (categoryRequiresDynamic(claim.category, policies)) return true;
  if (
    (claim.category === 'security' || claim.category === 'data') &&
    claim.relatedFiles.some((f) =>
      /auth|session|payment|schema|migration|secret|permission|upload/i.test(f),
    )
  ) {
    return true;
  }
  return false;
}

/** Whether an unresolved risk at this level should block merge. */
export function riskBlockedByPolicy(riskLevel: RiskLevel, policies?: PolicySlice): boolean {
  const blockOn = policies?.blockOn ?? ['critical', 'high'];
  if (blockOn.length === 0) return false;
  const threshold = Math.min(...blockOn.map((b) => RISK_RANK[b as RiskLevel] ?? 99));
  return RISK_RANK[riskLevel] >= threshold;
}

export function policiesFromConfig(config?: ProofloopConfig): PolicySlice | undefined {
  return config?.policies;
}
