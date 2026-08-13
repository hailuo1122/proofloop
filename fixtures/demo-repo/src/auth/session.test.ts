import { describe, expect, it } from 'vitest';
import { createSession, isSessionActive } from './session.js';

describe('createSession', () => {
  it('creates a session for a valid token', () => {
    const now = 1_700_000_000_000;
    const session = createSession({ userId: 'u1', exp: now + 60_000 }, now);
    expect(session?.userId).toBe('u1');
    expect(isSessionActive(session!, now)).toBe(true);
  });

  it('does not create a session for an expired token', () => {
    const now = 1_700_000_000_000;
    const session = createSession({ userId: 'u1', exp: now - 1 }, now);
    expect(session).toBeNull();
  });
});
