import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createId,
  type Artifact,
  type Claim,
  type ProofloopConfig,
  type Verification,
  type VerificationType,
} from '@proofloop/core';
import { createWorktree, removeWorktree } from '@proofloop/git';
import { evaluateCommand, redactSecrets, summarizeLog } from '@proofloop/security';
import { environmentFingerprint, saveArtifact } from './artifacts.js';
import { parseCoverageJson, parseJUnitXml, parseSarif } from './parsers.js';

export interface PlannedVerification {
  type: VerificationType;
  command: string;
  relatedClaimIds: string[];
}

export interface RunnerResult {
  verifications: Verification[];
  artifacts: Artifact[];
}

export function planVerifications(input: {
  config: ProofloopConfig;
  claims: Claim[];
  detected: {
    lint?: string;
    typecheck?: string;
    unit?: string;
    integration?: string;
    build?: string;
    security?: string;
  };
}): PlannedVerification[] {
  const cmds = {
    lint: input.config.commands.lint ?? input.detected.lint,
    typecheck: input.config.commands.typecheck ?? input.detected.typecheck,
    unit: input.config.commands.unit ?? input.detected.unit,
    integration: input.config.commands.integration ?? input.detected.integration,
    build: input.config.commands.build ?? input.detected.build,
    security: input.config.commands.security ?? input.detected.security,
  };

  const plans: PlannedVerification[] = [];
  const allClaimIds = input.claims.map((c) => c.id);
  const securityClaimIds = input.claims.filter((c) => c.category === 'security').map((c) => c.id);
  const compatIds = input.claims
    .filter((c) => c.category === 'compatibility' || c.category === 'functional')
    .map((c) => c.id);

  const functionalIds = input.claims.filter((c) => c.category === 'functional').map((c) => c.id);
  const compatibilityIds = input.claims
    .filter((c) => c.category === 'compatibility')
    .map((c) => c.id);
  // Only link unit tests to security claims that mention session/token boundaries;
  // leave revocation/IdP-style claims unlinked so they remain unknown.
  const unitLinkedSecurity = input.claims
    .filter(
      (c) =>
        c.category === 'security' &&
        /session|expir|credential|boundary/i.test(`${c.title} ${c.description}`),
    )
    .map((c) => c.id);

  if (cmds.lint) {
    plans.push({
      type: 'lint',
      command: cmds.lint,
      relatedClaimIds: functionalIds.length ? functionalIds : compatIds.length ? compatIds : allClaimIds,
    });
  }
  if (cmds.typecheck) {
    plans.push({
      type: 'typecheck',
      command: cmds.typecheck,
      relatedClaimIds: [
        ...compatibilityIds,
        ...functionalIds.filter((id) => !compatibilityIds.includes(id)),
      ].filter(Boolean),
    });
  }
  if (cmds.unit) {
    plans.push({
      type: 'unit_test',
      command: cmds.unit,
      relatedClaimIds: [
        ...unitLinkedSecurity,
        ...compatibilityIds.filter((id) => !unitLinkedSecurity.includes(id)),
      ].length
        ? [
            ...unitLinkedSecurity,
            ...compatibilityIds.filter((id) => !unitLinkedSecurity.includes(id)),
          ]
        : securityClaimIds.length
          ? securityClaimIds
          : allClaimIds,
    });
  }
  if (cmds.integration) {
    plans.push({ type: 'integration_test', command: cmds.integration, relatedClaimIds: allClaimIds });
  }
  if (cmds.build) {
    plans.push({
      type: 'build',
      command: cmds.build,
      relatedClaimIds: functionalIds.length ? functionalIds : compatibilityIds,
    });
  }
  if (cmds.security) {
    plans.push({ type: 'security_scan', command: cmds.security, relatedClaimIds: securityClaimIds });
  }
  return plans;
}

/** Split a command string into argv tokens, honoring single/double quotes. */
function tokenizeArgs(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of command.matchAll(re)) {
    tokens.push(m[1] ?? m[2] ?? m[3]!);
  }
  return tokens;
}

