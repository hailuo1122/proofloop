import {
  applyClaimStatuses,
  computeRiskLevel,
  evaluateMergeGate,
  isHighRiskClaim,
  type Artifact,
  type ChangeIntent,
  type Claim,
  type ImpactNode,
  type PolicySlice,
  type RiskFinding,
  type UnknownItem,
  type Verification,
} from '@proofloop/core';
import { EvidencePackSchema, type EvidencePack } from './schema.js';

export function buildUnknowns(claims: Claim[], policies?: PolicySlice): UnknownItem[] {
  return claims
    .filter((c) => c.status === 'unknown' || c.status === 'inferred' || c.status === 'blocked')
    .map((c) => ({
      id: `unknown_${c.id}`,
      claimId: c.id,
      title: c.title,
      reason:
        c.status === 'blocked'
          ? 'Verification failed or was blocked by policy'
          : 'No sufficient executed verification linked to this claim',
      suggestedVerification: isHighRiskClaim(c, policies)
        ? 'Run focused unit/integration tests covering auth/data edge cases (or record manual confirmation)'
        : 'Run unit tests or typecheck linked to the related files',
      importance: isHighRiskClaim(c, policies)
        ? 'High-risk unknown blocks merge until dynamic evidence exists'
        : 'Low-risk unknown produces a warning only',
      riskLevel: isHighRiskClaim(c, policies) ? 'high' : 'low',
    }));
}

export function buildEvidencePack(input: {
  runId: string;
  repository: string;
  baseSha: string;
  headSha: string;
  source: string;
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  intent: ChangeIntent;
  claims: Claim[];
  verifications: Verification[];
  findings?: RiskFinding[];
  impactNodes: ImpactNode[];
  impactEdges?: Array<{ id: string; fromNodeId: string; toNodeId: string; relation: string }>;
  coverageNote?: string;
  analyzedFiles?: number;
  artifacts: Artifact[];
  limitations?: string[];
  llmUsed?: boolean;
  llmClaimIds?: Set<string>;
  policies?: PolicySlice;
}): EvidencePack {
  const policies = input.policies;
  const claims = applyClaimStatuses(input.claims, input.verifications, {
    llmClaimIds:
      input.llmClaimIds ??
      (input.llmUsed
        ? new Set(
            input.claims
              .filter((c) => c.source === 'pr_description' || c.status === 'inferred')
              .map((c) => c.id),
          )
        : undefined),
    policies,
    headSha: input.headSha,
  });
  const findings = input.findings ?? [];
  const gate = evaluateMergeGate({
    claims,
    verifications: input.verifications,
    findings,
    policies,
    headSha: input.headSha,
  });
  const riskLevel = computeRiskLevel(claims, findings, policies);
  const unknowns = buildUnknowns(claims, policies);

  const pack: EvidencePack = {
    schemaVersion: '1.0',
    run: {
      id: input.runId,
      repository: input.repository,
      baseSha: input.baseSha,
      headSha: input.headSha,
      status: 'completed',
      overallStatus: gate.overallStatus,
      riskLevel,
      source: input.source,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      totalDurationMs: input.totalDurationMs,
    },
    intent: {
      summary: input.intent.summary,
      assumptions: input.intent.assumptions,
      sourceRefs: [input.intent.sourceText.slice(0, 200)],
      confidence: input.intent.confidence,
    },
    claims: claims.map((c) => ({
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
    verifications: input.verifications,
    riskFindings: findings,
    unknowns,
    impactGraph: {
      nodes: input.impactNodes,
      edges: input.impactEdges ?? [],
      coverageNote: input.coverageNote,
      analyzedFiles: input.analyzedFiles,
    },
    artifacts: input.artifacts.map((a) => ({
      id: a.id,
      kind: a.kind,
      sha256: a.sha256,
      sizeBytes: a.sizeBytes,
      redacted: a.redacted,
      storagePath: a.storagePath,
    })),
    limitations: input.limitations ?? [
      '未执行生产环境验证',
      'Impact graph is partial and must not be treated as complete',
      input.llmUsed
        ? 'LLM outputs are schema-validated inferences, not facts'
        : 'LLM disabled; intent/claims are deterministic heuristics',
    ],
    policies: policies
      ? {
          blockOn: policies.blockOn,
          requireDynamicVerificationFor: policies.requireDynamicVerificationFor,
          maxTotalDurationSeconds: policies.maxTotalDurationSeconds,
          allowNetwork: policies.allowNetwork,
        }
      : undefined,
    humanReviews: [],
    mergeGate: gate,
  };

  return EvidencePackSchema.parse(pack);
}

export function renderMarkdownReport(pack: EvidencePack): string {
  const lines: string[] = [];
  lines.push(`# ProofLoop Evidence Report`);
  lines.push('');
  lines.push(`- Run: \`${pack.run.id}\``);
  lines.push(`- Repository: \`${pack.run.repository}\``);
  lines.push(`- Base/Head: \`${pack.run.baseSha.slice(0, 8)}\` → \`${pack.run.headSha.slice(0, 8)}\``);
  lines.push(`- Overall: **${pack.run.overallStatus}** (risk: ${pack.run.riskLevel})`);
  lines.push(
    `- Merge gate: ${pack.mergeGate?.allowMerge ? 'ALLOW' : 'BLOCK'} — ${pack.mergeGate?.reason ?? ''}`,
  );
  lines.push('');
  lines.push(`## Intent`);
  lines.push(pack.intent.summary);
  lines.push('');
  lines.push(`## Claims`);
  for (const c of pack.claims) {
    lines.push(`### ${c.title}`);
    lines.push(`- Status: \`${c.status}\``);
    lines.push(`- Source: ${c.source}`);
    lines.push(`- Files: ${c.relatedFiles.map((f) => `\`${f}\``).join(', ') || '(none)'}`);
    lines.push(`- Evidence: ${c.evidenceRefs.join(', ') || '(none)'}`);
    lines.push('');
  }
  lines.push(`## Verifications`);
  for (const v of pack.verifications as Array<Record<string, unknown>>) {
    lines.push(
      `- \`${v.id}\` ${v.type}: \`${v.command}\` → **${v.status}** (exit ${v.exitCode ?? 'n/a'}, ${v.durationMs ?? 0}ms)`,
    );
  }
  lines.push('');
  lines.push(`## Unknowns`);
  for (const u of pack.unknowns as Array<Record<string, unknown>>) {
    lines.push(`- **${u.title}**: ${u.reason}`);
  }
  lines.push('');
  const reviews = (pack.humanReviews ?? []) as Array<Record<string, unknown>>;
  if (reviews.length) {
    lines.push(`## Human reviews (SHA-bound)`);
    for (const r of reviews) {
      lines.push(
        `- \`${r.claimId}\` ${r.decision} by ${r.reviewer} @ \`${String(r.headSha).slice(0, 12)}\` [${r.status}]${r.note ? ` — ${r.note}` : ''}`,
      );
    }
    lines.push('');
  }
  lines.push(`## Limitations`);
  for (const l of pack.limitations) lines.push(`- ${l}`);
  lines.push('');
  return lines.join('\n');
}
