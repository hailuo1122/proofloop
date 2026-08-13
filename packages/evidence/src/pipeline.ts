import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  createId,
  mergeRulesIntoConfig,
  parseProofloopConfig,
  type Claim,
  type ClaimCategory,
  type ClaimSource,
  type Confidence,
  type ProofloopConfig,
  type RepoRule,
  type RiskFinding,
} from '@proofloop/core';
import { analyzeDiff, getSha } from '@proofloop/git';
import {
  analyzePythonFilesAsync,
  analyzeTypeScriptFiles,
  buildDeterministicClaims,
  buildDeterministicIntent,
  buildImpactGraph,
  detectProject,
} from '@proofloop/analyzers';
import { planVerifications, runVerifications } from '@proofloop/verifiers';
import { buildEvidencePack, renderMarkdownReport } from './pack.js';
import type { EvidencePack } from './schema.js';

export type PipelinePhase =
  | 'collecting'
  | 'understanding'
  | 'planning'
  | 'verifying'
  | 'building-evidence';

export interface PipelineOptions {
  cwd: string;
  base?: string;
  head?: string;
  /** Prefer stable run id from API queue when provided. */
  runId?: string;
  prBody?: string;
  repositoryName?: string;
  noLlm?: boolean;
  storageRoot?: string;
  /** Repository rules from API/UI — merged over proofloop.yml policies. */
  repositoryRules?: RepoRule[];
  onPhase?: (phase: PipelinePhase, detail?: string) => void;
  signal?: AbortSignal;
  llm?: {
    generateIntent?: (input: unknown) => Promise<{
      summary: string;
      assumptions: string[];
      confidence: 'low' | 'medium' | 'high';
    }>;
    generateClaims?: (input: unknown) => Promise<{
      claims: Array<{
        title: string;
        description: string;
        category: ClaimCategory;
        source: ClaimSource;
        confidence: Confidence;
        riskWeight: number;
        relatedFiles: string[];
        relatedSymbols?: string[];
      }>;
    }>;
  };
}

export interface PipelineResult {
  pack: EvidencePack;
  runDir: string;
  evidencePath: string;
  reportPath: string;
}

function loadConfig(cwd: string): ProofloopConfig {
  const path = join(cwd, 'proofloop.yml');
  if (!existsSync(path)) return parseProofloopConfig({});
  const raw = parseYaml(readFileSync(path, 'utf8'));
  return parseProofloopConfig(raw);
}

