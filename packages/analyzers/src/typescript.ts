import { Project, SyntaxKind, type Expression } from 'ts-morph';
import { existsSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { resolveImportPath } from './resolve-import.js';

export interface TsSymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'export' | 'import';
  file: string;
  isTestRelated: boolean;
}

export interface ResolvedImport {
  specifier: string;
  resolvedPath: string | null;
}

/** A call edge resolved through the TypeScript type checker. */
export interface TsCallEdge {
  /** Callee symbol name as written at the call site (after alias resolution). */
  symbol: string;
  /** Repo-relative file declaring the callee, or null for external/unresolvable targets. */
  targetFile: string | null;
}

export interface TsFileAnalysis {
  file: string;
  imports: string[];
  resolvedImports: ResolvedImport[];
  exports: string[];
  functions: string[];
  classes: string[];
  /** Local identifier call sites (best-effort AST, kept for compatibility). */
  callTargets: string[];
  /** Type-checker resolved call edges: callee symbol → declaring file. */
  callEdges?: TsCallEdge[];
  symbols: TsSymbolInfo[];
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Resolve a call-site expression to its declaring repo-relative file using the
 * type checker. Follows import aliases and re-exports; returns `null` when the
 * callee is external (node_modules / global / untyped) or unresolvable.
 */
function resolveCallEdge(root: string, expr: Expression): TsCallEdge | null {
  try {
    const symbol = expr.getSymbol();
    if (!symbol) return null;
    const resolved = symbol.getAliasedSymbol() ?? symbol;
    const name = resolved.getName() || expr.getText();
    const declarations = resolved.getDeclarations();
    if (!declarations.length) return null;

    // Prefer the actual definition (function/variable/class) over re-exports.
    // When a symbol is declared in one file and re-exported from another,
    // getDeclarations() returns both; we must pick the defining file, not the
    // barrel, so call edges are attributed to the correct file.
    let best: string | null = null;
    for (const decl of declarations) {
      const abs = decl.getSourceFile().getFilePath();
      const rel = relative(resolve(root), abs);
      if (rel.startsWith('..') || isAbsolute(rel)) continue;

      // If this declaration is a non-export wrapper (ExportSpecifier, ExportAssignment),
      // keep looking for the real definition.
      const parentKind = decl.getParent()?.getKind();
      if (
        parentKind === SyntaxKind.ExportSpecifier ||
        parentKind === SyntaxKind.ExportAssignment
      ) {
        if (!best) best = toPosix(rel); // remember as fallback
        continue;
      }

      // Found a real definition — prefer this file.
      return { symbol: name, targetFile: toPosix(rel) };
    }

    // Fallback: use the first repo-internal declaration (barrel) if no real definition found.
    if (best) return { symbol: name, targetFile: best };

    // Declared outside the repo (node_modules types / globals) — external call.
    return { symbol: name, targetFile: null };
  } catch {
    return null;
  }
}

/**
 * Analyze TypeScript/JavaScript files into module-level structure plus a
 * type-checker-resolved call graph. When a tsconfig exists the full project is
 * loaded so cross-file symbol resolution is accurate; otherwise only the given
 * files are analyzed (heuristic fallback).
 */
export function analyzeTypeScriptFiles(
  root: string,
  files: string[],
): TsFileAnalysis[] {
  const tsconfig = join(root, 'tsconfig.json');
  const project = existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig })
    : new Project({ compilerOptions: { allowJs: true } });

  const results: TsFileAnalysis[] = [];
  for (const rel of files) {
    if (!/\.(ts|tsx|js|jsx)$/.test(rel)) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const source = project.getSourceFile(abs) ?? project.addSourceFileAtPath(abs);
    const imports = source.getImportDeclarations().map((d) => d.getModuleSpecifierValue());
    const resolvedImports: ResolvedImport[] = imports.map((specifier) => ({
      specifier,
      resolvedPath: resolveImportPath(root, rel, specifier),
    }));
    const exports: string[] = [];
    for (const e of source.getExportedDeclarations()) {
      exports.push(e[0]);
    }
    const functions = source.getFunctions().map((f) => f.getName() ?? '<anonymous>');
    const classes = source.getClasses().map((c) => c.getName() ?? '<anonymous>');
    const isTest = /\.(test|spec)\.[tj]sx?$/.test(rel) || rel.includes('__tests__');

    const callTargets = new Set<string>();
    const callEdges = new Map<string, TsCallEdge>();
    source.forEachDescendant((node) => {
      if (node.getKind() !== SyntaxKind.CallExpression) return;
      const expr = node.asKindOrThrow(SyntaxKind.CallExpression).getExpression();
      if (expr.getKind() === SyntaxKind.Identifier) {
        callTargets.add(expr.getText());
      } else if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        callTargets.add(expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName());
      }
      const edge = resolveCallEdge(root, expr);
      if (edge) {
        const key = `${edge.symbol}::${edge.targetFile ?? ''}`;
        if (!callEdges.has(key)) callEdges.set(key, edge);
      }
    });

    const symbols: TsSymbolInfo[] = [
      ...imports.map((name) => ({
        name,
        kind: 'import' as const,
        file: rel,
        isTestRelated: isTest,
      })),
      ...exports.map((name) => ({
        name,
        kind: 'export' as const,
        file: rel,
        isTestRelated: isTest,
      })),
      ...functions.map((name) => ({
        name,
        kind: 'function' as const,
        file: rel,
        isTestRelated: isTest,
      })),
      ...classes.map((name) => ({
        name,
        kind: 'class' as const,
        file: rel,
        isTestRelated: isTest,
      })),
    ];

    for (const decl of source.getVariableDeclarations()) {
      if (decl.isExported() && decl.getInitializer()?.getKind() === SyntaxKind.ArrowFunction) {
        const name = decl.getName();
        functions.push(name);
        symbols.push({ name, kind: 'function', file: rel, isTestRelated: isTest });
      }
    }

    results.push({
      file: rel,
      imports,
      resolvedImports,
      exports,
      functions,
      classes,
      callTargets: [...callTargets],
      callEdges: [...callEdges.values()],
      symbols,
    });
  }
  return results;
}
