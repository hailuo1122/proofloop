import type {
  Claim,
  ClaimStatus,
  OverallStatus,
  RiskFinding,
  RiskLevel,
  Verification,
  VerificationStatus,
  MergeGate,
} from '../types.js';
import { filterEffectiveVerifications } from './manual-scope.js';
import { claimRequiresDynamic, riskBlockedByPolicy, type PolicySlice } from './policy.js';

const DYNAMIC_TYPES = new Set([
  'unit_test',
  'integration_test',
  'security_scan',
  'manual',
]);

export function isHighRiskClaim(claim: Claim, policies?: PolicySlice): boolean {
  return claimRequiresDynamic(claim, policies);
}

export function resolveClaimStatus(input: {
  claim: Claim;
  verifications: Verification[];
  fromLlmOnly?: boolean;
  policies?: PolicySlice;
}): ClaimStatus {
  const { claim, verifications, fromLlmOnly, policies } = input;
  const related = verifications.filter(
    (v) =>
      v.claimId === claim.id ||
      (v.relatedClaimIds?.includes(claim.id) ?? false),
  );

  if (related.some((v) => v.status === 'blocked')) {
    return 'blocked';
  }

  const executed = related.filter((v) =>
    ['passed', 'failed', 'timed_out'].includes(v.status),
  );

  if (executed.length === 0) {
    // LLM-only claims are inferences, never facts — no execution can ever make
    // one `verified`. Claims without any evidence are simply unknown.
    return fromLlmOnly ? 'inferred' : 'unknown';
  }

  // A failed verification is hard evidence against the claim. A timed_out run
  // is closer to "never established" than "proven broken" (resource limits,
  // CI hiccups), so it degrades to `unknown` below instead of `blocked`.
  if (executed.some((v) => v.status === 'failed')) {
    return 'blocked';
  }

  const passed = executed.filter((v) => v.status === 'passed');
  if (passed.length === 0) {
    return 'unknown';
  }

  if (related.some((v) => v.status === 'skipped')) {
    return 'unknown';
  }

  if (isHighRiskClaim(claim, policies)) {
    const dynamicPassed = passed.filter((v) => DYNAMIC_TYPES.has(v.type));
    if (dynamicPassed.length === 0) {
      return 'unknown';
    }
    if (dynamicPassed.some((v) => v.claimId === claim.id)) {
      return 'verified';
    }
    return 'passed';
  }

  if (passed.some((v) => v.claimId === claim.id)) {
    return 'verified';
  }
  return 'passed';
}

export function applyClaimStatuses(
  claims: Claim[],
  verifications: Verification[],
  opts?: { llmClaimIds?: Set<string>; policies?: PolicySlice; headSha?: string },
): Claim[] {
  const effective = filterEffectiveVerifications(verifications, opts?.headSha);
  return claims.map((claim) => ({
    ...claim,
    status: resolveClaimStatus({
      claim,
      verifications: effective,
      fromLlmOnly: opts?.llmClaimIds?.has(claim.id) ?? false,
      policies: opts?.policies,
    }),
    evidenceRefs: [
      ...new Set(
        effective
          .filter(
            (v) =>
              v.claimId === claim.id ||
              (v.relatedClaimIds?.includes(claim.id) ?? false),
          )
          .filter((v) => v.status === 'passed')
          .map((v) => v.id),
      ),
    ],
  }));
}

export function computeRiskLevel(
  claims: Claim[],
  findings: RiskFinding[],
  policies?: PolicySlice,
): RiskLevel {
  if (
    findings.some((f) => f.severity === 'critical' && f.blocking) ||
    claims.some((c) => c.riskWeight >= 90 && c.status === 'blocked')
  ) {
    return 'critical';
  }
  if (
    findings.some((f) => f.severity === 'high' && f.blocking) ||
    claims.some(
      (c) => isHighRiskClaim(c, policies) && (c.status === 'blocked' || c.status === 'unknown'),
    )
  ) {
    return 'high';
  }
  if (findings.some((f) => f.severity === 'medium') || claims.some((c) => c.riskWeight >= 40)) {
    return 'medium';
  }
  return 'low';
}

