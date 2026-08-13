import { Queue, Worker, type Job } from 'bullmq';
import { createId } from '@proofloop/core';
import { getSha, withMemoryLock } from '@proofloop/git';
import {
  claimOrGetHeadRun,
  createQueuedRun,
  getRun,
  requestRunCancel,
  type RunRow,
} from './store.js';
import {
  abortActiveJob,
  hasActiveJob,
  processCheckJob,
  type CheckJobPayload,
} from './job-runner.js';

const QUEUE_NAME = 'proofloop-checks';
const redisUrl = process.env.REDIS_URL?.trim() || '';

let bullQueue: Queue<CheckJobPayload> | null = null;
let bullWorker: Worker<CheckJobPayload> | null = null;
let redisEnabled: boolean | null = null;

function useRedis(): boolean {
  if (redisEnabled !== null) return redisEnabled;
  redisEnabled = Boolean(redisUrl);
  return redisEnabled;
}

function connectionOpts() {
  return { url: redisUrl, maxRetriesPerRequest: null as null };
}

async function ensureBull(): Promise<Queue<CheckJobPayload>> {
  if (bullQueue) return bullQueue;
  bullQueue = new Queue<CheckJobPayload>(QUEUE_NAME, {
    connection: connectionOpts(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  });
  // Process jobs under a per-repo memory lock so concurrent workers for the
  // same repository never overlap (BullMQ concurrency > 1).
  if (!bullWorker) {
    bullWorker = new Worker<CheckJobPayload>(
      QUEUE_NAME,
      async (job: Job<CheckJobPayload>) => {
        const key = `repo:${job.data.repositoryId}:${job.data.localPath}`;
        await withMemoryLock(key, () => processCheckJob(job.data));
      },
      { connection: connectionOpts(), concurrency: Number(process.env.PROOFLOOP_QUEUE_CONCURRENCY ?? 2) },
    );
    bullWorker.on('failed', (job, err) => {
      // eslint-disable-next-line no-console
      console.error(`[proofloop] job failed ${job?.id}:`, err.message);
    });
  }
  return bullQueue;
}

/** Start Redis worker if REDIS_URL is set (no-op otherwise). */
export async function startQueueWorker(): Promise<{ mode: 'redis' | 'memory' }> {
  if (!useRedis()) return { mode: 'memory' };
  await ensureBull();
  return { mode: 'redis' };
}

export async function stopQueueWorker(): Promise<void> {
  if (bullWorker) {
    await bullWorker.close();
    bullWorker = null;
  }
  if (bullQueue) {
    await bullQueue.close();
    bullQueue = null;
  }
}

export function cancelQueuedRun(runId: string): boolean {
  const persisted = requestRunCancel(runId);
  const aborted = abortActiveJob(runId);
  if (useRedis() && bullQueue) {
    void bullQueue.getJob(runId).then((job) => job?.remove().catch(() => undefined));
  }
  return persisted || aborted || hasActiveJob(runId);
}

export function isRunCancellable(runId: string): boolean {
  if (hasActiveJob(runId)) return true;
  const run = getRun(runId);
  return Boolean(run && ['queued', 'analyzing', 'verifying'].includes(run.status));
}

export function queueBackend(): 'redis' | 'memory' {
  return useRedis() ? 'redis' : 'memory';
}

export async function enqueueRepositoryCheck(input: {
  repositoryId: string;
  localPath: string;
  owner: string;
  name: string;
  base?: string;
  head?: string;
  prBody?: string;
  noLlm?: boolean;
  sync?: boolean;
  /** GitHub webhook metadata — job-runner publishes Check Run + comment when set. */
  githubMeta?: CheckJobPayload['githubMeta'];
  /** GitLab webhook metadata — job-runner publishes commit status + MR note when set. */
  gitlabMeta?: CheckJobPayload['gitlabMeta'];
}): Promise<RunRow> {
  const baseRef = input.base ?? 'HEAD~1';
  const headRef = input.head ?? 'HEAD';
  const baseSha = await getSha(input.localPath, baseRef);
  const headSha = await getSha(input.localPath, headRef);
  const runId = createId('run');
  const source = input.githubMeta ? 'github_pr' : input.gitlabMeta ? 'gitlab_mr' : 'api';
  const prNumber = input.githubMeta?.prNumber ?? input.gitlabMeta?.mrIid ?? null;

  // Webhook heads are claimed atomically so redeliveries never double-enqueue.
  let run: RunRow;
  let created = true;
  if (source === 'github_pr' || source === 'gitlab_mr') {
    const claimed = claimOrGetHeadRun({
      id: runId,
      repositoryId: input.repositoryId,
      baseSha,
      headSha,
      source,
      prNumber,
    });
    run = claimed.run;
    created = claimed.created;
    if (!created) return run;
  } else {
    run = createQueuedRun({
      id: runId,
      repositoryId: input.repositoryId,
      baseSha,
      headSha,
      source,
      prNumber,
    });
  }

  const payload: CheckJobPayload = {
    runId: run.id,
    repositoryId: input.repositoryId,
    localPath: input.localPath,
    owner: input.owner,
    name: input.name,
    baseRef,
    headRef,
    prBody: input.prBody,
    noLlm: input.noLlm,
    githubMeta: input.githubMeta,
    gitlabMeta: input.gitlabMeta,
  };

  const work = () =>
    withMemoryLock(`repo:${input.repositoryId}:${input.localPath}`, () => processCheckJob(payload));

  if (input.sync) {
    await work();
    return getRun(run.id) ?? run;
  }

  if (useRedis()) {
    const q = await ensureBull();
    await q.add('check', payload, { jobId: run.id });
  } else {
    void work().catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[proofloop] in-memory job ${run.id} error:`, err);
    });
  }

  return getRun(run.id) ?? run;
}
