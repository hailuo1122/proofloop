import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimEvidenceKind, type Claim, type Verification } from '@proofloop/core';
import { EvidencePackSchema } from '@proofloop/evidence';

export async function explainCommand(
  runId: string,
  opts: { cwd: string },
): Promise<number> {
  try {
    const path = join(opts.cwd, '.proofloop', 'runs', runId, 'evidence.json');
    if (!existsSync(path)) {
      console.error(`Evidence pack not found: ${path}`);
      return 2;
    }
    const pack = EvidencePackSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    console.log(`# Explain ${runId}`);
    console.log(
      `Overall: ${pack.run.overallStatus} | merge=${pack.mergeGate?.allowMerge ? 'yes' : 'no'}${
        pack.mergeGate?.mode ? ` | mode=${pack.mergeGate.mode}` : ''
      }`,
    );
    console.log(`Head: ${pack.run.headSha}`);
    console.log(`Gate: ${pack.mergeGate?.reason ?? ''}`);
    console.log('');

    for (const claim of pack.claims) {
      const vers = (pack.verifications as Verification[]).filter(
        (v) =>
          v.claimId === claim.id ||
          (v.relatedClaimIds ?? []).includes(claim.id),
      );
      const domainClaim: Claim = {
        id: claim.id,
        runId,
        title: claim.title,
        description: claim.description ?? '',
        category: (claim.category ?? 'functional') as Claim['category'],
        source: claim.source as Claim['source'],
        status: claim.status as Claim['status'],
        confidence: (claim.confidence ?? 'low') as Claim['confidence'],
        riskWeight: claim.riskWeight ?? 0,
        relatedFiles: claim.relatedFiles,
        relatedSymbols: claim.relatedSymbols ?? [],
        evidenceRefs: claim.evidenceRefs,
      };
      const kind = claimEvidenceKind(domainClaim, vers, pack.run.headSha);
      const unknown = (pack.unknowns as Array<Record<string, unknown>>).find(
        (u) => u.claimId === claim.id,
      );

      console.log(`## ${claim.title}`);
      console.log(`Kind: ${kind} (raw status: ${claim.status})`);
      console.log('Facts (executed / linked):');
      if (!vers.length) console.log('  - (none)');
      for (const v of vers) {
        console.log(
          `  - [${v.type}] \`${v.command}\` → ${v.status}${v.boundHeadSha ? ` @${v.boundHeadSha.slice(0, 8)}` : ''}`,
        );
        if (v.resultSummary) console.log(`    ${v.resultSummary.slice(0, 160)}`);
      }
      console.log('Inferences (not facts):');
      if (claim.source === 'diff_inference' || claim.source === 'pr_description') {
        console.log(`  - Claim source=${claim.source}; requires execution or manual review`);
      } else {
        console.log('  - (none)');
      }
      console.log('Unknowns:');
      console.log(`  - ${unknown ? String(unknown.reason) : '(none recorded)'}`);
      console.log('Human suggestion:');
      console.log(
        `  - ${unknown ? String(unknown.suggestedVerification ?? 'Review manually') : 'No action required'}`,
      );
      console.log('');
    }

    const reviews = pack.humanReviews ?? [];
    if (reviews.length) {
      console.log('## Human reviews (SHA-bound)');
      for (const r of reviews) {
        console.log(
          `- ${r.decision} ${r.claimId} by ${r.reviewer} @ ${r.headSha.slice(0, 12)} [${r.status}]${r.note ? ` — ${r.note}` : ''}`,
        );
      }
    }
    const next = pack.nextActions ?? [];
    if (next.length) {
      console.log('\n## Next actions');
      for (const a of next) {
        console.log(`- [${a.kind}] ${a.title}: ${a.detail}`);
        if (a.command) console.log(`  ${a.command}`);
      }
    }
    return pack.mergeGate?.allowMerge ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }
}