function shellCommand(command: string): { file: string; args: string[] } {
  // Spawn `node <file> <args>` directly (no shell) on every platform so quoting
  // and argument splitting stay deterministic and no shell metacharacters are
  // interpreted. Argument splitting is quote-aware.
  if (/^node(\s|$)/i.test(command.trim())) {
    const args = tokenizeArgs(command.trim().replace(/^node\s+/i, ''));
    return { file: process.execPath, args };
  }
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

export async function runCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxLogBytes?: number;
  signal?: AbortSignal;
  envWhitelist?: string[];
  declaredSafeCommands?: string[];
  allowNetwork?: boolean;
}): Promise<{
  status: Verification['status'];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}> {
  const started = Date.now();
  const policy = evaluateCommand(input.command, {
    declaredSafeCommands: input.declaredSafeCommands,
    allowNetwork: input.allowNetwork,
  });
  if (!policy.allowed) {
    return {
      status: 'blocked',
      exitCode: null,
      stdout: '',
      stderr: policy.reason,
      durationMs: 0,
    };
  }
  if (input.signal?.aborted) {
    return {
      status: 'skipped',
      exitCode: null,
      stdout: '',
      stderr: 'run_cancelled',
      durationMs: 0,
    };
  }

  const { file, args } = shellCommand(input.command);
    // Start from an explicit allowlist, NOT process.env: secrets in the host
    // environment (tokens, API keys) must never reach verification subprocesses.
    // Callers opt specific keys in via envWhitelist when a command legitimately
    // needs them — keep that list as short as possible.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      ComSpec: process.env.ComSpec,
      PATHEXT: process.env.PATHEXT,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
      NODE_ENV: 'test',
      CI: '1',
      npm_config_update_notifier: 'false',
    };
  for (const key of input.envWhitelist ?? []) {
    if (process.env[key] != null) env[key] = process.env[key];
  }

  return await new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: input.cwd,
      env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const max = input.maxLogBytes ?? 512_000;
    let settled = false;

    const finish = (status: Verification['status'], exitCode: number | null) => {
      if (settled) return;
      settled = true;
      resolve({
        status,
        exitCode,
        stdout: stdout.slice(0, max),
        stderr: stderr.slice(0, max),
        durationMs: Date.now() - started,
      });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish('timed_out', null);
    }, input.timeoutMs);

    input.signal?.addEventListener(
      'abort',
      () => {
        child.kill('SIGKILL');
        finish('skipped', null);
      },
      { once: true },
    );

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      stderr += err.message;
      finish('failed', null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 ? 'passed' : 'failed', code);
    });
  });
}

