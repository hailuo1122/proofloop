import {
  createId,
  HIGH_RISK_PATH_PATTERNS,
  type Claim,
  type ChangeIntent,
  type Confidence,
} from '@proofloop/core';
import type { DiffFile } from '@proofloop/git';
import type { TsFileAnalysis } from './typescript.js';
import type { PyFileAnalysis } from './python.js';

export function buildDeterministicIntent(input: {
  runId: string;
  files: DiffFile[];
  prBody?: string;
}): ChangeIntent {
  const summary =
    input.prBody?.trim().split(/\r?\n/).find((l) => l.trim()) ||
    `Change touches ${input.files.length} file(s): ${input.files
      .slice(0, 5)
      .map((f) => f.path)
      .join(', ')}`;
  return {
    id: createId('intent'),
    runId: input.runId,
    summary,
    sourceText: input.prBody ?? summary,
    confidence: input.prBody ? 'medium' : 'low',
    assumptions: [
      'Intent inferred without LLM; treat as heuristic, not fact.',
      'No production environment validation is assumed.',
    ],
    generatedAt: new Date().toISOString(),
  };
}

function isHighRiskPath(path: string): boolean {
  return HIGH_RISK_PATH_PATTERNS.some((re) => re.test(path));
}

export function buildDeterministicClaims(input: {
  runId: string;
  files: DiffFile[];
  ts?: TsFileAnalysis[];
  py?: PyFileAnalysis[];
}): Claim[] {
  const claims: Claim[] = [];
  const authFiles = input.files.filter((f) => isHighRiskPath(f.path));
  const pySymbols = (input.py ?? []).flatMap((p) => [...p.functions, ...p.classes]);
  const tsSymbols = (input.ts ?? [])
    .filter((t) => authFiles.some((f) => f.path === t.file))
    .flatMap((t) => t.functions);

  if (authFiles.length) {
    claims.push({
      id: createId('claim'),
      runId: input.runId,
      title: 'Authentication/authorization boundaries remain correct',
      description:
        'High-risk auth-related paths changed; expired or invalid credentials must not create privileged sessions.',
      category: 'security',
      source: 'diff_inference',
      status: 'unknown',
      confidence: 'medium',
      riskWeight: 85,
      relatedFiles: authFiles.map((f) => f.path),
      relatedSymbols: [...tsSymbols, ...pySymbols.filter((s) => /auth|session|token|login/i.test(s))].slice(
        0,
        12,
      ),
    });

    claims.push({
      id: createId('claim'),
      runId: input.runId,
      title: 'Revoked tokens are rejected by upstream IdP integration',
      description:
        'No dynamic verification of revocation/IdP network behavior was planned; remains unknown without integration tests or manual confirmation.',
      category: 'security',
      source: 'diff_inference',
      status: 'unknown',
      confidence: 'low',
      riskWeight: 80,
      relatedFiles: authFiles.map((f) => f.path),
      relatedSymbols: [],
    });
  }

  const testFiles = input.files.filter((f) => /\.(test|spec)\.|tests\/|test_/i.test(f.path));
  const srcFiles = input.files.filter((f) => !/\.(test|spec)\.|tests\/|test_/i.test(f.path));
  const hasPy = (input.py ?? []).length > 0 || input.files.some((f) => f.path.endsWith('.py'));

  claims.push({
    id: createId('claim'),
    runId: input.runId,
    title: 'Existing unit tests still pass for touched modules',
    description: hasPy
      ? 'Pytest/unit suite should remain green for the changed Python/TS surface.'
      : 'Lint/typecheck/unit suite should remain green for the changed surface.',
    category: 'compatibility',
    source: 'diff_inference',
    status: 'unknown',
    confidence: 'high' as Confidence,
    riskWeight: 55,
    relatedFiles: input.files.map((f) => f.path),
    relatedSymbols: [],
  });

  if (srcFiles.length) {
    claims.push({
      id: createId('claim'),
      runId: input.runId,
      title: hasPy ? 'Changed modules import/resolve cleanly' : 'Typecheck/build succeeds after the change',
      description: hasPy
        ? 'Python modules and any TS build graph remain consistent after the change.'
        : 'Static typing and build graph remain consistent.',
      category: 'functional',
      source: 'diff_inference',
      status: 'unknown',
      confidence: 'medium',
      riskWeight: 40,
      relatedFiles: srcFiles.map((f) => f.path),
      relatedSymbols: pySymbols.slice(0, 8),
    });
  }

  if (!authFiles.length && testFiles.length === 0 && srcFiles.length) {
    claims.push({
      id: createId('claim'),
      runId: input.runId,
      title: 'Changed modules have automated coverage',
      description: 'No test files changed; behavioral coverage is unknown without executed suites.',
      category: 'functional',
      source: 'diff_inference',
      status: 'unknown',
      confidence: 'low',
      riskWeight: 35,
      relatedFiles: srcFiles.map((f) => f.path),
      relatedSymbols: [],
    });
  }

  return claims;
}
