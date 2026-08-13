import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { confirmClaimInPack, confirmClaimOnDisk, rescorePackAtHead } from './confirm.js';
import type { EvidencePack } from './schema.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function samplePack(headSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'): EvidencePack {
  return {
    schemaVersion: '1.0',
    run: {
      id: 'run_1',
      repository: 'o/r',
      baseSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      headSha,
      status: 'completed',
      overallStatus: 'unknown_high_risk',
      riskLevel: 'high',
    },
    intent: { summary: 'x', assumptions: [], sourceRefs: [] },
    claims: [
      {
        id: 'claim_1',
        title: 'IdP revocation',
        status: 'unknown',
        source: 'diff_inference',
        category: 'security',
        relatedFiles: ['a.py'],
        evidenceRefs: [],
        riskWeight: 80,
      },
    ],
    verifications: [],
    riskFindings: [],
    unknowns: [],
    impactGraph: { nodes: [] },
    artifacts: [],
    limitations: [],
    humanReviews: [],
    mergeGate: {
      allowMerge: false,
      reason: 'needs-human-review',
      overallStatus: 'unknown_high_risk',
      blockingFindings: ['IdP revocation'],
    },
  };
}

describe('confirmClaimInPack', () => {
  it('binds accept to head SHA / reviewer / reason and allows merge', () => {
    const { pack, review } = confirmClaimInPack({
      pack: samplePack(),
      claimId: 'claim_1',
      decision: 'accept',
      reviewer: 'bob',
      note: 'IdP checked offline',
    });
    expect(pack.claims[0].status).toBe('verified');
    expect(pack.mergeGate?.allowMerge).toBe(true);
    expect(review.headSha).toBe(pack.run.headSha);
    expect(review.reviewer).toBe('bob');
    expect(review.note).toBe('IdP checked offline');
    expect(review.claimId).toBe('claim_1');
    expect(pack.humanReviews?.[0]?.status).toBe('active');
  });

  it('invalidates accept when head commit changes', () => {
    const { pack } = confirmClaimInPack({
      pack: samplePack('sha_old_000000000000000000000000000000000000'),
      claimId: 'claim_1',
      decision: 'accept',
      reviewer: 'bob',
      note: 'ok',
    });
    expect(pack.mergeGate?.allowMerge).toBe(true);

    const moved = rescorePackAtHead(pack, 'sha_new_111111111111111111111111111111111111');
    expect(moved.claims[0].status).toBe('unknown');
    expect(moved.mergeGate?.allowMerge).toBe(false);
    expect(moved.mergeGate?.overallStatus).toBe('unknown_high_risk');
    expect(moved.humanReviews?.every((r) => r.status === 'invalidated')).toBe(true);
  });

  it('idempotent confirm does not duplicate reviews', () => {
    const first = confirmClaimInPack({
      pack: samplePack(),
      claimId: 'claim_1',
      decision: 'accept',
      reviewer: 'bob',
      note: 'same',
    });
    const second = confirmClaimInPack({
      pack: first.pack,
      claimId: 'claim_1',
      decision: 'accept',
      reviewer: 'bob',
      note: 'same',
    });
    expect(second.idempotent).toBe(true);
    expect(second.pack.verifications.filter((v) => (v as { type: string }).type === 'manual')).toHaveLength(
      1,
    );
    expect(second.pack.humanReviews?.filter((r) => r.status === 'active')).toHaveLength(1);
  });
});

describe('confirmClaimOnDisk', () => {
  it('rewrites evidence and appends SHA-bound audit log', () => {
    const cwd = join(tmpdir(), `pl-confirm-${Date.now()}`);
    dirs.push(cwd);
    const runDir = join(cwd, '.proofloop', 'runs', 'run_1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'evidence.json'), JSON.stringify(samplePack(), null, 2));
    const { pack, evidencePath, reportPath, review } = confirmClaimOnDisk({
      cwd,
      runId: 'run_1',
      claimId: 'claim_1',
      decision: 'accept',
      reviewer: 'carol',
      note: 'audited',
    });
    expect(pack.mergeGate?.allowMerge).toBe(true);
    expect(evidencePath).toContain('evidence.json');
    expect(reportPath).toContain('report.md');
    expect(existsSync(join(cwd, '.proofloop', 'reviews.jsonl'))).toBe(true);
    const line = readFileSync(join(cwd, '.proofloop', 'reviews.jsonl'), 'utf8').trim();
    const audit = JSON.parse(line);
    expect(audit.headSha).toBe(pack.run.headSha);
    expect(audit.claimId).toBe('claim_1');
    expect(audit.reviewer).toBe('carol');
    expect(audit.note).toBe('audited');
    expect(audit.reviewId).toBe(review.id);
  });

  it('reject records reason and blocks merge', () => {
    const cwd = join(tmpdir(), `pl-reject-${Date.now()}`);
    dirs.push(cwd);
    const runDir = join(cwd, '.proofloop', 'runs', 'run_1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'evidence.json'), JSON.stringify(samplePack(), null, 2));
    const { pack } = confirmClaimOnDisk({
      cwd,
      runId: 'run_1',
      claimId: 'claim_1',
      decision: 'reject',
      reviewer: 'dave',
      note: 'needs integration test',
    });
    expect(pack.claims[0].status).toBe('blocked');
    expect(pack.mergeGate?.allowMerge).toBe(false);
    expect(pack.humanReviews?.[0]?.note).toBe('needs integration test');
  });
});