export async function runVerifications(input: {
  repoRoot: string;
  runId: string;
  headSha: string;
  plans: PlannedVerification[];
  storageRoot: string;
  timeoutMsPerCommand: number;
  declaredSafeCommands?: string[];
  allowNetwork?: boolean;
  signal?: AbortSignal;
  useWorktree?: boolean;
}): Promise<RunnerResult> {
  const verifications: Verification[] = [];
  const artifacts: Artifact[] = [];
  const repoRoot = resolve(input.repoRoot);
  let workDir = repoRoot;
  let worktreePath: string | null = null;
  // Prefer an isolated worktree of headSha so evidence is SHA-bound. On Windows,
  // junctions for node_modules are detached before recursive cleanup.
  const wantWorktree = input.useWorktree !== false;

  if (wantWorktree) {
    worktreePath = join(tmpdir(), `proofloop-wt-${input.runId}`);
    try {
      // Do not pre-create the path — `git worktree add` requires it absent.
      await createWorktree(repoRoot, worktreePath, input.headSha);
      workDir = worktreePath;
      const rootNm = join(repoRoot, 'node_modules');
      const wtNm = join(worktreePath, 'node_modules');
      if (existsSync(rootNm) && !existsSync(wtNm)) {
        try {
          symlinkSync(rootNm, wtNm, process.platform === 'win32' ? 'junction' : 'dir');
        } catch {
          workDir = repoRoot;
        }
      }
      const depsOk =
        existsSync(join(workDir, 'node_modules', 'typescript')) ||
        existsSync(join(workDir, 'node_modules', 'vitest')) ||
        existsSync(join(workDir, 'node_modules', '.bin'));
      if (!depsOk) {
        workDir = repoRoot;
      }
    } catch {
      worktreePath = null;
      workDir = repoRoot;
    }
  }

  try {
    for (const plan of input.plans) {
      if (input.signal?.aborted) {
        verifications.push({
          id: createId('verification'),
          claimId: plan.relatedClaimIds[0] ?? null,
          runId: input.runId,
          type: plan.type,
          command: plan.command,
          safeCommand: true,
          status: 'skipped',
          exitCode: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          environmentFingerprint: environmentFingerprint(),
          logArtifactId: null,
          resultSummary: 'run_cancelled',
          relatedClaimIds: plan.relatedClaimIds,
        });
        continue;
      }
      const startedAt = new Date().toISOString();
      const policy = evaluateCommand(plan.command, {
        declaredSafeCommands: input.declaredSafeCommands,
        allowNetwork: input.allowNetwork,
      });

      const id = createId('verification');
      if (!policy.allowed) {
        verifications.push({
          id,
          claimId: plan.relatedClaimIds[0] ?? null,
          runId: input.runId,
          type: plan.type,
          command: plan.command,
          safeCommand: false,
          status: 'blocked',
          exitCode: null,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          environmentFingerprint: environmentFingerprint(),
          logArtifactId: null,
          resultSummary: policy.reason,
          relatedClaimIds: plan.relatedClaimIds,
        });
        continue;
      }

      const result = await runCommand({
        command: plan.command,
        cwd: workDir,
        timeoutMs: input.timeoutMsPerCommand,
        signal: input.signal,
      });

      const finishedAt = new Date().toISOString();
      const combined = `${result.stdout}\n${result.stderr}`;
      const { text, redacted } = redactSecrets(combined);
      const summary = summarizeLog(text, 2000);
      const artifact = saveArtifact({
        runId: input.runId,
        kind: 'log',
        storageRoot: input.storageRoot,
        content: text,
        redacted,
        filename: `${id}.log.txt`,
      });
      artifacts.push(artifact);

      const structured = collectStructuredReports(workDir, plan.type, text);
      for (const report of structured.artifacts) {
        const scrubbed = redactSecrets(report.content);
        artifacts.push(
          saveArtifact({
            runId: input.runId,
            kind: report.kind,
            storageRoot: input.storageRoot,
            content: scrubbed.text,
            redacted: scrubbed.redacted,
            filename: `${id}.${report.ext}`,
          }),
        );
      }

      const resultSummary = [summary.slice(0, 400), ...structured.summaries]
        .filter(Boolean)
        .join(' · ')
        .slice(0, 800) || `${plan.type}: ${result.status}`;

      let status = result.status;
      if (
        status === 'passed' &&
        structured.summaries.some(
          (s) => /failures=[1-9]\d*|errors=[1-9]\d*|SARIF findings: [1-9]\d*/i.test(s),
        )
      ) {
        status = 'failed';
      }

      verifications.push({
        id,
        claimId: plan.relatedClaimIds[0] ?? null,
        runId: input.runId,
        type: plan.type,
        command: plan.command,
        safeCommand: policy.safeCommand,
        status,
        exitCode: result.exitCode,
        startedAt,
        finishedAt,
        durationMs: result.durationMs,
        environmentFingerprint: environmentFingerprint(),
        logArtifactId: artifact.id,
        resultSummary,
        relatedClaimIds: plan.relatedClaimIds,
      });
    }
  } finally {
    if (worktreePath) {
      // Detach the dependency junction BEFORE removing the worktree: recursive
      // deletion through a live junction can wipe the real node_modules. If the
      // first unlink fails (file in use), `git worktree remove` may leave the
      // junction behind, so retry the detach before deciding the shell is safe
      // to remove. If it is still attached, leave the (empty-ish) shell rather
      // than risk deleting the real dependencies.
      const linkedNm = join(worktreePath, 'node_modules');
      const detach = (): boolean => {
        try {
          if (!existsSync(linkedNm)) return true;
          const st = lstatSync(linkedNm);
          if (!st.isSymbolicLink() && !st.isDirectory()) return false;
          unlinkSync(linkedNm);
          return !existsSync(linkedNm);
        } catch {
          return false;
        }
      };
      detach();
      await removeWorktree(repoRoot, worktreePath);
      const clean = detach();
      try {
        if (clean && existsSync(worktreePath)) {
          rmSync(worktreePath, { recursive: true, force: true });
        }
      } catch {
        // best effort
      }
    }
  }

  return { verifications, artifacts };
}

