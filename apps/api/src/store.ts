import { createId } from '@proofloop/core';
import type { EvidencePack } from '@proofloop/evidence';
import { getDb, withTransaction } from './db/client.js';

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoRow {
  id: string;
  organizationId: string | null;
  provider: string;
  owner: string;
  name: string;
  defaultBranch: string;
  language: string | null;
  configPath: string | null;
  localPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRow {
  id: string;
  repositoryId: string;
  baseSha: string;
  headSha: string;
  source: string;
  status: string;
  riskLevel: string;
  overallStatus: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  totalDurationMs: number | null;
  errorCode: string | null;
  evidencePath: string | null;
  prNumber: number | null;
  checkRunId: number | null;
  commentId: number | null;
  phase: string | null;
  cancelRequested: boolean;
}

function mapOrg(row: Record<string, unknown>): OrgRow {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRepo(row: Record<string, unknown>): RepoRow {
  return {
    id: String(row.id),
    organizationId: (row.organization_id as string | null) ?? null,
    provider: String(row.provider),
    owner: String(row.owner),
    name: String(row.name),
    defaultBranch: String(row.default_branch),
    language: (row.language as string | null) ?? null,
    configPath: (row.config_path as string | null) ?? null,
    localPath: (row.local_path as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRun(row: Record<string, unknown>): RunRow {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    baseSha: String(row.base_sha),
    headSha: String(row.head_sha),
    source: String(row.source),
    status: String(row.status),
    riskLevel: String(row.risk_level),
    overallStatus: (row.overall_status as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    totalDurationMs: (row.total_duration_ms as number | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    evidencePath: (row.evidence_path as string | null) ?? null,
    prNumber: (row.pr_number as number | null) ?? null,
    checkRunId: (row.check_run_id as number | null) ?? null,
    commentId: (row.comment_id as number | null) ?? null,
    phase: (row.phase as string | null) ?? null,
    cancelRequested: Boolean(row.cancel_requested),
  };
}

export function listOrganizations(): OrgRow[] {
  return getDb()
    .prepare('SELECT * FROM organizations ORDER BY created_at ASC')
    .all()
    .map((r) => mapOrg(r as Record<string, unknown>));
}

export function createOrganization(input: {
  name: string;
  slug?: string;
}): OrgRow {
  const now = new Date().toISOString();
  const slug = input.slug ?? input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const row: OrgRow = {
    id: createId('org'),
    name: input.name,
    slug,
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      `INSERT INTO organizations (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.name, row.slug, row.createdAt, row.updatedAt);
  return row;
}

export function getOrganization(id: string): OrgRow | undefined {
  const row = getDb()
    .prepare('SELECT * FROM organizations WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapOrg(row) : undefined;
}

/** Find or create the default tenant used for unassigned/local repositories. */
export function ensureDefaultOrganization(): OrgRow {
  const existing = listOrganizations().find((o) => o.slug === 'default');
  if (existing) return existing;
  return createOrganization({ name: 'Default', slug: 'default' });
}

export interface GithubInstallationRow {
  id: number;
  accountLogin: string;
  accountType: string | null;
  accountId: number | null;
  plan: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function mapGithubInstallation(row: Record<string, unknown>): GithubInstallationRow {
  return {
    id: Number(row.id),
    accountLogin: String(row.account_login),
    accountType: (row.account_type as string | null) ?? null,
    accountId: (row.account_id as number | null) ?? null,
    plan: (row.plan as string | null) ?? null,
    status: String(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getGithubInstallation(id: number): GithubInstallationRow | undefined {
  const row = getDb()
    .prepare('SELECT * FROM github_installations WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapGithubInstallation(row) : undefined;
}

export function upsertGithubInstallation(input: {
  id: number;
  accountLogin: string;
  accountType?: string | null;
  accountId?: number | null;
  plan?: string | null;
  status: string;
}): GithubInstallationRow {
  const now = new Date().toISOString();
  const existing = getGithubInstallation(input.id);
  if (existing) {
    getDb()
      .prepare(
        `UPDATE github_installations
         SET account_login = ?, account_type = ?, account_id = ?, plan = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.accountLogin,
        input.accountType ?? existing.accountType,
        input.accountId ?? existing.accountId,
        input.plan ?? existing.plan,
        input.status,
        now,
        input.id,
      );
    return getGithubInstallation(input.id)!;
  }
  getDb()
    .prepare(
      `INSERT INTO github_installations
       (id, account_login, account_type, account_id, plan, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.accountLogin,
      input.accountType ?? null,
      input.accountId ?? null,
      input.plan ?? null,
      input.status,
      now,
      now,
    );
  return getGithubInstallation(input.id)!;
}

export function listGithubInstallations(): GithubInstallationRow[] {
  return getDb()
    .prepare('SELECT * FROM github_installations ORDER BY created_at ASC')
    .all()
    .map((r) => mapGithubInstallation(r as Record<string, unknown>));
}

/**
 * Find (or create) the tenant organization that owns a GitHub installation's
 * repositories — one org per installation account, so App repos stay isolated
 * per customer.
 */
export function ensureOrganizationForInstallation(input: {
  accountLogin: string;
  installationId?: number | null;
}): OrgRow {
  const slug = input.accountLogin.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) || 'default';
  const existing = listOrganizations().find((o) => o.slug === slug);
  if (existing) return existing;
  return createOrganization({ name: input.accountLogin, slug });
}

export function listRepositories(organizationId?: string | null): RepoRow[] {
  const db = getDb();
  if (organizationId) {
    return db
      .prepare('SELECT * FROM repositories WHERE organization_id = ? ORDER BY created_at DESC')
      .all(organizationId)
      .map((r) => mapRepo(r as Record<string, unknown>));
  }
  return db
    .prepare('SELECT * FROM repositories ORDER BY created_at DESC')
    .all()
    .map((r) => mapRepo(r as Record<string, unknown>));
}

export function createRepository(input: {
  provider: 'github' | 'gitlab' | 'local';
  owner: string;
  name: string;
  defaultBranch?: string;
  language?: string;
  localPath?: string;
  configPath?: string;
  organizationId?: string | null;
}): RepoRow {
  const now = new Date().toISOString();
  const row: RepoRow = {
    id: createId('repo'),
    organizationId: input.organizationId ?? null,
    provider: input.provider,
    owner: input.owner,
    name: input.name,
    defaultBranch: input.defaultBranch ?? 'main',
    language: input.language ?? null,
    configPath: input.configPath ?? 'proofloop.yml',
    localPath: input.localPath ?? null,
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      `INSERT INTO repositories
      (id, organization_id, provider, owner, name, default_branch, language, config_path, local_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.organizationId,
      row.provider,
      row.owner,
      row.name,
      row.defaultBranch,
      row.language,
      row.configPath,
      row.localPath,
      row.createdAt,
      row.updatedAt,
    );
  return row;
}

export function updateRepositoryLocalPath(id: string, localPath: string) {
  getDb()
    .prepare(`UPDATE repositories SET local_path = ?, updated_at = ? WHERE id = ?`)
    .run(localPath, new Date().toISOString(), id);
}

export function getRepository(id: string): RepoRow | undefined {
  const row = getDb().prepare('SELECT * FROM repositories WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapRepo(row) : undefined;
}

export function listRuns(repositoryId: string): RunRow[] {
  return getDb()
    .prepare('SELECT * FROM change_runs WHERE repository_id = ? ORDER BY started_at DESC')
    .all(repositoryId)
    .map((r) => mapRun(r as Record<string, unknown>));
}

export function getRun(id: string): RunRow | undefined {
  const row = getDb().prepare('SELECT * FROM change_runs WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapRun(row) : undefined;
}

/** Find an in-flight run for the same repo + head SHA (webhook idempotency). */
export function findActiveRunForHead(
  repositoryId: string,
  headSha: string,
): RunRow | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM change_runs
       WHERE repository_id = ? AND head_sha = ?
         AND status IN ('queued', 'analyzing', 'verifying')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(repositoryId, headSha) as Record<string, unknown> | undefined;
  return row ? mapRun(row) : undefined;
}

/** Look up the durable head→run claim (survives completion for webhook retries). */
export function findClaimedRunForHead(
  repositoryId: string,
  headSha: string,
): RunRow | undefined {
  const claim = getDb()
    .prepare(
      `SELECT run_id FROM head_run_claims WHERE repository_id = ? AND head_sha = ?`,
    )
    .get(repositoryId, headSha) as { run_id?: string } | undefined;
  if (!claim?.run_id) return undefined;
  return getRun(String(claim.run_id));
}

/**
 * Atomically claim (repositoryId, headSha) → runId.
 * Returns existing claimed/active run when the head was already processed.
 */
export function claimOrGetHeadRun(input: {
  id: string;
  repositoryId: string;
  baseSha: string;
  headSha: string;
  source: string;
  prNumber?: number | null;
}): { run: RunRow; created: boolean } {
  return withTransaction(() => {
    const existing =
      findClaimedRunForHead(input.repositoryId, input.headSha) ??
      findActiveRunForHead(input.repositoryId, input.headSha);
    if (existing) return { run: existing, created: false };

    const startedAt = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO head_run_claims (repository_id, head_sha, run_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.repositoryId, input.headSha, input.id, startedAt);

    getDb()
      .prepare(
        `INSERT INTO change_runs
        (id, repository_id, base_sha, head_sha, source, status, risk_level, overall_status,
         started_at, finished_at, total_duration_ms, error_code, evidence_path, pr_number, check_run_id, comment_id, phase)
        VALUES (?, ?, ?, ?, ?, 'queued', 'low', null, ?, null, null, null, null, ?, null, null, 'queued')`,
      )
      .run(
        input.id,
        input.repositoryId,
        input.baseSha,
        input.headSha,
        input.source,
        startedAt,
        input.prNumber ?? null,
      );
    getDb()
      .prepare(
        `INSERT INTO metric_events (id, repository_id, run_id, event_type, metadata_json, created_at)
         VALUES (?, ?, ?, 'check_started', ?, ?)`,
      )
      .run(
        createId('metric'),
        input.repositoryId,
        input.id,
        JSON.stringify({ headSha: input.headSha, claimed: true }),
        startedAt,
      );
    return { run: getRun(input.id)!, created: true };
  });
}

export function persistPack(input: {
  repositoryId: string;
  source: string;
  pack: EvidencePack;
  evidencePath: string;
  prNumber?: number;
}): RunRow | undefined {
  const db = getDb();
  const runId = input.pack.run.id;
  db.prepare(
    `INSERT INTO change_runs
    (id, repository_id, base_sha, head_sha, source, status, risk_level, overall_status,
     started_at, finished_at, total_duration_ms, error_code, evidence_path, pr_number, check_run_id, comment_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    input.repositoryId,
    input.pack.run.baseSha,
    input.pack.run.headSha,
    input.source,
    'completed',
    input.pack.run.riskLevel,
    input.pack.run.overallStatus,
    input.pack.run.startedAt ?? null,
    input.pack.run.finishedAt ?? null,
    input.pack.run.totalDurationMs ?? null,
    null,
    input.evidencePath,
    input.prNumber ?? null,
    null,
    null,
  );

  db.prepare(
    `INSERT INTO change_intents
    (id, run_id, summary, source_text, confidence, assumptions_json, generated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    createId('intent'),
    runId,
    input.pack.intent.summary,
    input.pack.intent.sourceRefs.join('\n'),
    String(input.pack.intent.confidence ?? 'low'),
    JSON.stringify(input.pack.intent.assumptions),
    new Date().toISOString(),
  );

  const insertClaim = db.prepare(
    `INSERT INTO claims
    (id, run_id, title, description, category, source, status, confidence, risk_weight,
     related_files_json, related_symbols_json, evidence_refs_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of input.pack.claims) {
    insertClaim.run(
      c.id,
      runId,
      c.title,
      c.description ?? '',
      c.category ?? 'functional',
      c.source,
      c.status,
      c.confidence ?? 'low',
      c.riskWeight ?? 0,
      JSON.stringify(c.relatedFiles),
      JSON.stringify(c.relatedSymbols ?? []),
      JSON.stringify(c.evidenceRefs),
    );
  }

  const insertVerification = db.prepare(
    `INSERT INTO verifications
    (id, claim_id, run_id, type, command, safe_command, status, exit_code, started_at, finished_at,
     duration_ms, environment_fingerprint, log_artifact_id, result_summary, related_claim_ids_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const v of input.pack.verifications as Array<Record<string, unknown>>) {
    insertVerification.run(
      String(v.id),
      (v.claimId as string | null) ?? null,
      runId,
      String(v.type),
      String(v.command),
      v.safeCommand ? 1 : 0,
      String(v.status),
      (v.exitCode as number | null) ?? null,
      (v.startedAt as string | null) ?? null,
      (v.finishedAt as string | null) ?? null,
      (v.durationMs as number | null) ?? null,
      (v.environmentFingerprint as string | null) ?? null,
      (v.logArtifactId as string | null) ?? null,
      String(v.resultSummary ?? ''),
      JSON.stringify(v.relatedClaimIds ?? []),
    );
  }

  const insertNode = db.prepare(
    `INSERT INTO impact_nodes
    (id, run_id, node_type, label, path, relation, risk_level, source, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const n of (input.pack.impactGraph.nodes ?? []) as Array<Record<string, unknown>>) {
    insertNode.run(
      String(n.id),
      runId,
      String(n.nodeType),
      String(n.label),
      (n.path as string | null) ?? null,
      String(n.relation),
      String(n.riskLevel),
      (n.source as string | null) ?? null,
      (n.confidence as string | null) ?? null,
    );
  }
  insertImpactEdges(runId, input.pack);

  db.prepare(
    `INSERT INTO metric_events (id, repository_id, run_id, event_type, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    createId('metric'),
    input.repositoryId,
    runId,
    'check_finished',
    JSON.stringify({
      overallStatus: input.pack.run.overallStatus,
      headSha: input.pack.run.headSha,
    }),
    new Date().toISOString(),
  );

  return getRun(runId);
}

export function listClaims(runId: string) {
  return getDb()
    .prepare('SELECT * FROM claims WHERE run_id = ?')
    .all(runId)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        runId: String(r.run_id),
        title: String(r.title),
        description: String(r.description),
        category: String(r.category),
        source: String(r.source),
        status: String(r.status),
        confidence: String(r.confidence),
        riskWeight: Number(r.risk_weight),
        relatedFilesJson: String(r.related_files_json),
        relatedSymbolsJson: String(r.related_symbols_json),
        evidenceRefsJson: String(r.evidence_refs_json),
      };
    });
}

export function listVerifications(runId: string) {
  return getDb()
    .prepare('SELECT * FROM verifications WHERE run_id = ?')
    .all(runId)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        claimId: (r.claim_id as string | null) ?? null,
        runId: String(r.run_id),
        type: String(r.type),
        command: String(r.command),
        safeCommand: Boolean(r.safe_command),
        status: String(r.status),
        exitCode: (r.exit_code as number | null) ?? null,
        startedAt: (r.started_at as string | null) ?? null,
        finishedAt: (r.finished_at as string | null) ?? null,
        durationMs: (r.duration_ms as number | null) ?? null,
        environmentFingerprint: (r.environment_fingerprint as string | null) ?? null,
        logArtifactId: (r.log_artifact_id as string | null) ?? null,
        resultSummary: String(r.result_summary),
        relatedClaimIdsJson: String(r.related_claim_ids_json),
      };
    });
}

export function listImpact(runId: string) {
  return getDb()
    .prepare('SELECT * FROM impact_nodes WHERE run_id = ?')
    .all(runId)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        runId: String(r.run_id),
        nodeType: String(r.node_type),
        label: String(r.label),
        path: (r.path as string | null) ?? null,
        relation: String(r.relation),
        riskLevel: String(r.risk_level),
        source: (r.source as string | null) ?? null,
        confidence: (r.confidence as string | null) ?? null,
      };
    });
}

export function listRules(repositoryId: string) {
  return getDb()
    .prepare('SELECT * FROM rules WHERE repository_id = ?')
    .all(repositoryId)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        repositoryId: String(r.repository_id),
        key: String(r.key),
        description: String(r.description),
        ruleType: String(r.rule_type),
        configJson: String(r.config_json),
        enabled: Boolean(r.enabled),
      };
    });
}

