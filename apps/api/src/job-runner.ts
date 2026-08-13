import type { RepoRule } from '@proofloop/core';
import { runCheckPipeline } from '@proofloop/evidence';
import {
  finalizeQueuedPack,
  getRun,
  isCancelRequested,
  listRules,
  updateRunProgress,
} from './store.js';

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

export async function processCheckJob(payload: CheckJobPayload): Promise<void> {
  const { runId } = payload;
  if (isCancelRequested(runId)) {
    updateRunProgress(runId, {
      status: 'cancelled',
      phase: 'cancelled',
      finishedAt: new Date().toISOString(),
      errorCode: 'cancelled',
      cancelRequested: true,
    });
    return;
  }

  const ac = new AbortController();
  activeControllers.set(runId, ac);
  const rules = rulesForRepo(payload.repositoryId);

  try {
    updateRunProgress(runId, { status: 'analyzing', phase: 'collecting' });
    const result = await runCheckPipeline({
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

    if (ac.signal.aborted || isCancelRequested(runId)) {
      updateRunProgress(runId, {
        status: 'cancelled',
        phase: 'cancelled',
        finishedAt: new Date().toISOString(),
        errorCode: 'cancelled',
        cancelRequested: true,
      });
      return;
    }

    finalizeQueuedPack({
      runId,
      repositoryId: payload.repositoryId,
      pack: result.pack,
      evidencePath: result.evidencePath,
    });

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

    // Webhook-triggered runs publish their Check Run + comment asynchronously,
    // so the webhook handler returns well inside GitHub's 10s window.
    if (payload.githubMeta) {
      const { publishGithubStatus } = await import('./github.js');
      const published = await publishGithubStatus({
        owner: payload.githubMeta.owner,
        repo: payload.githubMeta.repo,
        headSha: payload.githubMeta.headSha,
        prNumber: payload.githubMeta.prNumber,
        installationId: payload.githubMeta.installationId,
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (ac.signal.aborted || isCancelRequested(runId) || message === 'run_cancelled') {
      updateRunProgress(runId, {
        status: 'cancelled',
        phase: 'cancelled',
        finishedAt: new Date().toISOString(),
        errorCode: 'cancelled',
        cancelRequested: true,
      });
    } else {
      updateRunProgress(runId, {
        status: 'failed',
        phase: 'failed',
        finishedAt: new Date().toISOString(),
        errorCode: message.slice(0, 120),
      });
    }
  } finally {
    activeControllers.delete(runId);
  }
}

export function getActiveRun(runId: string) {
  return getRun(runId);
}
