import { describe, expect, it } from 'vitest';
import { evaluateCommand } from './command-policy.js';

describe('evaluateCommand', () => {
  it('allows default verify commands', () => {
    expect(evaluateCommand('pnpm test -- --run').allowed).toBe(true);
    expect(evaluateCommand('pnpm lint').safeCommand).toBe(true);
  });

  it('blocks dangerous commands without executing', () => {
    const r = evaluateCommand('rm -rf /');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/rm/i);
  });

  it('blocks git push and terraform apply', () => {
    expect(evaluateCommand('git push origin main').allowed).toBe(false);
    expect(evaluateCommand('terraform apply -auto-approve').allowed).toBe(false);
  });

  it('allows declared custom commands', () => {
    const r = evaluateCommand('pnpm custom:audit', {
      declaredSafeCommands: ['pnpm custom:audit'],
    });
    expect(r.allowed).toBe(true);
  });

  it('does not guess unknown commands as safe', () => {
    const r = evaluateCommand('node scripts/mystery.js');
    expect(r.allowed).toBe(false);
    expect(r.matchedRule).toBe('unknown_command');
  });

  it('blocks shell chaining after an allowlisted prefix', () => {
    expect(evaluateCommand('pnpm test & rmdir /s /q C:\\x').allowed).toBe(false);
    expect(evaluateCommand('pnpm test && node evil.js').allowed).toBe(false);
    expect(evaluateCommand('pnpm test; del /f file').allowed).toBe(false);
    expect(evaluateCommand('pnpm test | cat').allowed).toBe(false);
  });

  it('requires explicit declare for package install', () => {
    expect(evaluateCommand('pnpm install').allowed).toBe(false);
    expect(
      evaluateCommand('pnpm install', { declaredSafeCommands: ['pnpm install'] }).allowed,
    ).toBe(true);
  });
});
