import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runCommand, runVerifications } from './runner.js';

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

  it('truncates captured output to maxLogBytes', async () => {
    const { command, cwd } = scriptCommand(
      'for (let i = 0; i < 50000; i++) console.log("y".repeat(200));\n',
    );
    const result = await runCommand({
      command,
      cwd,
      timeoutMs: 30000,
      declaredSafeCommands: [command],
      maxLogBytes: 10_000,
    });
    expect(result.stdout.length).toBeLessThanOrEqual(10_000);
  });

  it('kills the whole process tree on timeout', { skip: process.platform === 'win32' }, async () => {
    const token = `pl-orphan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // The script starts a long-lived grandchild whose argv carries the token,
    // then idles. If the timeout only kills the shell (or nothing at all), the
    // grandchild survives and the token stays visible in `ps`.
    const { command, cwd } = scriptCommand(`
      const { spawn } = await import('node:child_process');
      spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 30000);//${token}'], {
        stdio: 'ignore',
      });
      setInterval(() => {}, 1000);
    `);
    const result = await runCommand({
      command,
      cwd,
      timeoutMs: 500,
      declaredSafeCommands: [command],
    });
    expect(result.status).toBe('timed_out');
    await new Promise((r) => setTimeout(r, 800));
    const { execFileSync } = await import('node:child_process');
    const psArgs = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
    expect(psArgs.includes(token)).toBe(false);
  });
});

describe('runVerifications', () => {
  it('executes yml-declared commands instead of blocking them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pl-runner-verif-'));
    // `node <script>` is not on the static allowlist — it must pass because it
    // is declared. Regression: runVerifications used to drop declaredSafeCommands
    // when delegating to runCommand, so every declared command was blocked.
    const { command } = scriptCommand('console.log("declared ran");\n');
    const result = await runVerifications({
      repoRoot: dir,
      runId: 'run_declared_regression',
      headSha: 'deadbeefdeadbeef',
      plans: [{ type: 'unit_test', command, relatedClaimIds: [] }],
      storageRoot: join(dir, 'storage'),
      timeoutMsPerCommand: 15000,
      declaredSafeCommands: [command],
      useWorktree: false,
    });
    expect(result.verifications).toHaveLength(1);
    expect(result.verifications[0].status).toBe('passed');
    expect(result.verifications[0].safeCommand).toBe(true);
  });
});
