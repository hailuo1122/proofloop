import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runCommand } from './runner.js';

function scriptCommand(source: string): { command: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pl-runner-'));
  const file = join(dir, 'script.mjs');
  writeFileSync(file, source, 'utf8');
  return { command: `node ${JSON.stringify(file)}`, cwd: dir };
}

describe('runCommand', () => {
  it('does not execute blocked commands', async () => {
    const result = await runCommand({
      command: 'rm -rf /tmp/proofloop-should-not-run',
      cwd: process.cwd(),
      timeoutMs: 2000,
    });
    expect(result.status).toBe('blocked');
    expect(result.exitCode).toBeNull();
  });

  it('captures nonzero exit codes for declared commands', async () => {
    const { command, cwd } = scriptCommand('process.exit(3);\n');
    const result = await runCommand({
      command,
      cwd,
      timeoutMs: 5000,
      declaredSafeCommands: [command],
    });
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(3);
  });

  it('times out long declared commands', async () => {
    const { command, cwd } = scriptCommand('await new Promise((r) => setTimeout(r, 20000));\n');
    const result = await runCommand({
      command,
      cwd,
      timeoutMs: 800,
      declaredSafeCommands: [command],
    });
    expect(result.status).toBe('timed_out');
  });

  it('marks aborted commands as skipped', async () => {
    const { command, cwd } = scriptCommand('await new Promise((r) => setTimeout(r, 20000));\n');
    const controller = new AbortController();
    const promise = runCommand({
      command,
      cwd,
      timeoutMs: 10000,
      declaredSafeCommands: [command],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    expect(['skipped', 'timed_out']).toContain(result.status);
  });
});
