const BASE = '';

function authHeaders(): Record<string, string> {
  const token =
    (import.meta as { env?: Record<string, string> }).env?.VITE_PROOFLOOP_API_TOKEN ||
    (typeof localStorage !== 'undefined' ? localStorage.getItem('PROOFLOOP_API_TOKEN') : null);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    throw new Error('Invalid JSON response');
  }
  if (!res.ok) {
    const err = json as { error?: { message?: string } } | null;
    throw new Error(err?.error?.message ?? `Request failed (${res.status})`);
  }
  return json as T;
}

export const api = {
  health: () => request<{ ok: boolean }>('/api/health'),
  organizations: () => request<{ data: Org[] }>('/api/organizations'),
  createOrganization: (body: { name: string; slug?: string }) =>
    request<{ data: Org }>('/api/organizations', { method: 'POST', body: JSON.stringify(body) }),
  organizationRepositories: (orgId: string) =>
    request<{ data: Repo[] }>(`/api/organizations/${orgId}/repositories`),
  repositories: (organizationId?: string) =>
    request<{ data: Repo[] }>(
      `/api/repositories${organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : ''}`,
    ),
  createRepository: (body: Partial<Repo> & { owner: string; name: string; provider: string }) =>
    request<{ data: Repo }>('/api/repositories', { method: 'POST', body: JSON.stringify(body) }),
  runs: (repoId: string) => request<{ data: Run[] }>(`/api/repositories/${repoId}/runs`),
  history: (repoId: string) =>
    request<{ data: HistoryPayload }>(`/api/repositories/${repoId}/history`),
  createRun: (repoId: string, body?: Record<string, unknown>) =>
    request<{ data: Run }>(`/api/repositories/${repoId}/runs`, {
      method: 'POST',
      body: JSON.stringify(body ?? { noLlm: true }),
    }),
  run: (id: string) => request<{ data: Run }>(`/api/runs/${id}`),
  cancelRun: (id: string) =>
    request<{ data: { id: string; status: string; cancelled: boolean } }>(
      `/api/runs/${id}/cancel`,
      { method: 'POST', body: '{}' },
    ),
  claims: (id: string) => request<{ data: Claim[] }>(`/api/runs/${id}/claims`),
  verifications: (id: string) =>
    request<{ data: Verification[] }>(`/api/runs/${id}/verifications`),
  impact: (id: string) =>
    request<{ data: { nodes: ImpactNode[]; edges?: ImpactEdge[]; coverageNote: string } }>(
      `/api/runs/${id}/impact-graph`,
    ),
  evidence: (id: string) => request<{ data: EvidencePack }>(`/api/runs/${id}/evidence-pack`),
  explain: (id: string) => request<{ data: ExplainPayload }>(`/api/runs/${id}/explain`),
  rules: (repoId: string) => request<{ data: Rule[] }>(`/api/repositories/${repoId}/rules`),
  previewRules: (repoId: string, rules: RuleDraft[]) =>
    request<{ data: { before: unknown; after: unknown; changes: string[] } }>(
      `/api/repositories/${repoId}/rules/preview`,
      { method: 'POST', body: JSON.stringify({ rules }) },
    ),
  putRules: (repoId: string, rules: RuleDraft[]) =>
    request<{
      data: { rules: Rule[]; appliedPolicies?: unknown; changes?: string[] };
    }>(`/api/repositories/${repoId}/rules`, {
      method: 'PUT',
      body: JSON.stringify({ rules }),
    }),
  bootstrapDemo: (runCheck = true) =>
    request<{ data: { repository: Repo; run: Run | null; overallStatus?: string } }>(
      '/api/demo/bootstrap',
      {
        method: 'POST',
        body: JSON.stringify({ runCheck, base: 'HEAD~1', head: 'HEAD', sync: true }),
      },
    ),
  confirmClaim: (
    runId: string,
    claimId: string,
    body: { decision: 'accept' | 'reject'; note?: string; reviewer?: string },
  ) =>
    request<{
      data: {
        allowMerge: boolean;
        overallStatus: string;
        reason?: string;
        idempotent?: boolean;
        review?: HumanReview;
      };
    }>(`/api/runs/${runId}/claims/${claimId}/confirm`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export interface Repo {
  id: string;
  organizationId?: string | null;
  provider: string;
  owner: string;
  name: string;
  defaultBranch: string;
  language: string | null;
  localPath?: string | null;
}

export interface Org {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  repositoryId: string;
  baseSha: string;
  headSha: string;
  status: string;
  riskLevel: string;
  overallStatus: string | null;
  totalDurationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  phase?: string | null;
  cancellable?: boolean;
  errorCode?: string | null;
}

export interface Claim {
  id: string;
  title: string;
  description: string;
  category: string;
  source: string;
  status: string;
  confidence: string;
  relatedFiles: string[];
  relatedSymbols: string[];
  evidenceRefs: string[];
  riskWeight: number;
}

export interface Verification {
  id: string;
  claimId: string | null;
  type: string;
  command: string;
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  resultSummary: string;
  relatedClaimIds: string[];
  boundHeadSha?: string | null;
  reviewer?: string | null;
  reviewNote?: string | null;
}

export interface HumanReview {
  id: string;
  runId: string;
  claimId: string;
  headSha: string;
  decision: 'accept' | 'reject';
  reviewer: string;
  note: string;
  at: string;
  verificationId: string;
  status: 'active' | 'superseded' | 'invalidated';
  invalidationReason?: string;
}

export interface ImpactNode {
  id: string;
  nodeType: string;
  label: string;
  path: string | null;
  relation: string;
  riskLevel: string;
  source: string | null;
  confidence: string | null;
}

export interface ImpactEdge {
  id?: string;
  from: string | null;
  to: string;
  relation: string;
}

export interface Rule {
  id: string;
  key: string;
  description: string;
  ruleType: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

export type RuleDraft = Omit<Rule, 'id'>;

export interface HistoryPayload {
  summary: {
    runs: number;
    avgDurationMs: number;
    failedOrBlocked: number;
    unknownHighRisk: number;
    passed: number;
  };
  runs: Run[];
  events: Array<{
    id: string;
    eventType: string;
    runId: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface ExplainPayload {
  runId: string;
  overallStatus: string;
  mergeGate?: { allowMerge: boolean; reason: string };
  claims: Array<{
    id: string;
    title: string;
    status: string;
    facts: string[];
    inferences: string[];
    unknowns: string[];
    manualReviews: string[];
    suggestion: string | null;
  }>;
}

export interface EvidencePack {
  schemaVersion: string;
  run: {
    id: string;
    overallStatus: string;
    riskLevel: string;
    baseSha: string;
    headSha: string;
    totalDurationMs?: number | null;
  };
  intent: { summary: string; assumptions: string[] };
  claims: Claim[];
  unknowns: Array<Record<string, unknown>>;
  mergeGate?: { allowMerge: boolean; reason: string };
  limitations: string[];
  verifications: Verification[];
  humanReviews?: HumanReview[];
}
