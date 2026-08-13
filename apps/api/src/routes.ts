import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import {
  ProofloopError,
  mergeRulesIntoConfig,
  parseProofloopConfig,
  summarizeRuleImpact,
  type RepoRule,
} from '@proofloop/core';
import {
  confirmClaimOnDisk,
  EvidencePackSchema,
} from '@proofloop/evidence';
import {
  createOrganization,
  createRepository,
  ensureDefaultOrganization,
  getOrganization,
  getRepository,
  getRun,
  insertVerification,
  listClaims,
  listImpact,
  listImpactEdges,
  listMetricEvents,
  listOrganizations,
  listRepositories,
  listRules,
  listRuns,
  listVerifications,
  putRules,
  updateRunOverall,
  upsertClaimStatus,
  type RepoRow,
  type RunRow,
} from './store.js';
import { scopeForRequest, apiAuthEnabled } from './auth.js';
import { renderMetrics } from './metrics.js';
import { evidenceConfigured, getEvidenceStorage } from './storage.js';
import { handleGithubWebhook, republishGithubAfterConfirm } from './github.js';
import {
  appCredentials,
  createAppOctokit,
  getInstallationToken,
} from './github-auth.js';
import { handleGitlabWebhook, republishGitlabAfterConfirm } from './gitlab.js';
import {
  cancelQueuedRun,
  enqueueRepositoryCheck,
  isRunCancellable,
  queueBackend,
} from './queue.js';

/**
 * Demo fixture path. Explicit opt-in only: `PROOFLOOP_DEMO_PATH` must be set.
 * There is no implicit fallback to bundled fixtures — the API is a product,
 * not a demo player.
 */
function defaultDemoPath(): string {
  const demo = process.env.PROOFLOOP_DEMO_PATH;
  if (!demo) {
    throw new ProofloopError(
      'bad_request',
      'Demo bootstrap is opt-in: set PROOFLOOP_DEMO_PATH to a demo repository path (or register a real repository instead).',
      400,
    );
  }
  return resolve(demo);
}

function rid(req: { requestId?: string }) {
  return req.requestId ?? 'unknown';
}

/** Load a run's evidence pack text: local disk first, then object storage. */
async function loadEvidenceText(run: { id: string; evidencePath: string | null }): Promise<string | null> {
  if (run.evidencePath && existsSync(run.evidencePath)) {
    return readFileSync(run.evidencePath, 'utf8');
  }
  if (evidenceConfigured()) {
    return getEvidenceStorage().get(`evidence/${run.id}.json`);
  }
  return null;
}

/** Org-scope check: org-bound keys only see their own org's repositories. */
function assertRepoVisible(req: { requestId?: string }, repo: RepoRow | undefined): RepoRow {
  if (!repo) throw new ProofloopError('not_found', 'Repository not found', 404);
  const scope = scopeForRequest(req as never);
  if (scope.organizationId && repo.organizationId !== scope.organizationId) {
    throw new ProofloopError('forbidden', 'Repository not in your organization', 403);
  }
  return repo;
}

/** Org-scope check for runs: resolves the owning repository first. */
function assertRunVisible(req: { requestId?: string }, run: RunRow | undefined) {
  if (!run) throw new ProofloopError('not_found', 'Run not found', 404);
  const scope = scopeForRequest(req as never);
  if (scope.organizationId) {
    const repo = getRepository(run.repositoryId);
    if (!repo || repo.organizationId !== scope.organizationId) {
      throw new ProofloopError('forbidden', 'Run not in your organization', 403);
    }
  }
  return run;
}

function repoRules(repositoryId: string): RepoRule[] {
  return listRules(repositoryId).map((r) => ({
    key: r.key,
    description: r.description,
    ruleType: r.ruleType,
    config: JSON.parse(r.configJson) as Record<string, unknown>,
    enabled: r.enabled,
  }));
}

