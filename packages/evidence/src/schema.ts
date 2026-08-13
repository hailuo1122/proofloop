import { z } from 'zod';

export const EvidencePackSchema = z.object({
  schemaVersion: z.literal('1.0'),
  run: z.object({
    id: z.string(),
    repository: z.string(),
    baseSha: z.string(),
    headSha: z.string(),
    status: z.string(),
    overallStatus: z.string(),
    riskLevel: z.string(),
    source: z.string().optional(),
    startedAt: z.string().nullable().optional(),
    finishedAt: z.string().nullable().optional(),
    totalDurationMs: z.number().nullable().optional(),
  }),
  intent: z.object({
    summary: z.string(),
    assumptions: z.array(z.string()),
    sourceRefs: z.array(z.string()),
    confidence: z.string().optional(),
  }),
  claims: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      source: z.string(),
      category: z.string().optional(),
      relatedFiles: z.array(z.string()),
      relatedSymbols: z.array(z.string()).optional(),
      evidenceRefs: z.array(z.string()),
      confidence: z.string().optional(),
      riskWeight: z.number().optional(),
      description: z.string().optional(),
    }),
  ),
  verifications: z.array(z.record(z.any())),
  riskFindings: z.array(z.record(z.any())),
  unknowns: z.array(z.record(z.any())),
  impactGraph: z.object({
    nodes: z.array(z.record(z.any())),
    edges: z.array(z.record(z.any())).optional(),
    coverageNote: z.string().optional(),
    analyzedFiles: z.number().optional(),
  }),
  artifacts: z.array(z.record(z.any())),
  limitations: z.array(z.string()),
  policies: z
    .object({
      blockOn: z.array(z.string()).optional(),
      requireDynamicVerificationFor: z.array(z.string()).optional(),
      maxTotalDurationSeconds: z.number().optional(),
      allowNetwork: z.boolean().optional(),
    })
    .optional(),
  humanReviews: z
    .array(
      z.object({
        id: z.string(),
        runId: z.string(),
        claimId: z.string(),
        headSha: z.string(),
        decision: z.enum(['accept', 'reject']),
        reviewer: z.string(),
        note: z.string(),
        at: z.string(),
        verificationId: z.string(),
        status: z.enum(['active', 'superseded', 'invalidated']),
        invalidationReason: z.string().optional(),
      }),
    )
    .optional(),
  mergeGate: z
    .object({
      allowMerge: z.boolean(),
      reason: z.string(),
      overallStatus: z.string(),
      blockingFindings: z.array(z.string()),
    })
    .optional(),
});

export type EvidencePack = z.infer<typeof EvidencePackSchema>;
