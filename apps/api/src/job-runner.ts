import type { RepoRule } from '@proofloop/core';
import { runCheckPipeline } from '@proofloop/evidence';
import { pathLockForDir, withPathLock } from '@proofloop/git';
import {
  finalizeQueuedPack,
  getRun,
  isCancelRequested,
  listRules,
  updateRunGithubMeta,
  updateRunProgress,
} from './store.js';
import { activeRuns, runsTotal } from './metrics.js';

export interface CheckJobPayload {
  runId: string;
  repositoryId: string;
  localPath: string;
  owner: string;
  name: string;
  baseRef: string;
  headRef: string;
  prBody?: string;
  noLlm?: boolean;
  /** When set, publish the GitHub Check Run + summary after the run completes. */
  githubMeta?: {
    owner: string;
    repo: string;
    headSha: string;
    prNumber?: number | null;
    installationId?: number | null;
  };
  /** When set, publish the GitLab commit status + MR note after the run completes. */
  gitlabMeta?: {
    projectId: number | string;
    headSha: string;
    mrIid?: number | null;
  };
}

const activeControllers = new Map<string, AbortController>();

export function abortActiveJob(runId: string): boolean {
  const ac = activeControllers.get(runId);
  if (!ac) return false;
  ac.abort();
  return true;
}

export function hasActiveJob(runId: string): boolean {
  return activeControllers.has(runId);
}

function rulesForRepo(repositoryId: string): RepoRule[] {
  return listRules(repositoryId).map((r) => ({
    key: r.key,
    description: r.description,
    ruleType: r.ruleType,
    config: JSON.parse(r.configJson) as Record<string, unknown>,
    enabled: r.enabled,
  }));
}

function markCancelled(runId: string): void {
  updateRunProgress(runId, {
    status: 'cancelled',
    phase: 'cancelled',
    finishedAt: new Date().toISOString(),
    errorCode: 'cancelled',
    cancelRequested: true,
  });
  runsTotal.inc({ status: 'cancelled' });
}

