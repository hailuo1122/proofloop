import { describe, expect, it } from 'vitest';
import { mapOverallToCheckConclusion } from '@proofloop/core';

describe('check conclusions', () => {
  it('maps statuses used by CLI/GitHub', () => {
    expect(mapOverallToCheckConclusion('passed_with_warnings')).toBe('neutral');
    expect(mapOverallToCheckConclusion('unknown_high_risk')).toBe('action_required');
  });
});
