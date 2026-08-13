import { confirmClaimOnDisk } from '@proofloop/evidence';

export async function confirmCommand(
  runId: string,
  claimId: string,
  opts: {
    cwd: string;
    accept?: boolean;
    reject?: boolean;
    note?: string;
    reviewer?: string;
  },
): Promise<number> {
  try {
    if (!!opts.accept === !!opts.reject) {
      console.error('Specify exactly one of --accept or --reject');
      return 2;
    }
    const decision = opts.accept ? 'accept' : 'reject';
    const note = opts.note?.trim();
    if (!note) {
      console.error('--note is required for the audit trail');
      return 2;
    }
    const reviewer =
      opts.reviewer?.trim() || process.env.USER || process.env.USERNAME || '';
    if (!reviewer) {
      console.error('--reviewer is required (or set USER/USERNAME)');
      return 2;
    }
    const { pack, evidencePath, review, idempotent } = confirmClaimOnDisk({
      cwd: opts.cwd,
      runId,
      claimId,
      decision,
      note,
      reviewer,
    });
    console.log(`Updated ${evidencePath}`);
    console.log(
      `Claim ${claimId} → human ${decision}${idempotent ? ' (idempotent)' : ''}`,
    );
    console.log(
      `Bound: sha=${review.headSha.slice(0, 12)} reviewer=${review.reviewer} at=${review.at}`,
    );
    console.log(`Reason: ${review.note}`);
    console.log(
      `Overall: ${pack.run.overallStatus} | merge=${pack.mergeGate?.allowMerge ? 'yes' : 'no'}`,
    );
    console.log(pack.mergeGate?.reason ?? '');
    if (decision === 'reject') {
      console.log('Next: fix the claim, then re-run: pnpm proofloop check --base <base> --head HEAD');
    }
    // Successful write always exits 0; remaining unknowns are visible in overallStatus.
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }
}
