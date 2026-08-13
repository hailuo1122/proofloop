import { git } from './exec.js';

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unknown';

export interface DiffFile {
  status: DiffStatus;
  path: string;
  oldPath?: string;
  score?: number;
}

export interface UnifiedDiff {
  files: DiffFile[];
  patch: string;
}

function mapStatus(code: string): DiffStatus {
  switch (code[0]) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    default:
      return 'unknown';
  }
}

export function parseNameStatus(output: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    const status = mapStatus(code);
    if (status === 'renamed' || status === 'copied') {
      const score = Number.parseInt(code.slice(1), 10) || undefined;
      files.push({
        status,
        oldPath: parts[1],
        path: parts[2] ?? parts[1] ?? '',
        score,
      });
    } else {
      files.push({ status, path: parts[1] ?? '' });
    }
  }
  return files;
}

export async function getSha(cwd: string, ref: string): Promise<string> {
  const { stdout } = await git(cwd, ['rev-parse', ref]);
  return stdout.trim();
}

export async function analyzeDiff(
  cwd: string,
  baseSha: string,
  headSha: string,
): Promise<UnifiedDiff> {
  const [{ stdout: nameStatus }, { stdout: patch }] = await Promise.all([
    git(cwd, ['diff', '--name-status', `${baseSha}...${headSha}`]),
    git(cwd, ['diff', '--unified=80', `${baseSha}...${headSha}`]),
  ]);
  return {
    files: parseNameStatus(nameStatus),
    patch,
  };
}

export async function createWorktree(
  cwd: string,
  path: string,
  headSha: string,
): Promise<void> {
  await git(cwd, ['worktree', 'add', '--detach', path, headSha]);
}

export async function removeWorktree(cwd: string, path: string): Promise<void> {
  try {
    await git(cwd, ['worktree', 'remove', '--force', path]);
  } catch {
    // best effort
  }
}

export async function listFiles(cwd: string, headSha: string): Promise<string[]> {
  const { stdout } = await git(cwd, ['ls-tree', '-r', '--name-only', headSha]);
  return stdout.split(/\r?\n/).filter(Boolean);
}