export function computeOverallStatus(input: {
  claims: Claim[];
  verifications: Verification[];
  findings: RiskFinding[];
  policies?: PolicySlice;
  headSha?: string;
}): OverallStatus {
  const { claims, findings, policies } = input;
  const verifications = filterEffectiveVerifications(input.verifications, input.headSha);
  const risk = computeRiskLevel(claims, findings, policies);

  if (findings.some((f) => f.blocking && f.severity === 'critical') || risk === 'critical') {
    if (
      claims.some((c) => c.status === 'blocked' && isHighRiskClaim(c, policies)) ||
      findings.some((f) => f.blocking && f.severity === 'critical')
    ) {
      return 'critical_blocked';
    }
    // Risk is critical (riskWeight >= 90 blocked claim) but no blocked high-risk
    // claim — fall through with the risk still recorded. This preserves the
    // documented behavior while removing the fragile find-fallback.
  }

  if (
    findings.some((f) => f.blocking && f.severity === 'high') ||
    claims.some((c) => c.status === 'blocked' && isHighRiskClaim(c, policies))
  ) {
    return 'high_blocked';
  }

  if (
    verifications.some((v) => v.status === 'failed') ||
    claims.some((c) => c.status === 'blocked')
  ) {
    return 'failed';
  }

  if (
    claims.some(
      (c) => isHighRiskClaim(c, policies) && (c.status === 'unknown' || c.status === 'inferred'),
    )
  ) {
    return 'unknown_high_risk';
  }

  if (
    claims.some((c) => c.status === 'unknown' || c.status === 'inferred') ||
    findings.some((f) => !f.blocking && ['medium', 'high'].includes(f.severity))
  ) {
    return 'passed_with_warnings';
  }

  return 'passed';
}

export function evaluateMergeGate(input: {
  claims: Claim[];
  verifications: Verification[];
  findings: RiskFinding[];
  policies?: PolicySlice;
  headSha?: string;
}): MergeGate {
  const mode = input.policies?.mode ?? 'blocking';
  const overallStatus = computeOverallStatus(input);
  const riskLevel = computeRiskLevel(input.claims, input.findings, input.policies);
  const blockingFindings = input.findings.filter((f) => f.blocking).map((f) => f.title);
  const highUnknown = input.claims.filter(
    (c) =>
      isHighRiskClaim(c, input.policies) &&
      (c.status === 'unknown' || c.status === 'inferred' || c.status === 'blocked'),
  );

  let allowMerge = overallStatus === 'passed' || overallStatus === 'passed_with_warnings';

  if (overallStatus === 'failed') {
    allowMerge = false;
  } else if (overallStatus === 'critical_blocked') {
    allowMerge = !riskBlockedByPolicy('critical', input.policies);
  } else if (overallStatus === 'high_blocked') {
    // Failed high-risk verification / blocked claim — still hard-blocks in advisory.
    allowMerge = !riskBlockedByPolicy('high', input.policies);
  } else if (overallStatus === 'unknown_high_risk') {
    allowMerge = !riskBlockedByPolicy('high', input.policies);
  } else if (allowMerge && overallStatus === 'passed_with_warnings') {
    // Optional: block warnings when policy blockOn includes current risk level
    if (riskBlockedByPolicy(riskLevel, input.policies) && riskLevel !== 'low') {
      allowMerge = false;
    }
  }

  // Advisory mode: missing evidence is reported but does not block merge.
  // Executed failures (failed / high_blocked / critical_blocked) still block.
  if (mode === 'advisory' && !allowMerge) {
    if (overallStatus === 'unknown_high_risk' || overallStatus === 'passed_with_warnings') {
      allowMerge = true;
    }
  }

  const advisoryWouldBlock =
    mode === 'advisory' && allowMerge && !evaluateMergeGateBlockingOnly(input).allowMerge;

  let reason: string;
  switch (overallStatus) {
    case 'critical_blocked':
      reason = allowMerge
        ? 'Critical signals present but policies.blockOn does not include critical'
        : 'Critical blocked findings prevent merge';
      break;
    case 'high_blocked':
      reason = allowMerge
        ? 'High-risk blocked claims remain; policies.blockOn does not include high'
        : 'High-risk blocked claims require human review';
      break;
    case 'failed':
      reason = 'One or more verifications failed';
      break;
    case 'unknown_high_risk':
      if (mode === 'advisory' && allowMerge) {
        reason = `advisory mode: high-risk unknowns reported but merge allowed (${highUnknown
          .map((c) => c.title)
          .join('; ')}). Set policies.mode: blocking to enforce.`;
      } else {
        reason = allowMerge
          ? `High-risk unknowns remain but policies.blockOn excludes high (${highUnknown
              .map((c) => c.title)
              .join('; ')})`
          : `needs-human-review: high-risk claims lack dynamic evidence (${highUnknown
              .map((c) => c.title)
              .join('; ')})`;
      }
      break;
    case 'passed_with_warnings':
      reason = allowMerge
        ? mode === 'advisory' && advisoryWouldBlock
          ? `advisory mode: warnings would block under blocking mode; merge allowed with caution`
          : 'Low-risk unknowns or warnings remain; merge allowed with caution'
        : `Policy blockOn includes ${riskLevel}; unresolved warnings block merge`;
      break;
    default:
      reason = 'All required claims have evidence';
  }

  return {
    allowMerge,
    reason,
    overallStatus,
    blockingFindings: [...new Set([...blockingFindings, ...highUnknown.map((c) => c.title)])],
    mode,
    advisoryWouldBlock,
  };
}

