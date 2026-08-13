/**
 * Drizzle-compatible schema declarations for PostgreSQL production mapping.
 * Runtime SQLite access uses node:sqlite in client.ts / store.ts with identical columns.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const githubInstallations = sqliteTable('github_installations', {
  id: integer('id').primaryKey(),
  accountLogin: text('account_login').notNull(),
  accountType: text('account_type'),
  accountId: integer('account_id'),
  plan: text('plan'),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id'),
  provider: text('provider').notNull(),
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  defaultBranch: text('default_branch').notNull(),
  language: text('language'),
  configPath: text('config_path'),
  localPath: text('local_path'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const changeRuns = sqliteTable('change_runs', {
  id: text('id').primaryKey(),
  repositoryId: text('repository_id').notNull(),
  baseSha: text('base_sha').notNull(),
  headSha: text('head_sha').notNull(),
  source: text('source').notNull(),
  status: text('status').notNull(),
  riskLevel: text('risk_level').notNull(),
  overallStatus: text('overall_status'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  totalDurationMs: integer('total_duration_ms'),
  errorCode: text('error_code'),
  evidencePath: text('evidence_path'),
  prNumber: integer('pr_number'),
  checkRunId: integer('check_run_id'),
  commentId: integer('comment_id'),
});
