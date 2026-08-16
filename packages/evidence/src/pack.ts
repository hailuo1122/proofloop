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

/** Escape HTML entities in a string to prevent XSS in Markdown/HTML rendering. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function renderMarkdownReport(pack: EvidencePack): string {
  const lines: string[] = [];
  lines.push(`# ProofLoop Evidence Report`);
  lines.push('');
  lines.push(`- Run: \`${esc(pack.run.id)}\``);
  lines.push(`- Repository: \`${esc(pack.run.repository)}\``);
  lines.push(`- Base/Head: \`${esc(pack.run.baseSha.slice(0, 8))}\` → \`${esc(pack.run.headSha.slice(0, 8))}\``);
  lines.push(`- Overall: **${esc(pack.run.overallStatus)}** (risk: ${esc(pack.run.riskLevel)})`);
  lines.push(
    `- Merge gate: ${pack.mergeGate?.allowMerge ? 'ALLOW' : 'BLOCK'} — ${esc(pack.mergeGate?.reason ?? '')}`,
  );
  lines.push('');
  lines.push(`## Intent`);
  lines.push(esc(pack.intent.summary));
  lines.push('');
  lines.push(`## Claims`);
  for (const c of pack.claims) {
    lines.push(`### ${esc(c.title)}`);
    lines.push(`- Status: \`${esc(c.status)}\``);
    lines.push(`- Source: ${esc(c.source)}`);
    lines.push(`- Files: ${c.relatedFiles.map((f) => `\`${esc(f)}\``).join(', ') || '(none)'}`);
    lines.push(`- Evidence: ${c.evidenceRefs.map(esc).join(', ') || '(none)'}`);
    lines.push('');
  }
  lines.push(`## Verifications`);
  for (const v of pack.verifications as Array<Record<string, unknown>>) {
    lines.push(
      `- \`${esc(String(v.id))}\` ${esc(String(v.type))}: \`${esc(String(v.command))}\` → **${esc(String(v.status))}** (exit ${String(v.exitCode ?? 'n/a')}, ${String(v.durationMs ?? 0)}ms)`,
    );
  }
  lines.push('');
  lines.push(`## Unknowns`);
  for (const u of pack.unknowns as Array<Record<string, unknown>>) {
    lines.push(`- **${esc(String(u.title))}**: ${esc(String(u.reason))}`);
  }
  lines.push('');
  const reviews = (pack.humanReviews ?? []) as Array<Record<string, unknown>>;
  if (reviews.length) {
    lines.push(`## Human reviews (SHA-bound)`);
    for (const r of reviews) {
      lines.push(
        `- \`${esc(String(r.claimId))}\` ${esc(String(r.decision))} by ${esc(String(r.reviewer))} @ \`${esc(String(r.headSha).slice(0, 12))}\` [${esc(String(r.status))}]${r.note ? ` — ${esc(String(r.note))}` : ''}`,
      );
    }
    lines.push('');
  }
  lines.push(`## Limitations`);
  for (const l of pack.limitations) lines.push(`- ${esc(l)}`);
  lines.push('');
  return lines.join('\n');
}
