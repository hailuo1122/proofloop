import { buildApp } from './app.js';
import { startQueueWorker } from './queue.js';
import { apiAuthEnabled } from './auth.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

// Production guard: refuse to start without API token.
if (process.env.NODE_ENV === 'production' && !apiAuthEnabled()) {
  console.error(
    '[proofloop] Fatal: PROOFLOOP_API_TOKEN (or PROOFLOOP_API_KEYS) must be set in production.',
  );
  process.exit(1);
}

const queue = await startQueueWorker();
const app = await buildApp();
await app.listen({ port, host });
app.log.info({ port, host, queue: queue.mode }, 'ProofLoop API listening');
