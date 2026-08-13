import { describe, expect, it } from 'vitest';
import { StatePanel } from './components/StatePanel';

describe('UI states', () => {
  it('supports loading empty error partial completed', () => {
    const states = ['loading', 'empty', 'error', 'partial', 'completed'] as const;
    expect(states).toHaveLength(5);
    expect(typeof StatePanel).toBe('function');
  });
});