export function putRules(
  repositoryId: string,
  rules: Array<{
    key: string;
    description: string;
    ruleType: string;
    config: Record<string, unknown>;
    enabled: boolean;
  }>,
) {
  return withTransaction(() => {
    const db = getDb();
    db.prepare('DELETE FROM rules WHERE repository_id = ?').run(repositoryId);
    const insert = db.prepare(
      `INSERT INTO rules (id, repository_id, key, description, rule_type, config_json, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const rows = rules.map((r) => ({
      id: createId('rule'),
      repositoryId,
      key: r.key,
      description: r.description,
      ruleType: r.ruleType,
      configJson: JSON.stringify(r.config),
      enabled: r.enabled,
    }));
    for (const row of rows) {
      insert.run(
        row.id,
        row.repositoryId,
        row.key,
        row.description,
        row.ruleType,
        row.configJson,
        row.enabled ? 1 : 0,
      );
    }
    return rows;
  });
}

export function updateRunGithubMeta(
  runId: string,
  meta: { checkRunId?: number; commentId?: number },
) {
  const run = getRun(runId);
  if (!run) return;
  getDb()
    .prepare('UPDATE change_runs SET check_run_id = ?, comment_id = ? WHERE id = ?')
    .run(meta.checkRunId ?? run.checkRunId, meta.commentId ?? run.commentId, runId);
}

export function updateRunOverall(runId: string, overallStatus: string, riskLevel?: string) {
  const run = getRun(runId);
  if (!run) return;
  getDb()
    .prepare('UPDATE change_runs SET overall_status = ?, risk_level = ? WHERE id = ?')
    .run(overallStatus, riskLevel ?? run.riskLevel, runId);
}

export function createQueuedRun(input: {
  id: string;
  repositoryId: string;
  baseSha: string;
  headSha: string;
  source: string;
  prNumber?: number | null;
}): RunRow {
  const startedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO change_runs
      (id, repository_id, base_sha, head_sha, source, status, risk_level, overall_status,
       started_at, finished_at, total_duration_ms, error_code, evidence_path, pr_number, check_run_id, comment_id, phase)
      VALUES (?, ?, ?, ?, ?, 'queued', 'low', null, ?, null, null, null, null, ?, null, null, 'queued')`,
    )
    .run(
      input.id,
      input.repositoryId,
      input.baseSha,
      input.headSha,
      input.source,
      startedAt,
      input.prNumber ?? null,
    );
  getDb()
    .prepare(
      `INSERT INTO metric_events (id, repository_id, run_id, event_type, metadata_json, created_at)
       VALUES (?, ?, ?, 'check_started', ?, ?)`,
    )
    .run(
      createId('metric'),
      input.repositoryId,
      input.id,
      JSON.stringify({ headSha: input.headSha }),
      startedAt,
    );
  return getRun(input.id)!;
}

export function updateRunProgress(
  runId: string,
  patch: {
    status?: string;
    phase?: string | null;
    overallStatus?: string | null;
    riskLevel?: string;
    finishedAt?: string | null;
    totalDurationMs?: number | null;
    errorCode?: string | null;
    evidencePath?: string | null;
    cancelRequested?: boolean;
  },
) {
  const run = getRun(runId);
  if (!run) return;
  getDb()
    .prepare(
      `UPDATE change_runs SET
        status = ?,
        phase = ?,
        overall_status = ?,
        risk_level = ?,
        finished_at = ?,
        total_duration_ms = ?,
        error_code = ?,
        evidence_path = ?,
        cancel_requested = ?
      WHERE id = ?`,
    )
    .run(
      patch.status ?? run.status,
      patch.phase === undefined ? run.phase : patch.phase,
      patch.overallStatus === undefined ? run.overallStatus : patch.overallStatus,
      patch.riskLevel ?? run.riskLevel,
      patch.finishedAt === undefined ? run.finishedAt : patch.finishedAt,
      patch.totalDurationMs === undefined ? run.totalDurationMs : patch.totalDurationMs,
      patch.errorCode === undefined ? run.errorCode : patch.errorCode,
      patch.evidencePath === undefined ? run.evidencePath : patch.evidencePath,
      (patch.cancelRequested ?? run.cancelRequested) ? 1 : 0,
      runId,
    );
}

export function requestRunCancel(runId: string): boolean {
  const run = getRun(runId);
  if (!run) return false;
  if (['completed', 'failed', 'cancelled'].includes(run.status)) return false;
  updateRunProgress(runId, {
    cancelRequested: true,
    status: 'cancelled',
    phase: 'cancelled',
    finishedAt: new Date().toISOString(),
    errorCode: 'cancelled',
  });
  return true;
}

export function isCancelRequested(runId: string): boolean {
  return Boolean(getRun(runId)?.cancelRequested);
}

/** After process restart, in-flight runs cannot continue — mark them interrupted.
 * Skip when REDIS_URL is set: another worker/API replica may still own those jobs.
 */
export function markInterruptedRuns(): number {
  if (process.env.REDIS_URL?.trim()) return 0;
  const rows = getDb()
    .prepare(
      `SELECT id FROM change_runs WHERE status IN ('queued','analyzing','verifying')`,
    )
    .all() as Array<{ id: string }>;
  for (const row of rows) {
    updateRunProgress(row.id, {
      status: 'failed',
      phase: 'interrupted',
      finishedAt: new Date().toISOString(),
      errorCode: 'interrupted_restart',
      cancelRequested: true,
    });
  }
  return rows.length;
}

export function listImpactEdges(runId: string) {
  return getDb()
    .prepare('SELECT * FROM impact_edges WHERE run_id = ?')
    .all(runId)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        runId: String(r.run_id),
        fromNodeId: String(r.from_node_id),
        toNodeId: String(r.to_node_id),
        relation: String(r.relation),
      };
    });
}