export async function runCheckPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runId = opts.runId ?? createId('run');
  const storageRoot = opts.storageRoot ?? join(opts.cwd, '.proofloop', 'storage');
  const runDir = join(opts.cwd, '.proofloop', 'runs', runId);
  mkdirSync(runDir, { recursive: true });

  opts.onPhase?.('collecting');
  if (opts.signal?.aborted) throw new Error('run_cancelled');
  const baseRef = opts.base ?? 'HEAD~1';
  const headRef = opts.head ?? 'HEAD';
  const baseSha = await getSha(opts.cwd, baseRef);
  const headSha = await getSha(opts.cwd, headRef);
  const diff = await analyzeDiff(opts.cwd, baseSha, headSha);
  const fileConfig = loadConfig(opts.cwd);
  const config = mergeRulesIntoConfig(fileConfig, opts.repositoryRules);
  const detection = detectProject(opts.cwd);
  const ruleLabels = (opts.repositoryRules ?? [])
    .filter((r) => r.enabled)
    .map((r) => r.key);

  opts.onPhase?.('understanding', `${diff.files.length} files`);
  if (opts.signal?.aborted) throw new Error('run_cancelled');
  let intent = buildDeterministicIntent({
    runId,
    files: diff.files,
    prBody: opts.prBody,
  });
  const tsFiles = diff.files.map((f) => f.path).filter((p) => /\.(ts|tsx|js|jsx)$/.test(p));
  const pyFiles = diff.files.map((f) => f.path).filter((p) => p.endsWith('.py'));
  // Expand analysis beyond the diff so reverse-closure (imported_by) can fire.
  // Prefer files in the same directories as the change, then the rest of the tree.
  let extraTs: string[] = [];
  let extraPy: string[] = [];
  try {
    const { listFiles } = await import('@proofloop/git');
    const { dirname } = await import('node:path');
    const all = await listFiles(opts.cwd, headSha);
    const seedDirs = new Set(
      [...tsFiles, ...pyFiles].map((p) => dirname(p).replace(/\\/g, '/')),
    );
    const rank = (paths: string[]) =>
      [...paths].sort((a, b) => {
        const ad = seedDirs.has(dirname(a).replace(/\\/g, '/')) ? 0 : 1;
        const bd = seedDirs.has(dirname(b).replace(/\\/g, '/')) ? 0 : 1;
        return ad - bd || a.localeCompare(b);
      });
    const tsCap = Number(process.env.PROOFLOOP_IMPACT_TS_CAP ?? 400);
    const pyCap = Number(process.env.PROOFLOOP_IMPACT_PY_CAP ?? 200);
    extraTs = rank(
      all.filter((p) => /\.(ts|tsx|js|jsx)$/.test(p) && !tsFiles.includes(p)),
    ).slice(0, tsCap);
    extraPy = rank(all.filter((p) => p.endsWith('.py') && !pyFiles.includes(p))).slice(
      0,
      pyCap,
    );
  } catch {
    // best-effort expansion
  }
  const ts = analyzeTypeScriptFiles(opts.cwd, [...tsFiles, ...extraTs]);
  const py = await analyzePythonFilesAsync(opts.cwd, [...pyFiles, ...extraPy]);
  if (opts.signal?.aborted) throw new Error('run_cancelled');
  let claims = buildDeterministicClaims({ runId, files: diff.files, ts, py });
  let llmUsed = false;
  const llmClaimIds = new Set<string>();
  const findings: RiskFinding[] = [];

  if (!opts.noLlm && opts.llm?.generateIntent) {
    try {
      const out = await opts.llm.generateIntent({
        prBody: opts.prBody,
        files: diff.files.map((f) => ({ path: f.path, status: f.status })),
        rules: ruleLabels,
        testDirs: ['tests', 'src'],
      });
      intent = {
        ...intent,
        summary: out.summary,
        assumptions: out.assumptions,
        confidence: out.confidence,
      };
      llmUsed = true;
    } catch {
      // keep deterministic intent
    }
  }

  if (!opts.noLlm && opts.llm?.generateClaims) {
    try {
      const out = await opts.llm.generateClaims({
        intentSummary: intent.summary,
        files: diff.files.map((f) => ({ path: f.path, status: f.status })),
        symbols: [
          ...ts.flatMap((t) => t.functions),
          ...py.flatMap((p) => p.functions),
        ].slice(0, 30),
        rules: ruleLabels,
      });
      const mapped: Claim[] = out.claims.map((c) => {
        const id = createId('claim');
        llmClaimIds.add(id);
        return {
          id,
          runId,
          title: c.title,
          description: c.description,
          category: c.category,
          source: c.source,
          status: 'inferred',
          confidence: c.confidence,
          riskWeight: c.riskWeight,
          relatedFiles: c.relatedFiles,
          relatedSymbols: c.relatedSymbols ?? [],
        };
      });
      if (mapped.length) {
        // Prefer schema-valid LLM claims, keep deterministic high-risk anchors
        // (security + any claim that would require dynamic verification).
        // Anchors are never dropped; only the LLM additions are capped so the
        // claim list stays readable for humans and the model card.
        const requireDynamic = new Set(
          (config.policies.requireDynamicVerificationFor ?? []).map(String),
        );
        const anchors = claims.filter(
          (c) =>
            c.category === 'security' ||
            c.riskWeight >= 70 ||
            requireDynamic.has(c.category),
        );
        const MAX_LLM_CLAIMS = Number(process.env.PROOFLOOP_LLM_CLAIMS_MAX ?? 12);
        claims = [...anchors, ...mapped.slice(0, MAX_LLM_CLAIMS)];
        llmUsed = true;
      }
    } catch {
      // keep deterministic claims; never write unvalidated LLM text
      findings.push({
        id: createId('finding'),
        runId,
        severity: 'info',
        title: 'llm_schema_error',
        description: 'LLM claims output failed schema validation; using deterministic claims',
        evidenceRefs: [],
        remediation: 'Retry with a stricter model or continue without LLM',
        blocking: false,
        source: 'llm',
      });
    }
  }

  const impact = buildImpactGraph({ runId, diffFiles: diff.files, ts, py });

  opts.onPhase?.('planning');
  if (opts.signal?.aborted) throw new Error('run_cancelled');
  const plans = planVerifications({
    config,
    claims,
    detected: detection.commands,
  });

  if (detection.unknowns.length) {
    findings.push({
      id: createId('finding'),
      runId,
      severity: 'info',
      title: 'Some verify commands were not auto-detected',
      description: detection.unknowns.join('; '),
      evidenceRefs: [],
      remediation: 'Declare commands explicitly in proofloop.yml',
      blocking: false,
      source: 'static',
    });
  }

  opts.onPhase?.('verifying', `${plans.length} commands`);
  if (opts.signal?.aborted) throw new Error('run_cancelled');
  const declared = Object.values(config.commands).filter(Boolean) as string[];
  // Per-command budget: split the total policy budget across plans, but never
  // let one command exceed a hard cap so a single hung run cannot strand the
  // whole check. Override the cap with PROOFLOOP_MAX_CMD_TIMEOUT_MS.
  const MAX_CMD_TIMEOUT_MS = Number(process.env.PROOFLOOP_MAX_CMD_TIMEOUT_MS ?? 120_000);
  const { verifications, artifacts } = await runVerifications({
    repoRoot: opts.cwd,
    runId,
    headSha,
    plans,
    storageRoot,
    timeoutMsPerCommand: Math.min(MAX_CMD_TIMEOUT_MS, (config.policies.maxTotalDurationSeconds * 1000) / Math.max(1, plans.length)),
    declaredSafeCommands: declared,
    allowNetwork: config.policies.allowNetwork,
    signal: opts.signal,
    useWorktree: true,
  });

  if (opts.signal?.aborted) throw new Error('run_cancelled');
  opts.onPhase?.('building-evidence');
  const finishedAt = new Date().toISOString();
  const pack = buildEvidencePack({
    runId,
    repository: opts.repositoryName ?? 'local/repo',
    baseSha,
    headSha,
    source: 'cli',
    startedAt,
    finishedAt,
    totalDurationMs: Date.now() - t0,
    intent,
    claims,
    verifications,
    findings,
    impactNodes: impact.nodes,
    impactEdges: impact.edges,
    coverageNote: impact.coverageNote,
    analyzedFiles: impact.analyzedFiles,
    artifacts,
    llmUsed,
    llmClaimIds,
    policies: config.policies,
  });

  const evidencePath = join(runDir, 'evidence.json');
  const reportPath = join(runDir, 'report.md');
  writeFileSync(evidencePath, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  writeFileSync(reportPath, renderMarkdownReport(pack), 'utf8');

  // history index (append-only)
  const historyPath = join(opts.cwd, '.proofloop', 'history.jsonl');
  mkdirSync(join(opts.cwd, '.proofloop'), { recursive: true });
  writeFileSync(
    historyPath,
    `${JSON.stringify({
      runId,
      headSha,
      baseSha,
      overallStatus: pack.run.overallStatus,
      createdAt: finishedAt,
      evidencePath,
    })}\n`,
    { flag: 'a' },
  );

  return { pack, runDir, evidencePath, reportPath };
}