export async function processCheckJob(payload: CheckJobPayload): Promise<void> {
  const { runId } = payload;
  if (isCancelRequested(runId)) {
    markCancelled(runId);
    return;
  }

  const ac = new AbortController();
  activeControllers.set(runId, ac);
  activeRuns.set({ status: 'in_flight' }, activeControllers.size);
  const rules = rulesForRepo(payload.repositoryId);
  // Track the in-progress Check Run created at job start so success/failure
  // publishes patch the same run instead of leaving a dangling "running" state.
  let startedCheckRunId: number | null = null;

  // Run the pipeline under a cross-process filesystem lock keyed by the repo
  // dir. Webhook handlers sync the checkout outside the (process-local) memory
  // lock, so without this lock a concurrent PR could force-checkout the shared
  // directory mid-run and make the pipeline analyze the wrong working tree.
  let result: Awaited<ReturnType<typeof runCheckPipeline>>;
  try {
    result = await withPathLock(
      pathLockForDir(payload.localPath),
      async () => {
        updateRunProgress(runId, { status: 'analyzing', phase: 'collecting' });

        if (payload.githubMeta) {
          const { startGithubCheckRun } = await import('./github.js');
          startedCheckRunId = await startGithubCheckRun({
            owner: payload.githubMeta.owner,
            repo: payload.githubMeta.repo,
            headSha: payload.githubMeta.headSha,
            installationId: payload.githubMeta.installationId,
          });
          if (startedCheckRunId) {
            updateRunGithubMeta(runId, { checkRunId: startedCheckRunId });
          }
        }

        return runCheckPipeline({
          cwd: payload.localPath,
          runId,
          base: payload.baseRef,
          head: payload.headRef,
          prBody: payload.prBody,
          repositoryName: `${payload.owner}/${payload.name}`,
          noLlm: payload.noLlm ?? true,
          repositoryRules: rules,
          signal: ac.signal,
          onPhase: (phase) => {
            if (isCancelRequested(runId)) {
              ac.abort();
              return;
            }
            const status =
              phase === 'verifying' || phase === 'building-evidence' ? 'verifying' : 'analyzing';
            updateRunProgress(runId, { status, phase });
          },
        });
      },
      { timeoutMs: 10 * 60_000 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (ac.signal.aborted || isCancelRequested(runId) || message === 'run_cancelled') {
      markCancelled(runId);
    } else {
      updateRunProgress(runId, {
        status: 'failed',
        phase: 'failed',
        finishedAt: new Date().toISOString(),
        errorCode: message.slice(0, 120),
      });
      runsTotal.inc({ status: 'failed' });
      // A crashed pipeline run must be visible on the provider — otherwise the
      // PR sits with a dangling "running" check (or no check at all).
      if (payload.githubMeta) {
        const { publishGithubFailure } = await import('./github.js');
        await publishGithubFailure({
          owner: payload.githubMeta.owner,
          repo: payload.githubMeta.repo,
          headSha: payload.githubMeta.headSha,
          runId,
          checkRunId: startedCheckRunId,
          prNumber: payload.githubMeta.prNumber,
          installationId: payload.githubMeta.installationId,
          message,
        });
      }
      if (payload.gitlabMeta) {
        const { publishGitlabFailure } = await import('./gitlab.js');
        await publishGitlabFailure({
          projectId: payload.gitlabMeta.projectId,
          headSha: payload.gitlabMeta.headSha,
          mrIid: payload.gitlabMeta.mrIid,
          runId,
          message,
        });
      }
    }
    activeControllers.delete(runId);
    activeRuns.set({ status: 'in_flight' }, activeControllers.size);
    return;
  }

  try {
    if (ac.signal.aborted || isCancelRequested(runId)) {
      markCancelled(runId);
      return;
    }

    const finalized = finalizeQueuedPack({
      runId,
      repositoryId: payload.repositoryId,
      pack: result.pack,
      evidencePath: result.evidencePath,
    });

    // Webhook-triggered runs publish their Check Run + comment asynchronously,
    // so the webhook handler returns well inside GitHub's 10s window.
    if (finalized?.status !== 'cancelled') {
      // Mirror evidence to object storage when configured, so any API instance
      // can serve the pack even if this worker's local disk differs.
      try {
        const { evidenceConfigured, getEvidenceStorage } = await import('./storage.js');
        if (evidenceConfigured()) {
          const { readFileSync } = await import('node:fs');
          await getEvidenceStorage().put(
            `evidence/${runId}.json`,
            readFileSync(result.evidencePath, 'utf8'),
          );
        }
      } catch {
        // best-effort mirror; local disk still holds the pack
      }

      // Re-check cancellation once more before publishing a success status:
      // a cancel landing during finalize must not end up reported as success.
      if (isCancelRequested(runId)) {
        markCancelled(runId);
        return;
      }
      runsTotal.inc({ status: result.pack.run.overallStatus });
      if (payload.githubMeta) {
        const { publishGithubStatus } = await import('./github.js');
        const published = await publishGithubStatus({
          owner: payload.githubMeta.owner,
          repo: payload.githubMeta.repo,
          headSha: payload.githubMeta.headSha,
          prNumber: payload.githubMeta.prNumber,
          installationId: payload.githubMeta.installationId,
          checkRunId: startedCheckRunId,
          pack: result.pack,
          runId,
        });
        if (published.checkRunId || published.commentId) {
          const { updateRunGithubMeta } = await import('./store.js');
          updateRunGithubMeta(runId, {
            checkRunId: published.checkRunId,
            commentId: published.commentId,
          });
        }
      }
      if (payload.gitlabMeta) {
        const { publishGitlabStatus } = await import('./gitlab.js');
        const published = await publishGitlabStatus({
          projectId: payload.gitlabMeta.projectId,
          headSha: payload.gitlabMeta.headSha,
          mrIid: payload.gitlabMeta.mrIid,
          pack: result.pack,
          runId,
        });
        if (published.noteId) {
          const { updateRunGithubMeta } = await import('./store.js');
          updateRunGithubMeta(runId, { commentId: published.noteId });
        }
      }
    }
  } finally {
    activeControllers.delete(runId);
    activeRuns.set({ status: 'in_flight' }, activeControllers.size);
  }
}

export function getActiveRun(runId: string) {
  return getRun(runId);
}
