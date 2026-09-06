import { getDb, getSqlitePath } from './client.js';

interface TableDef {
  name: string;
  create: string;
  /** FKs this table must declare (checked via PRAGMA foreign_key_list). */
  expectedFks: Array<{ table: string; from: string }>;
  /** Column order used when copying rows during a legacy rebuild. */
  columns: string[];
}

/**
 * Single source of truth for the schema. Fresh databases are created with
 * foreign keys; legacy databases (pre-FK) are detected via PRAGMA
 * foreign_key_list and rebuilt in place with the standard SQLite procedure.
 */
const TABLES: TableDef[] = [
  {
    name: 'organizations',
    create: `CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
    expectedFks: [],
    columns: ['id', 'name', 'slug', 'created_at', 'updated_at'],
  },
  {
    name: 'github_installations',
    create: `CREATE TABLE IF NOT EXISTS github_installations (
    id INTEGER PRIMARY KEY,
    account_login TEXT NOT NULL,
    account_type TEXT,
    account_id INTEGER,
    plan TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
    expectedFks: [],
    columns: [
      'id',
      'account_login',
      'account_type',
      'account_id',
      'plan',
      'status',
      'created_at',
      'updated_at',
    ],
  },
  {
    name: 'repositories',
    create: `CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
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
    expectedFks: [{ table: 'organizations', from: 'organization_id' }],
    columns: [
      'id',
      'organization_id',
      'provider',
      'owner',
      'name',
      'default_branch',
      'language',
      'config_path',
      'local_path',
      'created_at',
      'updated_at',
    ],
  },
  {
    name: 'change_runs',
    create: `CREATE TABLE IF NOT EXISTS change_runs (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
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
    comment_id INTEGER,
    phase TEXT,
    cancel_requested INTEGER DEFAULT 0
  )`,
    expectedFks: [{ table: 'repositories', from: 'repository_id' }],
    columns: [
      'id',
      'repository_id',
      'base_sha',
      'head_sha',
      'source',
      'status',
      'risk_level',
      'overall_status',
      'started_at',
      'finished_at',
      'total_duration_ms',
      'error_code',
      'evidence_path',
      'pr_number',
      'check_run_id',
      'comment_id',
      'phase',
      'cancel_requested',
    ],
  },
  {
    name: 'change_intents',
    create: `CREATE TABLE IF NOT EXISTS change_intents (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES change_runs(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    source_text TEXT NOT NULL,
    confidence TEXT NOT NULL,
    assumptions_json TEXT NOT NULL,
    generated_at TEXT NOT NULL
  )`,
    expectedFks: [{ table: 'change_runs', from: 'run_id' }],
    columns: ['id', 'run_id', 'summary', 'source_text', 'confidence', 'assumptions_json', 'generated_at'],
  },
  {
    name: 'claims',
    create: `CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES change_runs(id) ON DELETE CASCADE,
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
    expectedFks: [{ table: 'change_runs', from: 'run_id' }],
    columns: [
      'id',
      'run_id',
      'title',
      'description',
      'category',
      'source',
      'status',
      'confidence',
      'risk_weight',
      'related_files_json',
      'related_symbols_json',
      'evidence_refs_json',
    ],
  },
  {
    name: 'verifications',
    create: `CREATE TABLE IF NOT EXISTS verifications (
    id TEXT PRIMARY KEY,
    claim_id TEXT REFERENCES claims(id) ON DELETE SET NULL,
    run_id TEXT NOT NULL REFERENCES change_runs(id) ON DELETE CASCADE,
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
    expectedFks: [
      { table: 'change_runs', from: 'run_id' },
      { table: 'claims', from: 'claim_id' },
    ],
    columns: [
      'id',
      'claim_id',
      'run_id',
      'type',
      'command',
      'safe_command',
      'status',
      'exit_code',
      'started_at',
      'finished_at',
      'duration_ms',
      'environment_fingerprint',
      'log_artifact_id',
      'result_summary',
      'related_claim_ids_json',
    ],
  },
  {
    name: 'risk_findings',
    create: `CREATE TABLE IF NOT EXISTS risk_findings (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES change_runs(id) ON DELETE CASCADE,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL,
    remediation TEXT NOT NULL,
    blocking INTEGER NOT NULL,
    source TEXT NOT NULL
  )`,
    expectedFks: [{ table: 'change_runs', from: 'run_id' }],
    columns: [
      'id',
      'run_id',
      'severity',
      'title',
      'description',
      'evidence_refs_json',
      'remediation',
      'blocking',
      'source',
    ],
  },
  {
    name: 'impact_nodes',
    create: `CREATE TABLE IF NOT EXISTS impact_nodes (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES change_runs(id) ON DELETE CASCADE,
    node_type TEXT NOT NULL,
    label TEXT NOT NULL,
    path TEXT,
    relation TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    source TEXT,
    confidence TEXT
  )`,
    expectedFks: [{ table: 'change_runs', from: 'run_id' }],
    columns: [
      'id',
      'run_id',
      'node_type',
      'label',
      'path',
      'relation',
      'risk_level',
      'source',
      'confidence',
    ],
  },
  {
    name: 'rules',
    create: `CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    description TEXT NOT NULL,
    rule_type TEXT NOT NULL,
    config_json TEXT NOT NULL,
    enabled INTEGER NOT NULL
  )`,
    expectedFks: [{ table: 'repositories', from: 'repository_id' }],
    columns: ['id', 'repository_id', 'key', 'description', 'rule_type', 'config_json', 'enabled'],
  },
  {
    name: 'artifacts',
    create: `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES change_runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    redacted INTEGER NOT NULL
  )`,
    expectedFks: [{ table: 'change_runs', from: 'run_id' }],
    columns: ['id', 'run_id', 'kind', 'storage_path', 'sha256', 'size_bytes', 'redacted'],
  },
  {
    name: 'metric_events',
    create: `CREATE TABLE IF NOT EXISTS metric_events (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES change_runs(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
    expectedFks: [
      { table: 'repositories', from: 'repository_id' },
      { table: 'change_runs', from: 'run_id' },
    ],
    columns: ['id', 'repository_id', 'run_id', 'event_type', 'metadata_json', 'created_at'],
  },
  {
    name: 'impact_edges',
    create: `CREATE TABLE IF NOT EXISTS impact_edges (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES change_runs(id) ON DELETE CASCADE,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    relation TEXT NOT NULL
  )`,
    expectedFks: [{ table: 'change_runs', from: 'run_id' }],
    columns: ['id', 'run_id', 'from_node_id', 'to_node_id', 'relation'],
  },
  {
    name: 'head_run_claims',
    create: `CREATE TABLE IF NOT EXISTS head_run_claims (
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    head_sha TEXT NOT NULL,
    run_id TEXT NOT NULL UNIQUE REFERENCES change_runs(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (repository_id, head_sha)
  )`,
    expectedFks: [
      { table: 'repositories', from: 'repository_id' },
      { table: 'change_runs', from: 'run_id' },
    ],
    columns: ['repository_id', 'head_sha', 'run_id', 'created_at'],
  },
];

const INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_uq ON organizations(slug)`,
  `CREATE INDEX IF NOT EXISTS change_runs_repo_idx ON change_runs(repository_id)`,
  `CREATE INDEX IF NOT EXISTS change_runs_head_idx ON change_runs(repository_id, head_sha)`,
  `CREATE INDEX IF NOT EXISTS change_intents_run_idx ON change_intents(run_id)`,
  `CREATE INDEX IF NOT EXISTS claims_run_idx ON claims(run_id)`,
  `CREATE INDEX IF NOT EXISTS verifications_run_idx ON verifications(run_id)`,
  `CREATE INDEX IF NOT EXISTS verifications_claim_idx ON verifications(claim_id)`,
  `CREATE INDEX IF NOT EXISTS risk_findings_run_idx ON risk_findings(run_id)`,
  `CREATE INDEX IF NOT EXISTS impact_nodes_run_idx ON impact_nodes(run_id)`,
  `CREATE INDEX IF NOT EXISTS impact_edges_run_idx ON impact_edges(run_id)`,
  `CREATE INDEX IF NOT EXISTS rules_repo_idx ON rules(repository_id)`,
  `CREATE INDEX IF NOT EXISTS metric_events_repo_idx ON metric_events(repository_id)`,
  `CREATE INDEX IF NOT EXISTS metric_events_run_idx ON metric_events(run_id)`,
];

/**
 * Rebuild a legacy table that lacks foreign keys: create the FK-bearing
 * definition under a temp name, copy rows column-wise, drop the old table,
 * rename. FK enforcement is suspended for the duration.
 */
function rebuildTableWithForeignKeys(db: ReturnType<typeof getDb>, t: TableDef): void {
  const cols = t.columns.join(', ');
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`DROP TABLE IF EXISTS ${t.name}__fk_rebuild`);
    // Strip the "IF NOT EXISTS" clause so the temp create is unconditional.
    const createBody = t.create.replace(/^CREATE TABLE IF NOT EXISTS /i, 'CREATE TABLE ');
    db.exec(createBody.replace(`TABLE ${t.name}`, `TABLE ${t.name}__fk_rebuild`));
    db.exec(`INSERT INTO ${t.name}__fk_rebuild (${cols}) SELECT ${cols} FROM ${t.name}`);
    db.exec(`DROP TABLE ${t.name}`);
    db.exec(`ALTER TABLE ${t.name}__fk_rebuild RENAME TO ${t.name}`);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* no txn */
    }
    try {
      db.exec(`DROP TABLE IF EXISTS ${t.name}__fk_rebuild`);
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function foreignKeysOf(
  db: ReturnType<typeof getDb>,
  table: string,
): Array<{ table: string; from: string }> {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({ table: String(r['table']), from: String(r['from']) }));
}

export function migrate(databaseUrl = process.env.DATABASE_URL ?? 'file:./.data/proofloop.db') {
  const db = getDb(databaseUrl);
  for (const t of TABLES) db.exec(t.create);
  for (const sql of INDEXES) db.exec(sql);
  // Additive columns for very old databases (safe when the column exists).
  for (const sql of [
    `ALTER TABLE change_runs ADD COLUMN phase TEXT`,
    `ALTER TABLE change_runs ADD COLUMN cancel_requested INTEGER DEFAULT 0`,
    `ALTER TABLE repositories ADD COLUMN organization_id TEXT`,
  ]) {
    try {
      db.exec(sql);
    } catch {
      // already exists
    }
  }
  // Legacy databases were created without FKs; rebuild any table that is
  // missing an expected reference so integrity holds everywhere.
  for (const t of TABLES) {
    if (t.expectedFks.length === 0) continue;
    const existing = foreignKeysOf(db, t.name);
    const missing = t.expectedFks.filter(
      (e) => !existing.some((f) => f.table === e.table && f.from === e.from),
    );
    if (missing.length > 0) {
      rebuildTableWithForeignKeys(db, t);
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
