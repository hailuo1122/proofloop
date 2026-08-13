import { describe, expect, it } from 'vitest';
import { evaluateMergeGate } from './claim-machine.js';
import type { Claim } from '../types.js';

describe('repeat runs do not mutate prior claim objects', () => {
  it('keeps historical claim statuses independent', () => {
    const historical: Claim = {
      id: 'claim_old',
      runId: 'run_old',
      title: 'old',
      description: '',
      category: 'functional',
      source: 'diff_inference',
      status: 'verified',
      confidence: 'high',
      riskWeight: 20,
      relatedFiles: [],
      relatedSymbols: [],
      evidenceRefs: ['v_old'],
    };
    const snapshot = structuredClone(historical);
    const gate = evaluateMergeGate({
      claims: [
        {
          ...historical,
          id: 'claim_new',
          runId: 'run_new',
          status: 'unknown',
          category: 'security',
          riskWeight: 80,
          title: 'new high risk',
        },
      ],
      verifications: [],
      findings: [],
    });
    expect(gate.allowMerge).toBe(false);
    expect(historical).toEqual(snapshot);
  });
});