/** Evaluate gate as if mode were blocking (used to compute advisoryWouldBlock). */
function evaluateMergeGateBlockingOnly(input: {
  claims: Claim[];
  verifications: Verification[];
  findings: RiskFinding[];
  policies?: PolicySlice;
  headSha?: string;
}): { allowMerge: boolean } {
  const policies: PolicySlice | undefined = input.policies
    ? { ...input.policies, mode: 'blocking' }
    : undefined;
  const overallStatus = computeOverallStatus({ ...input, policies });
  const riskLevel = computeRiskLevel(input.claims, input.findings, policies);

  let allowMerge = overallStatus === 'passed' || overallStatus === 'passed_with_warnings';
  if (overallStatus === 'failed') {
    allowMerge = false;
  } else if (overallStatus === 'critical_blocked') {
    allowMerge = !riskBlockedByPolicy('critical', policies);
  } else if (overallStatus === 'high_blocked' || overallStatus === 'unknown_high_risk') {
    allowMerge = !riskBlockedByPolicy('high', policies);
  } else if (allowMerge && overallStatus === 'passed_with_warnings') {
    if (riskBlockedByPolicy(riskLevel, policies) && riskLevel !== 'low') {
      allowMerge = false;
    }
  }
  return { allowMerge };
}

export function mapOverallToCheckConclusion(
  status: OverallStatus,
  opts?: { allowMerge?: boolean; mode?: 'advisory' | 'blocking' },
): 'success' | 'failure' | 'neutral' | 'action_required' {
  // When merge is allowed (e.g. advisory unknowns), required GitHub checks need success.
  if (opts?.allowMerge && (status === 'unknown_high_risk' || status === 'passed_with_warnings')) {
    return opts.mode === 'advisory' ? 'success' : 'neutral';
  }
  if (opts?.allowMerge && status === 'passed') {
    return 'success';
  }
  switch (status) {
    case 'passed':
      return 'success';
    case 'passed_with_warnings':
      return 'neutral';
    case 'unknown_high_risk':
      return 'action_required';
    case 'failed':
    case 'high_blocked':
    case 'critical_blocked':
      return 'failure';
  }
}

export function verificationImpliesFailure(status: VerificationStatus): boolean {
  // `timed_out` is excluded so it aligns with resolveClaimStatus: a timed-out
  // verification degrades to "unknown" (no evidence) rather than "blocked".
  return status === 'failed' || status === 'blocked';
}
