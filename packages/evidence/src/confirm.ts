import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  applyClaimStatuses,
  applyHumanConfirmation,
  ClaimCategorySchema,
  ClaimSourceSchema,
  ClaimStatusSchema,
  computeRiskLevel,
  ConfidenceSchema,
  createId,
  evaluateMergeGate,
  invalidateStaleManualReviews,
  type Claim,
  type HumanReviewRecord,
  type PolicySlice,
  type RiskFinding,
  type Verification,
} from '@proofloop/core';
import { EvidencePackSchema, type EvidencePack } from './schema.js';
import { buildUnknowns, renderMarkdownReport } from './pack.js';

function policiesFromPack(pack: EvidencePack): PolicySlice | undefined {
  if (!pack.policies) return undefined;
  return {
    blockOn: (pack.policies.blockOn as PolicySlice['blockOn']) ?? ['critical', 'high'],
    requireDynamicVerificationFor:
      (pack.policies.requireDynamicVerificationFor as PolicySlice['requireDynamicVerificationFor']) ??
      ['security', 'data', 'compatibility'],
    maxTotalDurationSeconds: pack.policies.maxTotalDurationSeconds ?? 600,
    allowNetwork: pack.policies.allowNetwork ?? false,
  };
}

function toClaims(pack: EvidencePack): Claim[] {
  return pack.claims.map(
    (c) => {
      // EvidencePackSchema fields are intentionally loose strings so old packs
      // keep loading; validate against the real enums here and fall back to
      // safe defaults rather than trusting an unvalidated `as` cast.
      const category = ClaimCategorySchema.safeParse(c.category);
      const source = ClaimSourceSchema.safeParse(c.source);
      const status = ClaimStatusSchema.safeParse(c.status);
      const confidence = ConfidenceSchema.safeParse(c.confidence);
      return {
        id: c.id,
        runId: pack.run.id,
        title: c.title,
        description: c.description ?? '',
        category: category.success ? category.data : 'functional',
        source: source.success ? source.data : 'diff_inference',
        status: status.success ? status.data : 'unknown',
        confidence: confidence.success ? confidence.data : 'low',
        riskWeight: Number.isFinite(c.riskWeight) ? (c.riskWeight ?? 0) : 0,
        relatedFiles: c.relatedFiles,
        relatedSymbols: c.relatedSymbols ?? [],
        evidenceRefs: c.evidenceRefs,
      } satisfies Claim;
    },
  );
}

export function loadEvidencePack(path: string): EvidencePack {
  if (!existsSync(path)) {
    throw new Error(`evidence_not_found:${path}`);
  }
  return EvidencePackSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function appendReviewAudit(cwd: string, record: Record<string, unknown>): void {
  const path = join(cwd, '.proofloop', 'reviews.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: 'a' });
}

export function confirmClaimInPack(input: {
  pack: EvidencePack;
  claimId: string;
  decision: 'accept' | 'reject';
  note?: string;
  reviewer?: string;
}): { pack: EvidencePack; review: HumanReviewRecord; idempotent: boolean } {
  const policies = policiesFromPack(input.pack);
  const headSha = input.pack.run.headSha;
  const claims = toClaims(input.pack);
  const priorReviews = (input.pack.humanReviews ?? []) as HumanReviewRecord[];
  const verifications = input.pack.verifications as Verification[];
  const {
    claims: nextClaims,
    verifications: nextVers,
    reviews,
    review,
    idempotent,
  } = applyHumanConfirmation({
    claims,
    verifications,
    reviews: priorReviews,
    policies,
    confirmation: {
      runId: input.pack.run.id,
      claimId: input.claimId,
      headSha,
      decision: input.decision,
      note: input.note,
      reviewer: input.reviewer,
    },
  });

  const findings = (input.pack.riskFindings ?? []) as RiskFinding[];
  const gate = evaluateMergeGate({
    claims: nextClaims,
    verifications: nextVers,
    findings,
    policies,
    headSha,
  });
  const riskLevel = computeRiskLevel(nextClaims, findings, policies);

  const pack: EvidencePack = {
    ...input.pack,
    run: {
      ...input.pack.run,
      overallStatus: gate.overallStatus,
      riskLevel,
    },
    claims: nextClaims.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      source: c.source,
      category: c.category,
      relatedFiles: c.relatedFiles,
      relatedSymbols: c.relatedSymbols,
      evidenceRefs: c.evidenceRefs ?? [],
      confidence: c.confidence,
      riskWeight: c.riskWeight,
      description: c.description,
    })),
    verifications: nextVers,
    humanReviews: invalidateStaleManualReviews(reviews, headSha),
    unknowns: buildUnknowns(nextClaims, policies),
    mergeGate: gate,
    limitations: [
      ...input.pack.limitations.filter(
        (l) => !l.startsWith('Human review recorded') && !l.startsWith('Human reviews are SHA-bound'),
      ),
      'Human reviews are SHA-bound; a new head commit invalidates prior accepts',
      `Human review recorded for ${input.claimId}: ${input.decision} @ ${headSha.slice(0, 12)}`,
    ],
  };

  return { pack: EvidencePackSchema.parse(pack), review, idempotent };
}