function collectStructuredReports(
  workDir: string,
  type: VerificationType,
  logText: string,
): {
  summaries: string[];
  artifacts: Array<{ kind: Artifact['kind']; content: string; ext: string }>;
} {
  const summaries: string[] = [];
  const out: Array<{ kind: Artifact['kind']; content: string; ext: string }> = [];
  const candidates: Array<{ path: string; kind: 'junit' | 'coverage' | 'report' }> = [];

  const pathHits = logText.match(
    /(?:[\w./\\-]+\.(?:xml|json|sarif))/gi,
  ) ?? [];
  for (const hit of pathHits.slice(0, 8)) {
    const abs = resolve(workDir, hit);
    const rel = relative(workDir, abs);
    if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) continue;
    if (!existsSync(abs)) continue;
    if (/\.xml$/i.test(hit)) candidates.push({ path: abs, kind: 'junit' });
    else if (/coverage/i.test(hit)) candidates.push({ path: abs, kind: 'coverage' });
    else if (/sarif/i.test(hit)) candidates.push({ path: abs, kind: 'report' });
  }

  for (const rel of [
    'coverage/coverage-final.json',
    'coverage/coverage-summary.json',
    'junit.xml',
    'test-results/junit.xml',
    'reports/junit.xml',
    'results.sarif',
    'sarif.json',
  ]) {
    const abs = join(workDir, rel);
    if (!existsSync(abs)) continue;
    if (rel.endsWith('.xml')) candidates.push({ path: abs, kind: 'junit' });
    else if (rel.includes('coverage')) candidates.push({ path: abs, kind: 'coverage' });
    else candidates.push({ path: abs, kind: 'report' });
  }

  // Vitest / pytest default folders
  for (const dir of ['coverage', 'test-results', 'reports']) {
    const absDir = join(workDir, dir);
    if (!existsSync(absDir)) continue;
    try {
      for (const name of readdirSync(absDir).slice(0, 20)) {
        const abs = join(absDir, name);
        if (/\.xml$/i.test(name)) candidates.push({ path: abs, kind: 'junit' });
        if (/coverage.*\.json$/i.test(name)) candidates.push({ path: abs, kind: 'coverage' });
        if (/\.sarif$/i.test(name)) candidates.push({ path: abs, kind: 'report' });
      }
    } catch {
      // ignore
    }
  }

  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    try {
      const raw = readFileSync(c.path, 'utf8');
      if (c.kind === 'junit' || raw.includes('<testsuite')) {
        const parsed = parseJUnitXml(raw);
        summaries.push(parsed.summary);
        out.push({ kind: 'junit', content: raw.slice(0, 200_000), ext: 'junit.xml' });
      } else if (c.kind === 'coverage' || /"total"\s*:\s*\{/.test(raw)) {
        const parsed = parseCoverageJson(raw);
        summaries.push(parsed.summary);
        out.push({ kind: 'coverage', content: raw.slice(0, 200_000), ext: 'coverage.json' });
      } else if (c.kind === 'report' || /"runs"\s*:\s*\[/.test(raw)) {
        const parsed = parseSarif(raw);
        summaries.push(parsed.summary);
        out.push({ kind: 'report', content: raw.slice(0, 200_000), ext: 'sarif.json' });
      }
    } catch {
      // ignore unreadable reports
    }
    if (summaries.length >= 3) break;
  }

  if (type === 'unit_test' || type === 'integration_test' || type === 'security_scan') {
    return { summaries, artifacts: out };
  }
  return { summaries: summaries.slice(0, 2), artifacts: out.slice(0, 2) };
}
