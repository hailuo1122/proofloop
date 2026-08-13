import { createId, type ImpactEdge, type ImpactNode, type RiskLevel } from '@proofloop/core';
import type { DiffFile } from '@proofloop/git';
import type { TsFileAnalysis } from './typescript.js';
import type { PyFileAnalysis } from './python.js';

export interface ImpactGraphResult {
  nodes: ImpactNode[];
  edges: ImpactEdge[];
  coverageNote: string;
  analyzedFiles: number;
  skippedFiles: number;
  /** Repo-relative files transitively affected by the change (reverse closure). */
  affectedFiles: string[];
}

function riskForPath(path: string): RiskLevel {
  if (/auth|session|permission|secret|payment|schema|migration/i.test(path)) return 'high';
  if (/api|upload|deploy|workflow/i.test(path)) return 'medium';
  return 'low';
}

export function buildImpactGraph(input: {
  runId: string;
  diffFiles: DiffFile[];
  ts?: TsFileAnalysis[];
  py?: PyFileAnalysis[];
}): ImpactGraphResult {
  const nodes: ImpactNode[] = [];
  const edges: ImpactEdge[] = [];
  const analyzed = new Set<string>();
  const fileNodeByPath = new Map<string, string>();
  const edgeKeys = new Set<string>();
  /** file path → paths it depends on (imports + calls). */
  const dependsOn = new Map<string, Set<string>>();
  /** file path → paths depending on it (reverse edges). */
  const dependents = new Map<string, Set<string>>();

  for (const f of input.diffFiles) {
    ensureFileNode(f.path, 'diff', 'high', 'changed');
  }

  const sourceAnalyzable = new Set(
    input.diffFiles
      .map((f) => f.path)
      .filter((p) => /\.(ts|tsx|js|jsx|py)$/.test(p)),
  );

  function ensureFileNode(
    path: string,
    source: string,
    confidence: ImpactNode['confidence'] = 'medium',
    relation: ImpactNode['relation'] = 'imports',
  ): string {
    const existing = fileNodeByPath.get(path);
    if (existing) {
      // Upgrade relation to changed if we later learn it was in the diff.
      if (relation === 'changed') {
        const node = nodes.find((n) => n.id === existing);
        if (node) node.relation = 'changed';
      }
      return existing;
    }
    const id = createId('node');
    nodes.push({
      id,
      runId: input.runId,
      nodeType: 'file',
      label: path,
      path,
      relation,
      riskLevel: riskForPath(path),
      source,
      confidence,
    });
    fileNodeByPath.set(path, id);
    return id;
  }

  function link(fromId: string, toId: string, relation: ImpactEdge['relation']) {
    const key = `${fromId}->${toId}:${relation}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      id: createId('edge'),
      runId: input.runId,
      fromNodeId: fromId,
      toNodeId: toId,
      relation,
    });
  }

  function recordDep(fromPath: string, toPath: string) {
    if (!fromPath || !toPath || fromPath === toPath) return;
    let set = dependsOn.get(fromPath);
    if (!set) {
      set = new Set();
      dependsOn.set(fromPath, set);
    }
    set.add(toPath);
    let rev = dependents.get(toPath);
    if (!rev) {
      rev = new Set();
      dependents.set(toPath, rev);
    }
    rev.add(fromPath);
  }

  for (const ts of input.ts ?? []) {
    analyzed.add(ts.file);
    const fileId = ensureFileNode(ts.file, 'ast');

    const resolved =
      ts.resolvedImports?.length
        ? ts.resolvedImports
        : ts.imports.map((s) => ({ specifier: s, resolvedPath: null as string | null }));
    for (const imp of resolved) {
      if (imp.resolvedPath) {
        const targetId = ensureFileNode(imp.resolvedPath, 'ast', 'medium');
        link(fileId, targetId, 'imports');
        link(targetId, fileId, 'imported_by');
        recordDep(ts.file, imp.resolvedPath);
      } else {
        const depId = createId('node');
        nodes.push({
          id: depId,
          runId: input.runId,
          nodeType: 'dependency',
          label: imp.specifier,
          path: ts.file,
          relation: 'imports',
          riskLevel: 'low',
          source: 'ast',
          confidence: 'medium',
        });
        link(fileId, depId, 'imports');
      }
    }

    for (const fn of ts.functions) {
      const symId = createId('node');
      const relation = /auth|session|permission/i.test(fn) ? 'validates' : 'exposes';
      nodes.push({
        id: symId,
        runId: input.runId,
        nodeType: 'symbol',
        label: fn,
        path: ts.file,
        relation,
        riskLevel: riskForPath(ts.file),
        source: 'ast',
        confidence: 'high',
      });
      link(fileId, symId, relation);
    }

    // Type-checker resolved call edges: caller file → callee declaring file.
    for (const edge of ts.callEdges ?? []) {
      if (!edge.targetFile) continue; // external / global — no file edge
      const targetId = ensureFileNode(edge.targetFile, 'ast', 'medium');
      link(fileId, targetId, 'calls');
      recordDep(ts.file, edge.targetFile);
    }

    if (ts.symbols.some((s) => s.isTestRelated)) {
      const testId = createId('node');
      nodes.push({
        id: testId,
        runId: input.runId,
        nodeType: 'test',
        label: ts.file,
        path: ts.file,
        relation: 'tests',
        riskLevel: 'low',
        source: 'ast',
        confidence: 'high',
      });
      link(fileId, testId, 'tests');
    }
  }

  const pyFunctionOwners = new Map<string, string[]>();
  for (const py of input.py ?? []) {
    for (const fn of py.functions) {
      const list = pyFunctionOwners.get(fn) ?? [];
      list.push(py.file);
      pyFunctionOwners.set(fn, list);
    }
  }

  for (const py of input.py ?? []) {
    analyzed.add(py.file);
    const fileId = ensureFileNode(py.file, 'ast');

    const resolved =
      py.resolvedImports?.length
        ? py.resolvedImports
        : py.imports.map((s) => ({ specifier: s, resolvedPath: null as string | null }));
    for (const imp of resolved) {
      if (imp.resolvedPath) {
        const targetId = ensureFileNode(imp.resolvedPath, 'ast', 'medium');
        link(fileId, targetId, 'imports');
        link(targetId, fileId, 'imported_by');
        recordDep(py.file, imp.resolvedPath);
      } else {
        const depId = createId('node');
        nodes.push({
          id: depId,
          runId: input.runId,
          nodeType: 'dependency',
          label: imp.specifier,
          path: py.file,
          relation: 'imports',
          riskLevel: 'low',
          source: 'ast',
          confidence: 'medium',
        });
        link(fileId, depId, 'imports');
      }
    }
    for (const fn of py.functions) {
      const symId = createId('node');
      const relation = py.isPytest ? 'tests' : 'exposes';
      nodes.push({
        id: symId,
        runId: input.runId,
        nodeType: 'symbol',
        label: fn,
        path: py.file,
        relation,
        riskLevel: riskForPath(py.file),
        source: 'ast',
        confidence: 'high',
      });
      link(fileId, symId, relation);
    }
    // Python has no static type checker in-process: name-matched call targets
    // are resolved to owning files as a best-effort fallback.
    for (const target of py.callTargets ?? []) {
      const owners = pyFunctionOwners.get(target) ?? [];
      for (const owner of owners) {
        if (owner === py.file) continue;
        const targetFileId = ensureFileNode(owner, 'ast', 'medium');
        link(fileId, targetFileId, 'calls');
        recordDep(py.file, owner);
      }
    }
  }

  // Transitive impact: reverse closure over imports + calls from changed files.
  const changed = new Set(input.diffFiles.map((f) => f.path));
  const affected = new Set<string>();
  const queue: string[] = [...changed];
  const seen = new Set(changed);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const dep of dependents.get(cur) ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        affected.add(dep);
        queue.push(dep);
      }
    }
  }
  const affectedFiles = [...affected].sort();

  const fileEdges = edges.filter((e) =>
    ['imports', 'imported_by', 'calls'].includes(e.relation),
  ).length;
  const analyzedFiles = analyzed.size;
  const skippedFiles = Math.max(0, sourceAnalyzable.size - [...sourceAnalyzable].filter((p) => analyzed.has(p)).length);

  const coverageNote =
    `Impact graph built from ${analyzedFiles} analyzed file(s) using real module ` +
    `resolution (tsconfig paths, node_modules, package.json exports) and ` +
    `type-checker call edges (${fileEdges} file-level edges). ` +
    `${affectedFiles.length} file(s) transitively affected by the change: ` +
    `${affectedFiles.slice(0, 8).join(', ') || '(none)'}` +
    (affectedFiles.length > 8 ? ` (+${affectedFiles.length - 8} more)` : '') +
    (skippedFiles > 0 ? `; ${skippedFiles} diff file(s) not source-analyzable` : '') +
    '. Not a complete runtime/enterprise call graph — edges are AST/module-resolution based.';

  return {
    nodes,
    edges,
    coverageNote,
    analyzedFiles,
    skippedFiles,
    affectedFiles,
  };
}