export function confirmClaimOnDisk(input: {
  cwd: string;
  runId: string;
  claimId: string;
  decision: 'accept' | 'reject';
  note?: string;
  reviewer?: string;
}): {
  pack: EvidencePack;
  evidencePath: string;
  reportPath: string;
  review: HumanReviewRecord;
  idempotent: boolean;
} {
  const runDir = join(input.cwd, '.proofloop', 'runs', input.runId);
  const evidencePath = join(runDir, 'evidence.json');
  const reportPath = join(runDir, 'report.md');
  const { pack, review, idempotent } = confirmClaimInPack({
    pack: loadEvidencePack(evidencePath),
    claimId: input.claimId,
    decision: input.decision,
    note: input.note,
    reviewer: input.reviewer,
  });
  writeFileSync(evidencePath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  writeFileSync(reportPath, renderMarkdownReport(pack), 'utf8');

  const audit = {
    event: 'human_review',
    id: createId('metric'),
    runId: input.runId,
    claimId: input.claimId,
    headSha: pack.run.headSha,
    decision: input.decision,
    reviewer: review.reviewer,
    note: review.note,
    at: review.at,
    verificationId: review.verificationId,
    reviewId: review.id,
    overallStatus: pack.run.overallStatus,
    allowMerge: pack.mergeGate?.allowMerge ?? false,
    idempotent,
    createdAt: new Date().toISOString(),
  };
  appendReviewAudit(input.cwd, audit);

  const historyPath = join(input.cwd, '.proofloop', 'history.jsonl');
  writeFileSync(historyPath, `${JSON.stringify(audit)}\n`, { flag: 'a' });

  return { pack, evidencePath, reportPath, review, idempotent };
}

/** Rescore a pack as if head moved — stale SHA-bound accepts must not allow merge. */
export function rescorePackAtHead(pack: EvidencePack, headSha: string): EvidencePack {
  const policies = policiesFromPack(pack);
  const claims = toClaims(pack);
  const nextClaims = applyClaimStatuses(claims, pack.verifications as Verification[], {
    policies,
    headSha,
  });
  const findings = (pack.riskFindings ?? []) as RiskFinding[];
  const gate = evaluateMergeGate({
    claims: nextClaims,
    verifications: pack.verifications as Verification[],
    findings,
    policies,
    headSha,
  });
  return EvidencePackSchema.parse({
    ...pack,
    run: {
      ...pack.run,
      headSha,
      overallStatus: gate.overallStatus,
      riskLevel: computeRiskLevel(nextClaims, findings, policies),
    },
    claims: nextClaims.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      source: c.source,
      category: c.category,
      relatedFiles: c.relatedFiles,
      relatedSymbols: c.relatedSymbols,
      evidenceRefs: c.evidenceRefs ?? [],
      confidence: c.confidence,
      riskWeight: c.riskWeight,
      description: c.description,
    })),
    humanReviews: invalidateStaleManualReviews(
      (pack.humanReviews ?? []) as HumanReviewRecord[],
      headSha,
    ),
    unknowns: buildUnknowns(nextClaims, policies),
    mergeGate: gate,
  });
}
