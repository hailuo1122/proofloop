import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { mapOverallToCheckConclusion } from '@proofloop/core';
import { renderMarkdownReport, type EvidencePack } from '@proofloop/evidence';
import { ensureGithubCheckout, syncRepoToSha } from '@proofloop/git';
import {
  createRepository,
  ensureOrganizationForInstallation,
  findActiveRunForHead,
  findClaimedRunForHead,
  getRepository,
  getRun,
  listRepositories,
  upsertGithubInstallation,
  updateRepositoryLocalPath,
  updateRunGithubMeta,
} from './store.js';
import { createGithubOctokit, withGithubRetry } from './github-auth.js';
import { enqueueRepositoryCheck } from './queue.js';

function verifySignature(secret: string, payload: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function summaryMarkdown(pack: EvidencePack, evidenceUrl: string): string {
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

export async function publishGithubStatus(input: {
  owner: string;
  repo: string;
  headSha: string;
  prNumber?: number | null;
  checkRunId?: number | null;
  commentId?: number | null;
  pack: EvidencePack;
  runId: string;
  installationId?: number | null;
}): Promise<{ checkRunId?: number; commentId?: number }> {
  const auth = await createGithubOctokit(input.installationId);
  if (!auth) return {};

  const { octokit } = auth;
  const publicBase = process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787';
  const evidenceUrl = `${publicBase}/api/runs/${input.runId}/evidence-pack`;
  const conclusion = mapOverallToCheckConclusion(
    input.pack.run.overallStatus as Parameters<typeof mapOverallToCheckConclusion>[0],
  );
  const body = summaryMarkdown(input.pack, evidenceUrl);

  let checkRunId = input.checkRunId ?? undefined;
  if (checkRunId) {
    const updateId = checkRunId;
    await withGithubRetry(() =>
      octokit.checks.update({
        owner: input.owner,
        repo: input.repo,
        check_run_id: updateId,
        status: 'completed',
        conclusion,
        output: {
          title: `ProofLoop: ${input.pack.run.overallStatus}`,
          summary: body,
        },
      }),
    );
  } else {
    const createCheck = (annotations: typeof ANNOTATIONS) =>
      withGithubRetry(() =>
        octokit.checks.create({
          owner: input.owner,
          repo: input.repo,
          name: 'ProofLoop',
          head_sha: input.headSha,
          status: 'completed',
          conclusion,
          output: {
            title: `ProofLoop: ${input.pack.run.overallStatus}`,
            summary: body,
            annotations,
          },
        }),
      );
    const ANNOTATIONS = input.pack.claims.slice(0, 20).map((c) => ({
      path: c.relatedFiles[0] ?? 'README.md',
      start_line: 1,
      end_line: 1,
      annotation_level: (
        c.status === 'blocked' ? 'failure' : c.status === 'unknown' ? 'warning' : 'notice'
      ) as 'failure' | 'warning' | 'notice',
      message: `[${c.status}] ${c.title}`,
    }));
    let check;
    try {
      // GitHub rejects annotations referencing files outside the diff (422).
      check = await createCheck(ANNOTATIONS);
    } catch (err) {
      if ((err as { status?: number })?.status === 422) {
        check = await createCheck([]);
      } else {
        throw err;
      }
    }
    checkRunId = check.data.id;
  }

  let commentId = input.commentId ?? undefined;
  if (input.prNumber) {
    const prNumber = input.prNumber;
    const marker = '<!-- proofloop-summary -->';
    const commentBody = `${marker}\n${body}\n\n<details><summary>Full markdown</summary>\n\n${renderMarkdownReport(input.pack)}\n</details>`;
    if (commentId) {
      const updateId = commentId;
      await withGithubRetry(() =>
        octokit.issues.updateComment({
          owner: input.owner,
          repo: input.repo,
          comment_id: updateId,
          body: commentBody,
        }),
      );
    } else {
      const comments = await withGithubRetry(() =>
        octokit.issues.listComments({
          owner: input.owner,
          repo: input.repo,
          issue_number: prNumber,
        }),
      );
      const existing = comments.data.find((c) => c.body?.includes(marker));
      if (existing) {
        await withGithubRetry(() =>
          octokit.issues.updateComment({
            owner: input.owner,
            repo: input.repo,
            comment_id: existing.id,
            body: commentBody,
          }),
        );
        commentId = existing.id;
      } else {
        const created = await withGithubRetry(() =>
          octokit.issues.createComment({
            owner: input.owner,
            repo: input.repo,
            issue_number: input.prNumber!,
            body: commentBody,
          }),
        );
        commentId = created.data.id;
      }
    }
  }

  updateRunGithubMeta(input.runId, { checkRunId, commentId });
  return { checkRunId, commentId };
}

export async function republishGithubAfterConfirm(
  runId: string,
  pack: EvidencePack,
): Promise<{ checkRunId?: number; commentId?: number } | null> {
  const run = getRun(runId);
  if (!run) return null;
  const repo = getRepository(run.repositoryId);
  if (!repo || repo.provider !== 'github') return null;
  if (!run.checkRunId && !run.prNumber) return null;

  return publishGithubStatus({
    owner: repo.owner,
    repo: repo.name,
    headSha: run.headSha,
    prNumber: run.prNumber,
    checkRunId: run.checkRunId,
    commentId: run.commentId,
    pack,
    runId,
  });
}

async function resolveLocalPath(input: {
  repo: { id: string; localPath: string | null; owner: string; name: string };
  cloneUrl?: string;
  headSha: string;
  baseSha?: string;
  installationId?: number;
}): Promise<string | null> {
  // Always sync to the webhook headSha. A stored localPath may be stale after
  // synchronize/update events (or shared incorrectly via DEFAULT_LOCAL_PATH).
  if (input.repo.localPath) {
    try {
      await syncRepoToSha(input.repo.localPath, input.headSha, input.baseSha);
      return input.repo.localPath;
    } catch {
      // Fall through to workspace clone when local sync fails (missing object / not a git dir).
    }
  }

  const auth = await createGithubOctokit(input.installationId);
  if (!auth || !input.cloneUrl) {
    return input.repo.localPath; // may still be usable for local-only demos
  }

  const workspaceRoot =
    process.env.PROOFLOOP_WORKSPACE_ROOT ?? resolve(process.cwd(), '.data', 'workspaces');
  const dir = await ensureGithubCheckout({
    workspaceRoot,
    owner: input.repo.owner,
    name: input.repo.name,
    cloneUrl: input.cloneUrl,
    headSha: input.headSha,
    baseSha: input.baseSha,
    token: auth.token,
  });
  updateRepositoryLocalPath(input.repo.id, dir);
  return dir;
}

export async function handleGithubWebhook(input: {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /** Exact raw request bytes — required for signature verification. */
  rawBody?: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const event = String(input.headers['x-github-event'] ?? '');
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  // GitHub signs the exact bytes it sent; never re-serialize for verification.
  const raw =
    input.rawBody ?? (typeof input.body === 'string' ? input.body : JSON.stringify(input.body ?? {}));
  const { webhookSecretRequired } = await import('./auth.js');
  if (webhookSecretRequired() && !secret) {
    return {
      status: 503,
      body: { error: { code: 'webhook_secret_required', message: 'GITHUB_WEBHOOK_SECRET must be set' } },
    };
  }
  if (secret) {
    const sig = String(input.headers['x-hub-signature-256'] ?? '');
    if (!verifySignature(secret, raw, sig)) {
      return { status: 401, body: { error: { code: 'invalid_signature', message: 'Invalid signature' } } };
    }
  } else {
    // Without a configured secret, refuse PR-triggering events instead of
    // silently processing unsigned webhooks — even in development.
    return {
      status: 503,
      body: {
        error: {
          code: 'webhook_secret_required',
          message: 'GITHUB_WEBHOOK_SECRET is required to accept GitHub webhooks',
        },
      },
    };
  }

  if (event === 'installation') {
    const payload = input.body as {
      action?: string;
      installation?: {
        id?: number;
        account?: { login?: string; type?: string; id?: number };
      };
    };
    const installationId = payload.installation?.id;
    if (!installationId) {
      return { status: 200, body: { ignored: true, event, reason: 'missing_installation_id' } };
    }
    const account = payload.installation?.account;
    const action = payload.action ?? 'created';
    const status = action === 'deleted' ? 'deleted' : 'active';
    upsertGithubInstallation({
      id: installationId,
      accountLogin: account?.login ?? `installation-${installationId}`,
      accountType: account?.type ?? null,
      accountId: account?.id ?? null,
      status,
    });
    return {
      status: 200,
      body: { ok: true, event, action, installationId, status },
    };
  }

  if (event === 'marketplace_purchase') {
    const payload = input.body as {
      action?: string;
      effective_date?: string;
      marketplace_purchase?: {
        plan?: { name?: string };
        account?: { login?: string; type?: string; id?: number };
      };
      installation?: { id?: number };
    };
    const installationId = payload.installation?.id;
    const planName = payload.marketplace_purchase?.plan?.name;
    const account = payload.marketplace_purchase?.account;
    const action = payload.action ?? '';
    if (installationId && account?.login) {
      upsertGithubInstallation({
        id: installationId,
        accountLogin: account.login,
        accountType: account.type ?? null,
        accountId: account.id ?? null,
        plan: planName ?? null,
        status: action === 'cancelled' ? 'cancelled' : 'active',
      });
    }
    return {
      status: 200,
      body: {
        ok: true,
        event,
        action,
        installationId,
        plan: planName ?? null,
        effectiveDate: payload.effective_date ?? null,
      },
    };
  }

  if (event === 'check_suite') {
    const payload = input.body as {
      action?: string;
      check_suite?: { head_sha?: string; head_branch?: string };
      repository?: {
        name?: string;
        default_branch?: string;
        owner?: { login?: string };
        clone_url?: string;
      };
      installation?: { id?: number };
    };
    const action = payload.action ?? '';
    if (!['requested', 'rerequested'].includes(action)) {
      return { status: 200, body: { ignored: true, event, action } };
    }
    const headSha = payload.check_suite?.head_sha;
    if (!headSha) {
      return { status: 200, body: { ignored: true, event, reason: 'missing_head_sha' } };
    }
    const owner = payload.repository?.owner?.login ?? 'unknown';
    const name = payload.repository?.name ?? 'unknown';
    const cloneUrl = payload.repository?.clone_url;
    const installationId = payload.installation?.id;
    let repo = listRepositories().find(
    (r) => r.provider === 'github' && r.owner === owner && r.name === name,
  );
    if (!repo) {
      const canAuto =
        process.env.PROOFLOOP_AUTO_REGISTER === '1' ||
        Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY) ||
        Boolean(process.env.GITHUB_TOKEN);
      if (!canAuto) {
        return {
          status: 200,
          body: { ignored: true, reason: 'repository_not_configured', repository: `${owner}/${name}` },
        };
      }
      const org = installationId
        ? ensureOrganizationForInstallation({ accountLogin: owner, installationId })
        : null;
      repo = createRepository({
        provider: 'github',
        owner,
        name,
        defaultBranch: payload.repository?.default_branch,
        localPath: undefined,
        organizationId: org?.id ?? null,
      });
    }
    const localPath = await resolveLocalPath({
      repo,
      cloneUrl,
      headSha,
      baseSha: undefined,
      installationId,
    });
    if (!localPath) {
      return {
        status: 200,
        body: {
          ignored: true,
          reason: 'missing_local_path',
          hint: 'Set localPath, or configure GITHUB_APP_* / GITHUB_TOKEN for auto-checkout',
        },
      };
    }
    // Idempotency: a duplicate check_suite event for the same head must not
    // enqueue a second run while the first is still in flight.
    const active = findClaimedRunForHead(repo.id, headSha) ?? findActiveRunForHead(repo.id, headSha);
    if (active) {
      return {
        status: 200,
        body: { idempotent: true, runId: active.id, status: active.status },
      };
    }
    const run = await enqueueRepositoryCheck({
      repositoryId: repo.id,
      localPath,
      owner,
      name,
      head: headSha,
      noLlm: !process.env.LLM_API_KEY,
      githubMeta: {
        owner,
        repo: name,
        headSha,
        prNumber: null,
        installationId: installationId ?? null,
      },
    });
    return {
      status: 200,
      body: {
        accepted: true,
        queued: true,
        event,
        action,
        runId: run.id,
        status: run.status,
      },
    };
  }

  if (event !== 'pull_request') {
    return { status: 200, body: { ignored: true, event } };
  }

  const payload = input.body as {
    action?: string;
    number?: number;
    pull_request?: {
      body?: string | null;
      base?: { sha?: string };
      head?: { sha?: string; ref?: string };
      html_url?: string;
    };
    repository?: {
      name?: string;
      full_name?: string;
      default_branch?: string;
      owner?: { login?: string };
      clone_url?: string;
    };
    installation?: { id?: number };
  };

  if (!['opened', 'synchronize', 'reopened'].includes(payload.action ?? '')) {
    return { status: 200, body: { ignored: true, action: payload.action } };
  }

  const owner = payload.repository?.owner?.login ?? 'unknown';
  const name = payload.repository?.name ?? 'unknown';
  const cloneUrl = payload.repository?.clone_url;
  const installationId = payload.installation?.id;
  let repo = listRepositories().find(
    (r) => r.provider === 'github' && r.owner === owner && r.name === name,
  );
  if (!repo) {
    const canAuto =
      process.env.PROOFLOOP_AUTO_REGISTER === '1' ||
      Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY) ||
      Boolean(process.env.GITHUB_TOKEN);
    if (!canAuto) {
      return {
        status: 200,
        body: { ignored: true, reason: 'repository_not_configured', repository: `${owner}/${name}` },
      };
    }
    // Installation-level tenant isolation: auto-registered repos belong to the
    // org owning the GitHub installation, not the global default tenant.
    const org = installationId
      ? ensureOrganizationForInstallation({
          accountLogin: owner,
          installationId,
        })
      : null;
    repo = createRepository({
      provider: 'github',
      owner,
      name,
      defaultBranch: payload.repository?.default_branch,
      localPath: undefined,
      organizationId: org?.id ?? null,
    });
  }

  const baseSha = payload.pull_request?.base?.sha;
  const headSha = payload.pull_request?.head?.sha;
  if (!headSha) {
    return { status: 200, body: { ignored: true, reason: 'missing_head_sha' } };
  }

  // Idempotency: duplicate pull_request events (GitHub redelivery) for the same
  // head must not enqueue a second run (in-flight or already claimed/completed).
  const active = findClaimedRunForHead(repo.id, headSha) ?? findActiveRunForHead(repo.id, headSha);
  if (active) {
    return {
      status: 200,
      body: { idempotent: true, runId: active.id, status: active.status },
    };
  }

  const localPath = await resolveLocalPath({
    repo,
    cloneUrl,
    headSha,
    baseSha,
    installationId,
  });
  if (!localPath) {
    return {
      status: 200,
      body: {
        ignored: true,
        reason: 'missing_local_path',
        hint: 'Set localPath, or configure GITHUB_APP_* / GITHUB_TOKEN for auto-checkout',
      },
    };
  }

  // Enqueue asynchronously: GitHub webhooks must answer within 10s, so the
  // pipeline runs on the queue and the Check Run is published when it finishes.
  const run = await enqueueRepositoryCheck({
    repositoryId: repo.id,
    localPath,
    owner,
    name,
    base: baseSha,
    head: headSha,
    prBody: payload.pull_request?.body ?? undefined,
    noLlm: !process.env.LLM_API_KEY,
    githubMeta: {
      owner,
      repo: name,
      headSha,
      prNumber: payload.number ?? null,
      installationId: installationId ?? null,
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

export function mapCheckConclusionForTest(status: string) {
  return mapOverallToCheckConclusion(status as Parameters<typeof mapOverallToCheckConclusion>[0]);
}
