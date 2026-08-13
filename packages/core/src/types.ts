import { z } from 'zod';

export const ProviderSchema = z.enum(['github', 'gitlab', 'local']);
export type Provider = z.infer<typeof ProviderSchema>;

export const RunSourceSchema = z.enum(['cli', 'github_pr', 'gitlab_mr', 'api']);
export type RunSource = z.infer<typeof RunSourceSchema>;

export const RunStatusSchema = z.enum([
  'queued',
  'analyzing',
  'verifying',
  'completed',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const ClaimCategorySchema = z.enum([
  'functional',
  'compatibility',
  'security',
  'performance',
  'architecture',
  'data',
  'ux',
]);
export type ClaimCategory = z.infer<typeof ClaimCategorySchema>;

export const ClaimSourceSchema = z.enum(['pr_description', 'issue', 'diff_inference', 'rule']);
export type ClaimSource = z.infer<typeof ClaimSourceSchema>;

export const ClaimStatusSchema = z.enum(['verified', 'passed', 'inferred', 'unknown', 'blocked']);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const VerificationTypeSchema = z.enum([
  'lint',
  'typecheck',
  'unit_test',
  'integration_test',
  'build',
  'security_scan',
  'custom',
  'manual',
]);
export type VerificationType = z.infer<typeof VerificationTypeSchema>;

export const VerificationStatusSchema = z.enum([
  'passed',
  'failed',
  'skipped',
  'timed_out',
  'blocked',
]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const FindingSeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingSourceSchema = z.enum(['static', 'dynamic', 'llm', 'policy']);
export type FindingSource = z.infer<typeof FindingSourceSchema>;

export const ImpactNodeTypeSchema = z.enum([
  'file',
  'symbol',
  'endpoint',
  'schema',
  'permission',
  'test',
  'dependency',
]);
export type ImpactNodeType = z.infer<typeof ImpactNodeTypeSchema>;

export const ImpactRelationSchema = z.enum([
  'changed',
  'imports',
  'imported_by',
  'calls',
  'exposes',
  'validates',
  'tests',
  'schema_dependency',
]);
export type ImpactRelation = z.infer<typeof ImpactRelationSchema>;

export const RuleTypeSchema = z.enum([
  'architecture',
  'security',
  'testing',
  'compatibility',
  'command_policy',
]);
export type RuleType = z.infer<typeof RuleTypeSchema>;

export const ArtifactKindSchema = z.enum([
  'log',
  'junit',
  'coverage',
  'diff',
  'report',
  'screenshot',
  'generated_test',
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const MetricEventTypeSchema = z.enum([
  'check_started',
  'check_finished',
  'merge',
  'reopen',
  'rollback',
  'finding_accepted',
  'finding_dismissed',
]);
export type MetricEventType = z.infer<typeof MetricEventTypeSchema>;

export const OverallStatusSchema = z.enum([
  'critical_blocked',
  'high_blocked',
  'failed',
  'unknown_high_risk',
  'passed_with_warnings',
  'passed',
]);
export type OverallStatus = z.infer<typeof OverallStatusSchema>;

export const HIGH_RISK_CATEGORIES: ClaimCategory[] = ['security', 'data', 'compatibility'];

export const HIGH_RISK_PATH_PATTERNS = [
  /auth/i,
  /session/i,
  /permission/i,
  /payment/i,
  /billing/i,
  /schema/i,
  /migration/i,
  /upload/i,
  /secret/i,
  /credential/i,
  /deploy/i,
  /\.github\/workflows/i,
  /Dockerfile/i,
  /api\//i,
];

export interface Repository {
  id: string;
  provider: Provider;
  owner: string;
  name: string;
  defaultBranch: string;
  language: string | null;
  configPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChangeRun {
  id: string;
  repositoryId: string;
  baseSha: string;
  headSha: string;
  source: RunSource;
  status: RunStatus;
  riskLevel: RiskLevel;
  startedAt: string | null;
  finishedAt: string | null;
  totalDurationMs: number | null;
  errorCode: string | null;
  overallStatus?: OverallStatus | null;
}

export interface ChangeIntent {
  id: string;
  runId: string;
  summary: string;
  sourceText: string;
  confidence: Confidence;
  assumptions: string[];
  generatedAt: string;
}

export interface Claim {
  id: string;
  runId: string;
  title: string;
  description: string;
  category: ClaimCategory;
  source: ClaimSource;
  status: ClaimStatus;
  confidence: Confidence;
  riskWeight: number;
  relatedFiles: string[];
  relatedSymbols: string[];
  evidenceRefs?: string[];
}

export interface Verification {
  id: string;
  claimId: string | null;
  runId: string;
  type: VerificationType;
  command: string;
  safeCommand: boolean;
  status: VerificationStatus;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  environmentFingerprint: string | null;
  logArtifactId: string | null;
  resultSummary: string;
  relatedClaimIds?: string[];
  /** Manual reviews are bound to a head commit; mismatch → ignored for scoring. */
  boundHeadSha?: string | null;
  reviewer?: string | null;
  reviewNote?: string | null;
}

export type HumanReviewDecision = 'accept' | 'reject';
export type HumanReviewRecordStatus = 'active' | 'superseded' | 'invalidated';

/** Append-only audit of human confirmations (SHA-bound). */
export interface HumanReviewRecord {
  id: string;
  runId: string;
  claimId: string;
  headSha: string;
  decision: HumanReviewDecision;
  reviewer: string;
  note: string;
  at: string;
  verificationId: string;
  status: HumanReviewRecordStatus;
  invalidationReason?: string;
}

export interface RiskFinding {
  id: string;
  runId: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  evidenceRefs: string[];
  remediation: string;
  blocking: boolean;
  source: FindingSource;
}

export interface ImpactNode {
  id: string;
  runId: string;
  nodeType: ImpactNodeType;
  label: string;
  path: string | null;
  relation: ImpactRelation;
  riskLevel: RiskLevel;
  source?: string;
  confidence?: Confidence;
}

export interface ImpactEdge {
  id: string;
  runId: string;
  fromNodeId: string;
  toNodeId: string;
  relation: ImpactRelation;
}

export interface Rule {
  id: string;
  repositoryId: string;
  key: string;
  description: string;
  ruleType: RuleType;
  config: Record<string, unknown>;
  enabled: boolean;
}

export interface Artifact {
  id: string;
  runId: string;
  kind: ArtifactKind;
  storagePath: string;
  sha256: string;
  sizeBytes: number;
  redacted: boolean;
}

export interface MetricEvent {
  id: string;
  repositoryId: string;
  runId: string | null;
  eventType: MetricEventType;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface UnknownItem {
  id: string;
  claimId?: string;
  title: string;
  reason: string;
  suggestedVerification?: string;
  importance: string;
  riskLevel: RiskLevel;
}

export interface MergeGate {
  allowMerge: boolean;
  reason: string;
  overallStatus: OverallStatus;
  blockingFindings: string[];
}
