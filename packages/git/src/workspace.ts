import { existsSync, mkdirSync, readdirSync, rmSync, lstatSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from './exec.js';
import { checkoutLockPath, pathLockForDir, withPathLock } from './lock.js';

export interface EnsureCheckoutInput {
  workspaceRoot: string;
  owner: string;
  name: string;
  /** https clone URL without credentials */
  cloneUrl: string;
  headSha: string;
  baseSha?: string;
  /** GitHub / GitLab token for private repos */
  token?: string;
  /** Auth username in clone URL (GitHub: x-access-token, GitLab: oauth2) */
  tokenUser?: string;
}

function authedCloneUrl(
  cloneUrl: string,
  token?: string,
  tokenUser = 'x-access-token',
): string {
  if (!token) return cloneUrl;
  try {
    const u = new URL(cloneUrl);
    u.username = tokenUser;
    u.password = token;
    return u.toString();
  } catch {
    return cloneUrl.replace(
      /^https:\/\//i,
      `https://${tokenUser}:${encodeURIComponent(token)}@`,
    );
  }
}

/** True for symlinks and Windows junctions (which often look like plain dirs). */
function isLinkOrJunction(path: string): boolean {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return true;
    if (st.isDirectory()) {
      const real = realpathSync(path);
      return resolve(real) !== resolve(path);
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Fetch (when possible) and force-checkout `headSha` in an existing git directory.
 */
export async function syncRepoToSha(
  dir: string,
  headSha: string,
  baseSha?: string,
): Promise<void> {
  await withPathLock(pathLockForDir(dir), async () => {
    const refs = [headSha];
    if (baseSha) refs.push(baseSha);
    await git(dir, ['fetch', '--depth=50', 'origin', ...refs]).catch(async () => {
      await git(dir, ['fetch', 'origin', headSha]).catch(() => undefined);
    });
    await git(dir, ['cat-file', '-e', `${headSha}^{commit}`]).catch(() => {
      throw new Error(
        `sha_not_available:${headSha} — fetch succeeded but the commit object is not available. ` +
          `The repository may be shallow or the SHA may not exist on the remote.`,
      );
    });
    await git(dir, ['checkout', '--force', headSha]);
  });
}

/** Clone or fetch a repository into a durable workspace and check out headSha. */
export async function ensureGithubCheckout(input: EnsureCheckoutInput): Promise<string> {
  const root = resolve(input.workspaceRoot);
  const dir = join(root, input.owner, input.name);
  const lock = checkoutLockPath(root, input.owner, input.name);
  return withPathLock(lock, async () => {
    mkdirSync(join(root, input.owner), { recursive: true });
    const url = authedCloneUrl(input.cloneUrl, input.token, input.tokenUser);

    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(dir, { recursive: true });
      await git(root, [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        url,
        join(input.owner, input.name),
      ]);
    } else if (input.token) {
      await git(dir, ['remote', 'set-url', 'origin', url]).catch(() => undefined);
    }

    // Already under workspace lock — call unlocked fetch/checkout.
    const refs = [input.headSha];
    if (input.baseSha) refs.push(input.baseSha);
    await git(dir, ['fetch', '--depth=50', 'origin', ...refs]).catch(async () => {
      await git(dir, ['fetch', 'origin', input.headSha]).catch(() => undefined);
    });
    await git(dir, ['cat-file', '-e', `${input.headSha}^{commit}`]);
    await git(dir, ['checkout', '--force', input.headSha]);

    if (input.token && input.cloneUrl) {
      await git(dir, ['remote', 'set-url', 'origin', input.cloneUrl]).catch(() => undefined);
    }
    return dir;
  });
}

/** GitLab checkout (oauth2 token user). */
export async function ensureGitlabCheckout(
  input: Omit<EnsureCheckoutInput, 'tokenUser'>,
): Promise<string> {
  return ensureGithubCheckout({ ...input, tokenUser: 'oauth2' });
}

/**
 * Remove workspace checkouts older than maxAgeMs. Workspaces live at
 * `{root}/{owner}/{name}`; junctions/symlinks are never deleted.
 */
export function cleanupStaleWorkspaces(root: string, maxAgeMs: number): string[] {
  const absRoot = resolve(root);
  if (!existsSync(absRoot)) return [];
  const removed: string[] = [];
  const now = Date.now();

  for (const owner of readdirSync(absRoot)) {
    const ownerDir = join(absRoot, owner);
    if (isLinkOrJunction(ownerDir)) continue;
    let ownerStat;
    try {
      ownerStat = lstatSync(ownerDir);
    } catch {
      continue;
    }
    if (!ownerStat.isDirectory()) continue;

    for (const name of readdirSync(ownerDir)) {
      const dir = join(ownerDir, name);
      if (isLinkOrJunction(dir)) continue;
      let st;
      try {
        st = lstatSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (!existsSync(join(dir, '.git'))) continue;
      let mtimeMs = st.mtimeMs;
      try {
        mtimeMs = statSync(dir).mtimeMs;
      } catch {
        /* use lstat */
      }
      if (now - mtimeMs <= maxAgeMs) continue;

      try {
        rmSync(dir, { recursive: true, force: true });
        removed.push(`${owner}/${name}`);
      } catch {
        // locked / in use — skip
      }
    }
  }
  return removed;
}
