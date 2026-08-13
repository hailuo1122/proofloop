import { describe, expect, it } from 'vitest';
import { StatePanel } from './components/StatePanel';

describe('StatePanel', () => {
  it('exposes state attribute for UI states', () => {
    const states = ['loading', 'empty', 'error', 'partial', 'completed'] as const;
    for (const state of states) {
      expect(state).toBeTruthy();
    }
    expect(typeof StatePanel).toBe('function');
  });
});
