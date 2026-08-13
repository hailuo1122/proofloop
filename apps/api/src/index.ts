import { buildApp } from './app.js';
import { startQueueWorker } from './queue.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

const queue = await startQueueWorker();
const app = await buildApp();
await app.listen({ port, host });
app.log.info({ port, host, queue: queue.mode }, 'ProofLoop API listening');
