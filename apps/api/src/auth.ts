import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { ProofloopError } from '@proofloop/core';

const PUBLIC_PREFIXES = [
  '/api/health',
  '/api/github/webhook',
  '/api/gitlab/webhook',
  '/api/metrics',
];

export interface ApiKeyRecord {
  token: string;
  /** When set, the key only grants access to this organization's data. */
  organizationId?: string;
}

export interface AuthScope {
  /** null = global access (auth disabled or global-scoped key). */
  organizationId: string | null;
}

/**
 * Configured API keys:
 *   - PROOFLOOP_API_TOKEN   — global key (all orgs)
 *   - PROOFLOOP_API_KEYS    — comma-separated "token:orgId" pairs (org-scoped keys)
 */
export function configuredApiKeys(): ApiKeyRecord[] {
  const records: ApiKeyRecord[] = [];
  const global = process.env.PROOFLOOP_API_TOKEN;
  if (global) records.push({ token: global });
  const keys = process.env.PROOFLOOP_API_KEYS;
  if (keys) {
    for (const part of keys.split(',')) {
      const token = part.trim();
      if (!token) continue;
      const idx = token.lastIndexOf(':');
      if (idx > 0) {
        records.push({ token: token.slice(0, idx), organizationId: token.slice(idx + 1) });
      } else {
        records.push({ token });
      }
    }
  }
  return records;
}

export function apiAuthEnabled(): boolean {
  return configuredApiKeys().length > 0;
}

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function tokenFromRequest(req: FastifyRequest): string | null {
  const header = String(req.headers.authorization ?? '');
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  const alt = String(req.headers['x-proofloop-token'] ?? '');
  return alt || null;
}

/**
 * Enforce API token auth on every non-public route when any key is configured.
 * Attaches the resolved org scope to the request for downstream filtering.
 */
export async function requireApiToken(req: FastifyRequest, _reply: FastifyReply) {
  const keys = configuredApiKeys();
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return;

  // Fail closed in production: mutating control plane must not be open.
  if (keys.length === 0) {
    const env = process.env.NODE_ENV ?? 'development';
    if (env === 'production' && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      throw new ProofloopError(
        'unauthorized',
        'PROOFLOOP_API_TOKEN (or PROOFLOOP_API_KEYS) must be set in production',
        401,
      );
    }
    return; // auth disabled → open (development)
  }

  const token = tokenFromRequest(req);
  if (!token) {
    throw new ProofloopError('unauthorized', 'Valid API token required', 401);
  }
  const match = keys.find((k) => tokensEqual(k.token, token));
  if (!match) {
    throw new ProofloopError('unauthorized', 'Valid API token required', 401);
  }

  (req as FastifyRequest & { authScope?: AuthScope }).authScope = {
    organizationId: match.organizationId ?? null,
  };
}

/** Read the org scope attached by requireApiToken. */
export function scopeForRequest(req: FastifyRequest): AuthScope {
  const scope = (req as FastifyRequest & { authScope?: AuthScope }).authScope;
  return scope ?? { organizationId: null };
}

export function webhookSecretRequired(): boolean {
  const env = process.env.NODE_ENV ?? 'development';
  if (env === 'production') return true;
  return process.env.PROOFLOOP_REQUIRE_WEBHOOK_SECRET === '1';
}