export function listMetricEvents(repositoryId: string, limit = 50) {
  return getDb()
    .prepare(
      `SELECT * FROM metric_events WHERE repository_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(repositoryId, limit)
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        repositoryId: String(r.repository_id),
        runId: (r.run_id as string | null) ?? null,
        eventType: String(r.event_type),
        metadata: JSON.parse(String(r.metadata_json || '{}')) as Record<string, unknown>,
        createdAt: String(r.created_at),
      };
    });
}

export function deleteRunChildren(runId: string) {
  const db = getDb();
  db.prepare('DELETE FROM claims WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM verifications WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM impact_nodes WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM impact_edges WHERE run_id = ?').run(runId);
  db.prepare('DELETE FROM change_intents WHERE run_id = ?').run(runId);
}

function insertImpactEdges(runId: string, pack: EvidencePack) {
  const edges = (pack.impactGraph.edges ?? []) as Array<Record<string, unknown>>;
  if (!edges.length) return;
  const insert = getDb().prepare(
    `INSERT INTO impact_edges (id, run_id, from_node_id, to_node_id, relation)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const e of edges) {
    insert.run(
      String(e.id ?? createId('edge')),
      runId,
      String(e.fromNodeId),
      String(e.toNodeId),
      String(e.relation),
    );
  }
}

