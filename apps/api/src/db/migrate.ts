import { getDb, getSqlitePath } from './client.js';

const statements = [
  `CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS github_installations (
    id INTEGER PRIMARY KEY,
    account_login TEXT NOT NULL,
    account_type TEXT,
    account_id INTEGER,
    plan TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    organization_id TEXT,
    provider TEXT NOT NULL,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    language TEXT,
    config_path TEXT,
    local_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS change_runs (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    overall_status TEXT,
    started_at TEXT,
    finished_at TEXT,
    total_duration_ms INTEGER,
    error_code TEXT,
    evidence_path TEXT,
    pr_number INTEGER,
    check_run_id INTEGER,
    comment_id INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS change_intents (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    source_text TEXT NOT NULL,
    confidence TEXT NOT NULL,
    assumptions_json TEXT NOT NULL,
    generated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    confidence TEXT NOT NULL,
    risk_weight INTEGER NOT NULL,
    related_files_json TEXT NOT NULL,
    related_symbols_json TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS verifications (
    id TEXT PRIMARY KEY,
    claim_id TEXT,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    command TEXT NOT NULL,
    safe_command INTEGER NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER,
    environment_fingerprint TEXT,
    log_artifact_id TEXT,
    result_summary TEXT NOT NULL,
    related_claim_ids_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS risk_findings (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL,
    remediation TEXT NOT NULL,
    blocking INTEGER NOT NULL,
    source TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS impact_nodes (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    label TEXT NOT NULL,
    path TEXT,
    relation TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    source TEXT,
    confidence TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    key TEXT NOT NULL,
    description TEXT NOT NULL,
    rule_type TEXT NOT NULL,
    config_json TEXT NOT NULL,
    enabled INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    redacted INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS metric_events (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    run_id TEXT,
    event_type TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS impact_edges (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    relation TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS head_run_claims (
    repository_id TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (repository_id, head_sha)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_uq ON organizations(slug)`,
];

export function migrate(databaseUrl = process.env.DATABASE_URL ?? 'file:./.data/proofloop.db') {
  const db = getDb(databaseUrl);
  for (const sql of statements) db.exec(sql);
  // Additive columns for async runs (safe on existing DBs).
  for (const sql of [
    `ALTER TABLE change_runs ADD COLUMN phase TEXT`,
    `ALTER TABLE change_runs ADD COLUMN cancel_requested INTEGER DEFAULT 0`,
    `ALTER TABLE repositories ADD COLUMN organization_id TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_uq ON organizations(slug)`,
    `CREATE TABLE IF NOT EXISTS head_run_claims (
      repository_id TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, head_sha)
    )`,
  ]) {
    try {
      db.exec(sql);
    } catch {
      // already exists
    }
  }
  return getSqlitePath(databaseUrl);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('migrate.ts') || process.argv[1].endsWith('migrate.js'));

if (isMain) {
  const path = migrate();
  console.log(`Migrations applied: ${path}`);
}
