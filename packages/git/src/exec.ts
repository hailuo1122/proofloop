import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Default git timeout: generous enough for local history operations. */
export const GIT_DEFAULT_TIMEOUT_MS = 120_000;
/** Network operations (clone/fetch) can legitimately take minutes. */
export const GIT_NETWORK_TIMEOUT_MS = 600_000;

export async function git(
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = opts?.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS;
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    encoding: 'utf8',
    timeout: timeoutMs,
    // `git fetch`/`clone` may spawn credential helpers; kill the tree on timeout.
    killSignal: 'SIGKILL',
  });
  return { stdout, stderr };
}