/** Attach a finished Evidence Pack onto an existing queued run row. */
export function finalizeQueuedPack(input: {
  runId: string;
  repositoryId: string;
  pack: EvidencePack;
  evidencePath: string;
}): RunRow | undefined {
  // Cancel wins: never resurrect a cancelled run as completed.
  if (isCancelRequested(input.runId)) {
    updateRunProgress(input.runId, {
      status: 'cancelled',
      phase: 'cancelled',
      finishedAt: new Date().toISOString(),
      errorCode: 'cancelled',
      cancelRequested: true,
    });
    return getRun(input.runId);
  }
  const existing = getRun(input.runId);
  if (existing && ['cancelled', 'failed'].includes(existing.status) && existing.cancelRequested) {
    return existing;
  }

  return withTransaction(() => {
    // Re-check cancel inside the transaction.
    if (isCancelRequested(input.runId)) {
      updateRunProgress(input.runId, {
        status: 'cancelled',
        phase: 'cancelled',
        finishedAt: new Date().toISOString(),
        errorCode: 'cancelled',
        cancelRequested: true,
      });
      return getRun(input.runId);
    }

    deleteRunChildren(input.runId);
    const db = getDb();
    const pack = input.pack;
    updateRunProgress(input.runId, {
      status: 'completed',
      phase: 'completed',
      overallStatus: pack.run.overallStatus,
      riskLevel: pack.run.riskLevel,
      finishedAt: pack.run.finishedAt ?? new Date().toISOString(),
      totalDurationMs: pack.run.totalDurationMs ?? null,
      evidencePath: input.evidencePath,
      errorCode: null,
    });

    db.prepare(
      `INSERT INTO change_intents
      (id, run_id, summary, source_text, confidence, assumptions_json, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      createId('intent'),
      input.runId,
      pack.intent.summary,
      pack.intent.sourceRefs.join('\n'),
      String(pack.intent.confidence ?? 'low'),
      JSON.stringify(pack.intent.assumptions),
      new Date().toISOString(),
    );

    const insertClaim = db.prepare(
      `INSERT INTO claims
      (id, run_id, title, description, category, source, status, confidence, risk_weight,
       related_files_json, related_symbols_json, evidence_refs_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of pack.claims) {
      insertClaim.run(
        c.id,
        input.runId,
        c.title,
        c.description ?? '',
        c.category ?? 'functional',
        c.source,
        c.status,
        c.confidence ?? 'low',
        c.riskWeight ?? 0,
        JSON.stringify(c.relatedFiles),
        JSON.stringify(c.relatedSymbols ?? []),
        JSON.stringify(c.evidenceRefs),
      );
    }

    const insertVerification = db.prepare(
      `INSERT INTO verifications
      (id, claim_id, run_id, type, command, safe_command, status, exit_code, started_at, finished_at,
       duration_ms, environment_fingerprint, log_artifact_id, result_summary, related_claim_ids_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const v of pack.verifications as Array<Record<string, unknown>>) {
      insertVerification.run(
        String(v.id),
        (v.claimId as string | null) ?? null,
        input.runId,
        String(v.type),
        String(v.command),
        v.safeCommand ? 1 : 0,
        String(v.status),
        (v.exitCode as number | null) ?? null,
        (v.startedAt as string | null) ?? null,
        (v.finishedAt as string | null) ?? null,
        (v.durationMs as number | null) ?? null,
        (v.environmentFingerprint as string | null) ?? null,
        (v.logArtifactId as string | null) ?? null,
        String(v.resultSummary ?? ''),
        JSON.stringify(v.relatedClaimIds ?? []),
      );
    }

    const insertNode = db.prepare(
      `INSERT INTO impact_nodes
      (id, run_id, node_type, label, path, relation, risk_level, source, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const n of (pack.impactGraph.nodes ?? []) as Array<Record<string, unknown>>) {
      insertNode.run(
        String(n.id),
        input.runId,
        String(n.nodeType),
        String(n.label),
        (n.path as string | null) ?? null,
        String(n.relation),
        String(n.riskLevel),
        (n.source as string | null) ?? null,
        (n.confidence as string | null) ?? null,
      );
    }
    insertImpactEdges(input.runId, pack);

    db.prepare(
      `INSERT INTO metric_events (id, repository_id, run_id, event_type, metadata_json, created_at)
       VALUES (?, ?, ?, 'check_finished', ?, ?)`,
    ).run(
      createId('metric'),
      input.repositoryId,
      input.runId,
      JSON.stringify({
        overallStatus: pack.run.overallStatus,
        headSha: pack.run.headSha,
        allowMerge: pack.mergeGate?.allowMerge ?? false,
      }),
      new Date().toISOString(),
    );

    return getRun(input.runId);
  });
}

export function upsertClaimStatus(
  claimId: string,
  status: string,
  evidenceRefs: string[],
) {
  getDb()
    .prepare('UPDATE claims SET status = ?, evidence_refs_json = ? WHERE id = ?')
    .run(status, JSON.stringify(evidenceRefs), claimId);
}

export function insertVerification(v: {
  id: string;
  claimId: string | null;
  runId: string;
  type: string;
  command: string;
  safeCommand: boolean;
  status: string;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  environmentFingerprint: string | null;
  logArtifactId: string | null;
  resultSummary: string;
  relatedClaimIds: string[];
}) {
  getDb()
    .prepare(
      `INSERT INTO verifications
      (id, claim_id, run_id, type, command, safe_command, status, exit_code, started_at, finished_at,
       duration_ms, environment_fingerprint, log_artifact_id, result_summary, related_claim_ids_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      v.id,
      v.claimId,
      v.runId,
      v.type,
      v.command,
      v.safeCommand ? 1 : 0,
      v.status,
      v.exitCode,
      v.startedAt,
      v.finishedAt,
      v.durationMs,
      v.environmentFingerprint,
      v.logArtifactId,
      v.resultSummary,
      JSON.stringify(v.relatedClaimIds),
    );
}
