import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('removes Authorization bearer tokens', () => {
    const { text, redacted } = redactSecrets('Authorization: Bearer abc.def.ghi');
    expect(redacted).toBe(true);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('abc.def.ghi');
  });

  it('removes password and cookie values', () => {
    const input = 'password=supersecret\nCookie: session=abc123; Path=/';
    const { text } = redactSecrets(input);
    expect(text).not.toContain('supersecret');
    expect(text).not.toContain('session=abc123');
  });

  it('removes github and openai style keys', () => {
    const input =
      'token ghp_abcdefghijklmnopqrstuv and sk-abcdefghijklmnopqrstuvwx and sk-proj-ABCDEFGHIJKLMNOPQRST';
    const { text } = redactSecrets(input);
    expect(text).not.toMatch(/ghp_[A-Za-z0-9]+/);
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]+/);
  });
});
