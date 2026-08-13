import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { mapOverallToCheckConclusion } from '@proofloop/core';
import { renderMarkdownReport, type EvidencePack } from '@proofloop/evidence';
import { ensureGitlabCheckout, syncRepoToSha } from '@proofloop/git';
import {
  createRepository,
  ensureDefaultOrganization,
  findActiveRunForHead,
  findClaimedRunForHead,
  getRepository,
  getRun,
  listRepositories,
  updateRepositoryLocalPath,
  updateRunGithubMeta,
} from './store.js';
import { enqueueRepositoryCheck } from './queue.js';

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

function gitlabApiBase(): string {
  return (process.env.GITLAB_URL ?? 'https://gitlab.com').replace(/\/$/, '') + '/api/v4';
}

function gitlabToken(): string | undefined {
  return process.env.GITLAB_TOKEN?.trim() || undefined;
}

async function gitlabFetch(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Response> {
  const token = init.token ?? gitlabToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('PRIVATE-TOKEN', token);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(`${gitlabApiBase()}${path}`, { ...init, headers });
}

function summaryMarkdown(pack: EvidencePack, evidenceUrl: string): string {
  return [
    `### ProofLoop`,
    ``,
    `- Overall: \`${pack.run.overallStatus}\``,
    `- Risk: \`${pack.run.riskLevel}\``,
    `- Merge: ${pack.mergeGate?.allowMerge ? 'allowed' : 'blocked'}`,
    `- Claims: ${pack.claims.length}, Unknowns: ${pack.unknowns.length}`,
    `- Evidence: ${evidenceUrl}`,
    ``,
    pack.mergeGate?.reason ?? '',
  ].join('\n');
}

export async function publishGitlabStatus(input: {
  projectId: number | string;
  headSha: string;
  mrIid?: number | null;
  noteId?: number | null;
  pack: EvidencePack;
  runId: string;
}): Promise<{ noteId?: number }> {
  const token = gitlabToken();
  if (!token) return {};

  const publicBase = process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787';
  const evidenceUrl = `${publicBase}/api/runs/${input.runId}/evidence-pack`;
  const conclusion = mapOverallToCheckConclusion(
    input.pack.run.overallStatus as Parameters<typeof mapOverallToCheckConclusion>[0],
  );
  const state =
    conclusion === 'success' ? 'success' : conclusion === 'neutral' ? 'success' : 'failed';
  const body = summaryMarkdown(input.pack, evidenceUrl);

  await gitlabFetch(
    `/projects/${encodeURIComponent(String(input.projectId))}/statuses/${input.headSha}`,
    {
      method: 'POST',
      body: JSON.stringify({
        state,
        name: 'ProofLoop',
        description: `ProofLoop: ${input.pack.run.overallStatus}`,
        target_url: evidenceUrl,
      }),
    },
  ).catch(() => undefined);

  let noteId = input.noteId ?? undefined;
  if (input.mrIid) {
    const marker = '<!-- proofloop-summary -->';
    const noteBody = `${marker}\n${body}\n\n<details><summary>Full markdown</summary>\n\n${renderMarkdownReport(input.pack)}\n</details>`;
    if (noteId) {
      await gitlabFetch(
        `/projects/${encodeURIComponent(String(input.projectId))}/merge_requests/${input.mrIid}/notes/${noteId}`,
        { method: 'PUT', body: JSON.stringify({ body: noteBody }) },
      ).catch(() => undefined);
    } else {
      const list = await gitlabFetch(
        `/projects/${encodeURIComponent(String(input.projectId))}/merge_requests/${input.mrIid}/notes?per_page=50`,
      );
      if (list.ok) {
        const notes = (await list.json()) as Array<{ id: number; body?: string }>;
        const existing = notes.find((n) => n.body?.includes(marker));
        if (existing) {
          noteId = existing.id;
          await gitlabFetch(
            `/projects/${encodeURIComponent(String(input.projectId))}/merge_requests/${input.mrIid}/notes/${noteId}`,
            { method: 'PUT', body: JSON.stringify({ body: noteBody }) },
          ).catch(() => undefined);
        }
      }
      if (!noteId) {
        const created = await gitlabFetch(
          `/projects/${encodeURIComponent(String(input.projectId))}/merge_requests/${input.mrIid}/notes`,
          { method: 'POST', body: JSON.stringify({ body: noteBody }) },
        );
        if (created.ok) {
          const data = (await created.json()) as { id?: number };
          noteId = data.id;
        }
      }
    }
  }

  return { noteId };
}

export async function republishGitlabAfterConfirm(
  runId: string,
  pack: EvidencePack,
): Promise<{ noteId?: number } | null> {
  const run = getRun(runId);
  if (!run) return null;
  const repo = getRepository(run.repositoryId);
  if (!repo || repo.provider !== 'gitlab') return null;
  if (!run.prNumber) return null;

  const projectId = `${repo.owner}/${repo.name}`;
  return publishGitlabStatus({
    projectId,
    headSha: run.headSha,
    mrIid: run.prNumber,
    noteId: run.commentId,
    pack,
    runId,
  });
}

async function resolveLocalPath(input: {
  repo: { id: string; localPath: string | null; owner: string; name: string };
  cloneUrl?: string;
  headSha: string;
  baseSha?: string;
}): Promise<string | null> {
  if (input.repo.localPath) {
    try {
      await syncRepoToSha(input.repo.localPath, input.headSha, input.baseSha);
      return input.repo.localPath;
    } catch {
      // fall through to workspace clone
    }
  }
  const token = gitlabToken();
  if (!token || !input.cloneUrl) return input.repo.localPath;

  const workspaceRoot =
    process.env.PROOFLOOP_WORKSPACE_ROOT ?? resolve(process.cwd(), '.data', 'workspaces');
  const dir = await ensureGitlabCheckout({
    workspaceRoot,
    owner: input.repo.owner,
    name: input.repo.name,
    cloneUrl: input.cloneUrl,
    headSha: input.headSha,
    baseSha: input.baseSha,
    token,
  });
  updateRepositoryLocalPath(input.repo.id, dir);
  return dir;
}

export async function handleGitlabWebhook(input: {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const secret = process.env.GITLAB_WEBHOOK_SECRET;
  const tokenHeader = String(input.headers['x-gitlab-token'] ?? '');
  // Always require a shared secret — same policy as GitHub webhooks.
  if (!secret) {
    return {
      status: 503,
      body: {
        error: {
          code: 'webhook_secret_required',
          message: 'GITLAB_WEBHOOK_SECRET is required to accept GitLab webhooks',
        },
      },
    };
  }
  if (!tokensEqual(tokenHeader, secret)) {
    return { status: 401, body: { error: { code: 'invalid_token', message: 'Invalid X-Gitlab-Token' } } };
  }

  const event = String(input.headers['x-gitlab-event'] ?? '');
  if (!event || (event !== 'Merge Request Hook' && event !== 'merge_request')) {
    return { status: 200, body: { ignored: true, event: event || 'missing' } };
  }

  const payload = input.body as {
    object_kind?: string;
    event_type?: string;
    object_attributes?: {
      action?: string;
      iid?: number;
      description?: string | null;
      source_branch?: string;
      target_branch?: string;
      last_commit?: { id?: string };
      url?: string;
    };
    project?: {
      id?: number;
      name?: string;
      path_with_namespace?: string;
      default_branch?: string;
      http_url_to_repo?: string;
      namespace?: string;
      path?: string;
    };
  };

  if (payload.object_kind && payload.object_kind !== 'merge_request') {
    return { status: 200, body: { ignored: true, object_kind: payload.object_kind } };
  }

  const action = payload.object_attributes?.action ?? '';
  if (!['open', 'update', 'reopen'].includes(action)) {
    return { status: 200, body: { ignored: true, action } };
  }

  const pathWithNs = payload.project?.path_with_namespace ?? '';
  const [owner, ...rest] = pathWithNs.split('/');
  const name = rest.join('/') || payload.project?.path || payload.project?.name || 'unknown';
  const ownerName = owner || payload.project?.namespace || 'unknown';
  const cloneUrl = payload.project?.http_url_to_repo;
  const projectId = payload.project?.id ?? pathWithNs;

  let repo = listRepositories().find(
    (r) => r.provider === 'gitlab' && r.owner === ownerName && r.name === name,
  );
  if (!repo) {
    const canAuto =
      process.env.PROOFLOOP_AUTO_REGISTER === '1' || Boolean(gitlabToken());
    if (!canAuto) {
      return {
        status: 200,
        body: {
          ignored: true,
          reason: 'repository_not_configured',
          repository: `${ownerName}/${name}`,
        },
      };
    }
    // Auto-registered GitLab repos belong to the default tenant.
    const org = ensureDefaultOrganization();
    repo = createRepository({
      provider: 'gitlab',
      owner: ownerName,
      name,
      defaultBranch: payload.project?.default_branch,
      localPath: undefined,
      organizationId: org.id,
    });
  }

  const headSha = payload.object_attributes?.last_commit?.id;
  if (!headSha) {
    return { status: 200, body: { ignored: true, reason: 'missing_head_sha' } };
  }

  // Idempotency: GitLab redelivers webhooks on retries; skip if a run for this
  // head SHA is already queued or in flight.
  const active = findClaimedRunForHead(repo.id, headSha) ?? findActiveRunForHead(repo.id, headSha);
  if (active) {
    return {
      status: 200,
      body: { idempotent: true, runId: active.id, status: active.status },
    };
  }

  // GitLab MR payloads often omit target SHA; use default branch tip via checkout fetch when needed.
  const baseRef = payload.object_attributes?.target_branch ?? repo.defaultBranch ?? 'main';

  const localPath = await resolveLocalPath({
    repo,
    cloneUrl,
    headSha,
    baseSha: undefined,
  });
  if (!localPath) {
    return {
      status: 200,
      body: {
        ignored: true,
        reason: 'missing_local_path',
        hint: 'Set localPath, or configure GITLAB_TOKEN for auto-checkout',
      },
    };
  }

  // Enqueue asynchronously so the webhook returns promptly; the MR note and
  // commit status are published when the queued run completes.
  const run = await enqueueRepositoryCheck({
    repositoryId: repo.id,
    localPath,
    owner: ownerName,
    name,
    base: `origin/${baseRef}`,
    head: headSha,
    prBody: payload.object_attributes?.description ?? undefined,
    noLlm: !process.env.LLM_API_KEY,
    gitlabMeta: {
      projectId,
      headSha,
      mrIid: payload.object_attributes?.iid ?? null,
    },
  });

  return {
    status: 200,
    body: {
      accepted: true,
      queued: true,
      runId: run.id,
      status: run.status,
      overallStatus: run.overallStatus ?? undefined,
      workspace: localPath,
      evidenceUrl: `${process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787'}/api/runs/${run.id}/evidence-pack`,
    },
  };
}
