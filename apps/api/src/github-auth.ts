import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { Redis } from 'ioredis';

function normalizePrivateKey(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

export interface AppCredentials {
  appId: string;
  privateKey: string;
}

/** App credentials when GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY are configured. */
export function appCredentials(): AppCredentials | null {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  return { appId, privateKey: normalizePrivateKey(privateKey) };
}

interface InstallationTokenRecord {
  token: string;
  expiresAt: number;
}

/** Refresh tokens 5 minutes before expiry. */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;

/** In-memory fallback cache (used when REDIS_URL is not set). */
const installationTokenCache = new Map<number, InstallationTokenRecord>();

export function clearInstallationTokenCache() {
  installationTokenCache.clear();
}

/** Lazy Redis client — shared across instances when REDIS_URL is configured. */
let redisClient: Redis | null | undefined; // undefined = not probed yet

function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    redisClient = null;
    return null;
  }
  redisClient = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: null });
  return redisClient;
}

function cacheKey(installationId: number): string {
  return `proofloop:gh:install-token:${installationId}`;
}

async function readFromRedis(installationId: number): Promise<InstallationTokenRecord | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(cacheKey(installationId));
    if (!raw) return null;
    const rec = JSON.parse(raw) as InstallationTokenRecord;
    if (rec.expiresAt - TOKEN_REFRESH_BUFFER_MS <= Date.now()) return null;
    return rec;
  } catch {
    return null;
  }
}

async function writeToRedis(installationId: number, rec: InstallationTokenRecord) {
  const redis = getRedis();
  if (!redis) return;
  try {
    const ttlSeconds = Math.max(60, Math.floor((rec.expiresAt - Date.now()) / 1000));
    await redis.set(cacheKey(installationId), JSON.stringify(rec), 'EX', ttlSeconds);
  } catch {
    // best-effort; in-memory cache still holds the value for this instance
  }
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

/**
 * Mint (or return cached) GitHub App installation token. Tokens are rotated
 * automatically: each cached entry is refreshed once it is within 5 minutes
 * of expiry. With REDIS_URL set, the cache is shared across API instances;
 * otherwise it degrades to an in-process map.
 */
export async function getInstallationToken(
  installationId: number,
): Promise<InstallationToken | null> {
  const creds = appCredentials();
  if (!creds) return null;

  const fromRedis = await readFromRedis(installationId);
  if (fromRedis) {
    installationTokenCache.set(installationId, fromRedis);
    return { token: fromRedis.token, expiresAt: new Date(fromRedis.expiresAt).toISOString() };
  }

  const cached = installationTokenCache.get(installationId);
  if (cached && cached.expiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    return { token: cached.token, expiresAt: new Date(cached.expiresAt).toISOString() };
  }

  const auth = createAppAuth({
    appId: creds.appId,
    privateKey: creds.privateKey,
    installationId,
  });
  const installationAuth = await auth({ type: 'installation' });
  const expiresAt = new Date(installationAuth.expiresAt).getTime();
  const rec = { token: installationAuth.token, expiresAt };
  installationTokenCache.set(installationId, rec);
  await writeToRedis(installationId, rec);
  return {
    token: installationAuth.token,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * App-level Octokit authenticated with a short-lived App JWT
 * (for `/app` metadata and installation listing).
 */
export async function createAppOctokit(): Promise<Octokit | null> {
  const creds = appCredentials();
  if (!creds) return null;
  const auth = createAppAuth({ appId: creds.appId, privateKey: creds.privateKey });
  const appAuth = await auth({ type: 'app' });
  return new Octokit({ auth: appAuth.token });
}

/** Prefer GitHub App installation token; fall back to GITHUB_TOKEN PAT. */
export async function createGithubOctokit(installationId?: number | null): Promise<{
  octokit: Octokit;
  token: string;
  mode: 'app' | 'pat' | 'none';
} | null> {
  const install =
    installationId ??
    (process.env.GITHUB_APP_INSTALLATION_ID
      ? Number(process.env.GITHUB_APP_INSTALLATION_ID)
      : undefined);

  if (install) {
    const tok = await getInstallationToken(install);
    if (tok) {
      return {
        octokit: new Octokit({ auth: tok.token }),
        token: tok.token,
        mode: 'app',
      };
    }
  }

  if (process.env.GITHUB_TOKEN) {
    return {
      octokit: new Octokit({ auth: process.env.GITHUB_TOKEN }),
      token: process.env.GITHUB_TOKEN,
      mode: 'pat',
    };
  }

  return null;
}

/** Simple retry for GitHub API transient failures (429 / 5xx). */
export async function withGithubRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status ?? 0;
      if (status !== 429 && (status < 500 || status >= 600)) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw lastErr;
}
