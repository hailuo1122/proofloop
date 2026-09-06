import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { toErrorBody, ProofloopError } from '@proofloop/core';
import { cleanupStaleWorkspaces } from '@proofloop/git';
import { registerRoutes } from './routes.js';
import { migrate } from './db/migrate.js';
import { requireApiToken } from './auth.js';
import { markInterruptedRuns } from './store.js';
import { httpRequestDuration, httpRequests } from './metrics.js';

type RawBodyRequest = FastifyRequest & { rawBody?: string };

/** Workspace TTL: default 7 days, disable with PROOFLOOP_WORKSPACE_TTL_HOURS=0. */
function workspaceSweeper(): () => void {
  const hours = Number(process.env.PROOFLOOP_WORKSPACE_TTL_HOURS ?? 24 * 7);
  if (!Number.isFinite(hours) || hours <= 0) return () => undefined;
  const root = process.env.PROOFLOOP_WORKSPACE_ROOT ?? '.data/workspaces';
  return () => {
    try {
      const removed = cleanupStaleWorkspaces(root, hours * 60 * 60 * 1000);
      if (removed.length) {
        // eslint-disable-next-line no-console
        console.log(`[proofloop] workspace sweep removed ${removed.length} stale checkout(s)`);
      }
    } catch {
      // sweep is best-effort
    }
  };
}

let sweepTimer: NodeJS.Timeout | null = null;

export function scheduleWorkspaceSweep() {
  if (sweepTimer) return;
  const sweep = workspaceSweeper();
  sweep();
  sweepTimer = setInterval(sweep, 6 * 60 * 60 * 1000);
  sweepTimer.unref?.();
}

export async function buildApp() {
  migrate();
  const interrupted = markInterruptedRuns();
  if (interrupted > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[proofloop] marked ${interrupted} in-flight run(s) as interrupted_restart`);
  }
  scheduleWorkspaceSweep();
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'body.apiKey', 'body.token'],
    },
  });

  // Capture the exact raw JSON bytes on every request so webhook signatures
  // (GitHub X-Hub-Signature-256) can be verified against what GitHub actually
  // signed — re-serializing the parsed object is not byte-stable.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = String(body ?? '');
    (req as RawBodyRequest).rawBody = raw;
    // Empty bodies are tolerated: route handlers treat `body ?? {}` as optional
    // input, and several POSTs (e.g. cancel) legitimately carry no payload.
    if (raw.trim().length === 0) {
      done(null, {});
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      // Only reject OWN prototype-pollution keys. (`'__proto__' in parsed` is
      // always true for plain objects via the prototype chain and would 400
      // every valid POST body — smoke-tested and caught.)
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (Object.hasOwn(parsed, '__proto__') || Object.hasOwn(parsed, 'constructor'))
      ) {
        done(new ProofloopError('bad_request', 'Unsafe JSON keys rejected', 400), undefined);
        return;
      }
      done(null, parsed);
    } catch {
      done(new ProofloopError('bad_request', 'Invalid JSON body', 400), undefined);
    }
  });

  await app.register(cors, {
    origin: process.env.WEB_ORIGIN ?? true,
  });

  app.addHook('onRequest', async (req, reply) => {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    (req as typeof req & { requestId: string }).requestId = requestId;
    reply.header('x-request-id', requestId);
  });

  app.addHook('onRequest', requireApiToken);

  // Observability: per-route request counters + duration histogram.
  app.addHook('onResponse', async (req, reply) => {
    const route = (req.routeOptions?.url ?? req.url ?? '/').split('?')[0] ?? '/';
    const status = String(reply.statusCode ?? 0);
    httpRequests.inc({ route, method: req.method, status });
    const startHr = (req as typeof req & { startHr?: [number, number] }).startHr;
    if (startHr) {
      const [s, ns] = process.hrtime(startHr);
      httpRequestDuration.observe({ route }, s + ns / 1e9);
    }
  });
  app.addHook('onRequest', async (req) => {
    (req as typeof req & { startHr?: [number, number] }).startHr = process.hrtime();
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = (req as typeof req & { requestId?: string }).requestId ?? 'unknown';
    // Validation failures are client errors, not server faults.
    if (err instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: 'invalid_body',
          message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
        },
        requestId,
      });
      return;
    }
    const status =
      err instanceof ProofloopError
        ? err.statusCode
        : (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500 && !(err instanceof ProofloopError)) {
      // Don't leak internal exception text (stack paths, SQL details) to clients.
      req.log.error({ err, requestId }, 'unhandled route error');
      reply.status(status).send({
        error: { code: 'internal_error', message: 'Internal server error' },
        requestId,
      });
      return;
    }
    reply.status(status).send(toErrorBody(err, requestId));
  });

  await registerRoutes(app);
  return app;
}