function syncRulesToYml(localPath: string | null | undefined, rules: RepoRule[]) {
  if (!localPath) return;
  const ymlPath = join(localPath, 'proofloop.yml');
  const base = existsSync(ymlPath)
    ? parseProofloopConfig(parseYaml(readFileSync(ymlPath, 'utf8')))
    : parseProofloopConfig({});
  const merged = mergeRulesIntoConfig(base, rules);
  writeFileSync(
    ymlPath,
    stringifyYaml({
      project: base.project,
      commands: merged.commands,
      policies: merged.policies,
      context: base.context,
      redaction: base.redaction,
    }),
    'utf8',
  );
}

export async function registerRoutes(app: FastifyInstance) {
  app.get('/api/health', async (req) => ({
    ok: true,
    service: 'proofloop-api',
    auth: apiAuthEnabled(),
    queue: queueBackend(),
    version: process.env.npm_package_version ?? '0.1.0',
    uptimeSeconds: Math.round(process.uptime()),
    requestId: rid(req as { requestId?: string }),
  }));

  app.get('/api/metrics', async (_req, reply) => {
    reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(renderMetrics());
  });

  app.get('/api/organizations', async (req) => {
    const scope = scopeForRequest(req as never);
    let data = listOrganizations();
    if (scope.organizationId) {
      data = data.filter((o) => o.id === scope.organizationId);
    }
    return {
      data,
      requestId: rid(req as { requestId?: string }),
    };
  });

  /** GitHub App metadata — verifies App JWT signing is configured and working. */
  app.get('/api/github/app', async (req) => {
    const creds = appCredentials();
    if (!creds) {
      throw new ProofloopError(
        'not_configured',
        'GitHub App not configured (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY)',
        404,
      );
    }
    const octokit = await createAppOctokit();
    if (!octokit) {
      throw new ProofloopError('not_configured', 'Unable to sign App JWT', 500);
    }
    const { data } = await octokit.apps.getAuthenticated().catch(() => ({ data: null }));
    return {
      data: {
        appId: creds.appId,
        slug: data?.slug ?? null,
        name: data?.name ?? null,
        url: data?.html_url ?? null,
        permissions: data?.permissions ?? null,
        events: data?.events ?? null,
      },
      requestId: rid(req as { requestId?: string }),
    };
  });

  /**
   * Mint (and cache) a GitHub App installation token — used for ops/diagnostics
   * and to validate the App→installation flow end to end.
   */
  app.post('/api/github/app/installations/:id/token', async (req) => {
    const { id } = req.params as { id: string };
    const installationId = Number(id);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new ProofloopError('bad_request', 'Invalid installation id', 400);
    }
    const token = await getInstallationToken(installationId);
    if (!token) {
      throw new ProofloopError(
        'not_configured',
        'GitHub App not configured (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY)',
        404,
      );
    }
    return {
      data: {
        installationId,
        expiresAt: token.expiresAt,
        // Never echo the token itself in normal responses; only a live check flag.
        minted: true,
      },
      requestId: rid(req as { requestId?: string }),
    };
  });

  app.post('/api/organizations', async (req) => {
    const scope = scopeForRequest(req as never);
    if (scope.organizationId) {
      throw new ProofloopError(
        'forbidden',
        'Org-scoped API keys cannot create organizations',
        403,
      );
    }
    const body = z
      .object({
        name: z.string().min(1),
        slug: z.string().optional(),
      })
      .parse(req.body ?? {});
    const data = createOrganization(body);
    return { data, requestId: rid(req as { requestId?: string }) };
  });

  app.get('/api/organizations/:id/repositories', async (req) => {
    const { id } = req.params as { id: string };
    const org = getOrganization(id);
    if (!org) throw new ProofloopError('not_found', 'Organization not found', 404);
    const scope = scopeForRequest(req as never);
    if (scope.organizationId && scope.organizationId !== id) {
      throw new ProofloopError('forbidden', 'Organization not in your scope', 403);
    }
    return { data: listRepositories(id), requestId: rid(req as { requestId?: string }) };
  });

  app.post('/api/demo/bootstrap', async (req) => {
    const scope = scopeForRequest(req as never);
    const body = z
      .object({
        runCheck: z.boolean().optional(),
        base: z.string().optional(),
        head: z.string().optional(),
        sync: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const localPath = defaultDemoPath();
    if (!existsSync(localPath)) {
      throw new ProofloopError(
        'not_found',
        `Demo repo missing at ${localPath}. Run pnpm demo:setup first.`,
        404,
      );
    }
    // Org-scoped keys may only bootstrap into their own tenant — never the global default.
    const org = scope.organizationId
      ? getOrganization(scope.organizationId)
      : ensureDefaultOrganization();
    if (!org) {
      throw new ProofloopError('forbidden', 'Organization not in your scope', 403);
    }
    const existing = listRepositories(org.id).find(
      (r) => r.owner === 'proofloop' && r.name === 'demo-repo',
    );
    const repo =
      existing ??
      createRepository({
        provider: 'local',
        owner: 'proofloop',
        name: 'demo-repo',
        language: 'typescript',
        localPath,
        organizationId: org.id,
      });

    if (!body.runCheck) {
      return {
        data: { repository: repo, run: null },
        requestId: rid(req as { requestId?: string }),
      };
    }

    const run = await enqueueRepositoryCheck({
      repositoryId: repo.id,
      localPath,
      owner: repo.owner,
      name: repo.name,
      base: body.base ?? 'HEAD~1',
      head: body.head ?? 'HEAD',
      noLlm: true,
      sync: body.sync ?? true,
    });
    return {
      data: {
        repository: repo,
        run,
        overallStatus: run.overallStatus ?? undefined,
      },
      requestId: rid(req as { requestId?: string }),
    };
  });

  app.get('/api/repositories', async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const scope = scopeForRequest(req as never);
    // Org-bound keys can only list their own org; an explicit query is overridden.
    const organizationId =
      scope.organizationId ?? (typeof q.organizationId === 'string' ? q.organizationId : undefined);
    return {
      data: listRepositories(organizationId),
      requestId: rid(req as { requestId?: string }),
    };
  });

  app.post('/api/repositories', async (req) => {
    const body = z
      .object({
        provider: z.enum(['github', 'gitlab', 'local']),
        owner: z.string(),
        name: z.string(),
        defaultBranch: z.string().optional(),
        language: z.string().optional(),
        localPath: z.string().optional(),
        configPath: z.string().optional(),
        organizationId: z.string().nullish(),
      })
      .parse(req.body);
    const scope = scopeForRequest(req as never);
    // Org-bound keys cannot create repositories in another org.
    const organizationId = scope.organizationId ?? body.organizationId ?? null;
    const data = createRepository({ ...body, organizationId });
    return { data, requestId: rid(req as { requestId?: string }) };
  });

  app.get('/api/repositories/:id/runs', async (req) => {
    const { id } = req.params as { id: string };
    assertRepoVisible(req as never, getRepository(id));
    return { data: listRuns(id), requestId: rid(req as { requestId?: string }) };
  });

  app.get('/api/repositories/:id/history', async (req) => {
    const { id } = req.params as { id: string };
    assertRepoVisible(req as never, getRepository(id));
    const runs = listRuns(id);
    const events = listMetricEvents(id, 100);
    const durations = runs.map((r) => r.totalDurationMs ?? 0).filter(Boolean);
    const avg = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;
    return {
      data: {
        summary: {
          runs: runs.length,
          avgDurationMs: avg,
          failedOrBlocked: runs.filter((r) =>
            ['failed', 'high_blocked', 'critical_blocked'].includes(r.overallStatus ?? ''),
          ).length,
          unknownHighRisk: runs.filter((r) => r.overallStatus === 'unknown_high_risk').length,
          passed: runs.filter((r) =>
            ['passed', 'passed_with_warnings'].includes(r.overallStatus ?? ''),
          ).length,
        },
        runs,
        events,
      },
      requestId: rid(req as { requestId?: string }),
    };
  });

  app.post('/api/repositories/:id/runs', async (req) => {
    const { id } = req.params as { id: string };
    const repo = assertRepoVisible(req as never, getRepository(id));
    const body = z
      .object({
        base: z.string().optional(),
        head: z.string().optional(),
        prBody: z.string().optional(),
        noLlm: z.boolean().optional(),
        sync: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    if (!repo.localPath) {
      throw new ProofloopError('bad_request', 'Repository has no localPath for execution', 400);
    }
    const run = await enqueueRepositoryCheck({
      repositoryId: id,
      localPath: repo.localPath,
      owner: repo.owner,
      name: repo.name,
      base: body.base,
      head: body.head,
      prBody: body.prBody,
      noLlm: body.noLlm ?? true,
      sync: body.sync ?? false,
    });
    return { data: run, requestId: rid(req as { requestId?: string }) };
  });

  app.get('/api/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = assertRunVisible(req as never, getRun(id));
    return {
      data: { ...run, cancellable: isRunCancellable(id) },
      requestId: rid(req as { requestId?: string }),
    };
  });

  app.get('/api/runs/:id/claims', async (req) => {
    const { id } = req.params as { id: string };
    assertRunVisible(req as never, getRun(id));
    const rows = listClaims(id).map((c) => ({
      ...c,
      relatedFiles: JSON.parse(c.relatedFilesJson),
      relatedSymbols: JSON.parse(c.relatedSymbolsJson),
      evidenceRefs: JSON.parse(c.evidenceRefsJson),
    }));
    return { data: rows, requestId: rid(req as { requestId?: string }) };
  });

  app.get('/api/runs/:id/verifications', async (req) => {
    const { id } = req.params as { id: string };
    assertRunVisible(req as never, getRun(id));
    const rows = listVerifications(id).map((v) => ({
      ...v,
      relatedClaimIds: JSON.parse(v.relatedClaimIdsJson),
    }));
    return { data: rows, requestId: rid(req as { requestId?: string }) };
  });

  app.get('/api/runs/:id/impact-graph', async (req) => {
    const { id } = req.params as { id: string };
    const run = assertRunVisible(req as never, getRun(id));
    const nodes = listImpact(id);
    const storedEdges = listImpactEdges(id);
    const edges = storedEdges.length
      ? storedEdges.map((e) => ({
          id: e.id,
          from: e.fromNodeId,
          to: e.toNodeId,
          relation: e.relation,
        }))
      : nodes
          .filter((n) => n.relation === 'imports' && n.path)
          .map((n) => ({
            id: `${n.id}-legacy`,
            from: n.path,
            to: n.label,
            relation: n.relation,
          }));
    // Surface the analyzer's real coverage note when the pack is readable.
    let coverageNote = `Impact graph for run ${id}: ${nodes.length} node(s), ${edges.length} edge(s).`;
    const packText = await loadEvidenceText(run);
    if (packText) {
      try {
        const pack = EvidencePackSchema.parse(JSON.parse(packText));
        if (pack.impactGraph?.coverageNote) coverageNote = pack.impactGraph.coverageNote;
      } catch {
        // keep fallback note
      }
    }
    return {
      data: {
        nodes,
        edges,
        coverageNote,
      },
      requestId: rid(req as { requestId?: string }),
    };
  });

  app.get('/api/runs/:id/evidence-pack', async (req) => {
    const { id } = req.params as { id: string };
    const run = assertRunVisible(req as never, getRun(id));
    const text = await loadEvidenceText(run);
    if (!text) {
      throw new ProofloopError('not_found', 'Evidence pack missing (run may still be active)', 404);
    }
    const pack = EvidencePackSchema.parse(JSON.parse(text));
    return { data: pack, requestId: rid(req as { requestId?: string }) };
  });

  app.get('/api/runs/:id/explain', async (req) => {
    const { id } = req.params as { id: string };
    const run = assertRunVisible(req as never, getRun(id));
    const text = await loadEvidenceText(run);
    if (!text) {
      throw new ProofloopError('not_found', 'Evidence pack missing', 404);
    }
    const pack = EvidencePackSchema.parse(JSON.parse(text));
    const claims = pack.claims.map((c) => {
      const vers = (pack.verifications as Array<Record<string, unknown>>).filter(
        (v) => v.claimId === c.id || (v.relatedClaimIds as string[] | undefined)?.includes(c.id),
      );
      const manuals = vers.filter((v) => v.type === 'manual');
      const unknown = (pack.unknowns as Array<Record<string, unknown>>).find(
        (u) => u.claimId === c.id,
      );
      return {
        id: c.id,
        title: c.title,
        status: c.status,
        facts: [
          `Related files: ${(c.relatedFiles ?? []).join(', ') || '(none)'}`,
          `Evidence refs: ${(c.evidenceRefs ?? []).join(', ') || '(none)'}`,
          ...vers
            .filter((v) => v.type !== 'manual')
            .map((v) => `Executed ${v.type} \`${v.command}\` → ${v.status}`),
        ],
        inferences:
          c.source === 'diff_inference' || c.source === 'pr_description'
            ? [`Source is ${c.source}; not independently verified by itself`]
            : [],
        unknowns: unknown ? [String(unknown.reason)] : [],
        manualReviews: manuals.map((v) => String(v.resultSummary ?? '')),
        suggestion: unknown
          ? String(unknown.suggestedVerification ?? 'Add dynamic tests or confirm manually')
          : null,
      };
    });
    return {
      data: {
        runId: id,
        overallStatus: pack.run.overallStatus,
        mergeGate: pack.mergeGate,
        claims,
      },
      requestId: rid(req as { requestId?: string }),
    };
  });

  app.post('/api/runs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const run = assertRunVisible(req as never, getRun(id));
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return {
        data: { id, status: run.status, cancelled: false },
        requestId: rid(req as { requestId?: string }),
      };
    }
    const cancelled = cancelQueuedRun(id);
    const next = getRun(id);
    return {
      data: {
        id,
        status: next?.status ?? (cancelled ? 'cancelled' : run.status),
        cancelled,
      },
      requestId: rid(req as { requestId?: string }),
    };
  });

  app.post('/api/runs/:id/claims/:claimId/confirm', async (req) => {
    const { id, claimId } = req.params as { id: string; claimId: string };
    const run = assertRunVisible(req as never, getRun(id));
    const repo = getRepository(run.repositoryId);
    if (!repo?.localPath) {
      throw new ProofloopError('bad_request', 'Run has no local repository path', 400);
    }
    const body = z
      .object({
        decision: z.enum(['accept', 'reject']),
        note: z.string().min(1, 'note is required for audit'),
        reviewer: z.string().optional(),
      })
      .parse(req.body ?? {});

    const beforeIds = new Set(listVerifications(id).map((v) => v.id));
    const { pack, review, idempotent } = confirmClaimOnDisk({
      cwd: repo.localPath,
      runId: id,
      claimId,
      decision: body.decision,
      note: body.note,
      reviewer: body.reviewer,
    });

    updateRunOverall(id, pack.run.overallStatus, pack.run.riskLevel);
    for (const c of pack.claims) {
      upsertClaimStatus(c.id, c.status, c.evidenceRefs ?? []);
    }
    for (const v of pack.verifications as Array<Record<string, unknown>>) {
      if (beforeIds.has(String(v.id))) continue;
      insertVerification({
        id: String(v.id),
        claimId: (v.claimId as string | null) ?? null,
        runId: id,
        type: String(v.type),
        command: String(v.command),
        safeCommand: Boolean(v.safeCommand),
        status: String(v.status),
        exitCode: (v.exitCode as number | null) ?? null,
        startedAt: (v.startedAt as string | null) ?? null,
        finishedAt: (v.finishedAt as string | null) ?? null,
        durationMs: (v.durationMs as number | null) ?? null,
        environmentFingerprint: (v.environmentFingerprint as string | null) ?? null,
        logArtifactId: (v.logArtifactId as string | null) ?? null,
        resultSummary: String(v.resultSummary ?? ''),
        relatedClaimIds: (v.relatedClaimIds as string[]) ?? [],
      });
    }

    const github = await republishGithubAfterConfirm(id, pack).catch(() => null);
    const gitlab = await republishGitlabAfterConfirm(id, pack).catch(() => null);

    return {
      data: {
        claimId,
        decision: body.decision,
        overallStatus: pack.run.overallStatus,
        allowMerge: pack.mergeGate?.allowMerge ?? false,
        reason: pack.mergeGate?.reason,
        review,
        idempotent,
        github,
        gitlab,
        pack,
      },
      requestId: rid(req as { requestId?: string }),
    };
  });

  app.get('/api/repositories/:id/rules', async (req) => {
    const { id } = req.params as { id: string };
    assertRepoVisible(req as never, getRepository(id));
    const rows = listRules(id).map((r) => ({
      ...r,
      config: JSON.parse(r.configJson),
    }));
    return { data: rows, requestId: rid(req as { requestId?: string }) };
  });

  app.post('/api/repositories/:id/rules/preview', async (req) => {
    const { id } = req.params as { id: string };
    const repo = assertRepoVisible(req as never, getRepository(id));
    const body = z
      .object({
        rules: z.array(
          z.object({
            key: z.string(),
            description: z.string(),
            ruleType: z.string(),
            config: z.record(z.unknown()),
            enabled: z.boolean(),
          }),
        ),
      })
      .parse(req.body ?? {});
    const ymlPath = repo.localPath ? join(repo.localPath, 'proofloop.yml') : null;
    const base = ymlPath && existsSync(ymlPath)
      ? parseProofloopConfig(parseYaml(readFileSync(ymlPath, 'utf8')))
      : parseProofloopConfig({});
    const impact = summarizeRuleImpact(base, body.rules);
    return { data: impact, requestId: rid(req as { requestId?: string }) };
  });

  app.put('/api/repositories/:id/rules', async (req) => {
    const { id } = req.params as { id: string };
    const repo = assertRepoVisible(req as never, getRepository(id));
    const body = z
      .object({
        rules: z.array(
          z.object({
            key: z.string(),
            description: z.string(),
            ruleType: z.enum([
              'architecture',
              'security',
              'testing',
              'compatibility',
              'command_policy',
            ]),
            config: z.record(z.unknown()),
            enabled: z.boolean(),
          }),
        ),
      })
      .parse(req.body);
    const asRepoRules: RepoRule[] = body.rules;
    const ymlPath = repo.localPath ? join(repo.localPath, 'proofloop.yml') : null;
    const base =
      ymlPath && existsSync(ymlPath)
        ? parseProofloopConfig(parseYaml(readFileSync(ymlPath, 'utf8')))
        : parseProofloopConfig({});
    const preview = summarizeRuleImpact(base, asRepoRules);
    const data = putRules(id, body.rules);
    syncRulesToYml(repo.localPath, asRepoRules);
    return {
      data: { rules: data, appliedPolicies: preview.after, changes: preview.changes },
      requestId: rid(req as { requestId?: string }),
    };
  });

  app.post('/api/github/webhook', async (req, reply) => {
    const result = await handleGithubWebhook({
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: req.body,
      rawBody: (req as { rawBody?: string }).rawBody,
    });
    return reply.status(result.status).send({ ...result.body, requestId: rid(req as { requestId?: string }) });
  });

  app.post('/api/gitlab/webhook', async (req, reply) => {
    const result = await handleGitlabWebhook({
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: req.body,
    });
    return reply.status(result.status).send({ ...result.body, requestId: rid(req as { requestId?: string }) });
  });
}
