import type { Verification } from '../types.js';

/** Drop or collapse manual reviews that are not bound to the current head SHA. */
export function filterEffectiveVerifications(
  verifications: Verification[],
  headSha?: string,
): Verification[] {
  const scoped = verifications.filter((v) => {
    if (v.type !== 'manual') return true;
    // Manual evidence is SHA-bound. Without a headSha, drop manuals rather than
    // treating unbound accepts as still valid (fail closed).
    if (!headSha) return false;
    if (!v.boundHeadSha) return false;
    return v.boundHeadSha === headSha;
  });

  const latestManual = new Map<string, Verification>();
  const nonManual: Verification[] = [];
  for (const v of scoped) {
    if (v.type !== 'manual' || !v.claimId) {
      nonManual.push(v);
      continue;
    }
    const prev = latestManual.get(v.claimId);
    if (!prev || (v.finishedAt ?? '') >= (prev.finishedAt ?? '')) {
      latestManual.set(v.claimId, v);
    }
  }
  return [...nonManual, ...latestManual.values()];
}
