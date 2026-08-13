import { ts } from 'ts-morph';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

/**
 * Production module resolution for TypeScript/JavaScript.
 *
 * Uses the real TypeScript resolver (`ts.resolveModuleName`) so specifiers are
 * resolved exactly as the compiler would:
 *   - `tsconfig.json` `baseUrl` + `paths` aliases
 *   - `node_modules` lookup honoring package.json `exports` / `main` / `module` / `types`
 *   - extension probing (`.ts` / `.tsx` / `.d.ts` / `.js` …), index files,
 *     and ESM-style `.js` → `.ts` source mapping
 *   - `.d.ts` result mapping back to the source `.ts` when present
 *
 * A small heuristic fallback keeps resolution working even when no tsconfig
 * exists or the compiler throws (e.g. synthetic test roots).
 */

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  allowJs: true,
};

type CachedEntry = { mtimeMs: number; options: ts.CompilerOptions };
const optionsCache = new Map<string, CachedEntry>();

function compilerOptionsFor(root: string): ts.CompilerOptions {
  const tsconfig = join(root, 'tsconfig.json');
  const currentMtime = existsSync(tsconfig) ? statSync(tsconfig).mtimeMs : 0;
  const cached = optionsCache.get(root);
  if (cached && cached.mtimeMs === currentMtime) return cached.options;
  let options = DEFAULT_OPTIONS;
  if (existsSync(tsconfig)) {
    try {
      const parsed = ts.getParsedCommandLineOfConfigFile(
        tsconfig,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: () => undefined,
          readDirectory: ts.sys.readDirectory.bind(ts.sys),
        },
      );
      if (parsed && parsed.options) options = parsed.options;
    } catch {
      // fall back to defaults
    }
  }
  // Cache per-root, invalidated on tsconfig.json mtime change so long-lived
  // API workers pick up config edits without restarting.
  optionsCache.set(root, { mtimeMs: currentMtime, options });
  return options;
}

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', ''];

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Map a resolved `.d.ts` to its source `.ts` sibling when it exists. */
function sourceFromDeclaration(root: string, abs: string): string {
  if (abs.endsWith('.d.ts')) {
    const src = abs.slice(0, -'.d.ts'.length) + '.ts';
    if (existsSync(src)) return src;
  } else if (abs.endsWith('.d.mts')) {
    const src = abs.slice(0, -'.d.mts'.length) + '.mts';
    if (existsSync(src)) return src;
  } else if (abs.endsWith('.d.cts')) {
    const src = abs.slice(0, -'.d.cts'.length) + '.cts';
    if (existsSync(src)) return src;
  }
  return abs;
}

/** Legacy heuristic fallback for roots without a usable tsconfig. */
function heuristicResolve(repoRoot: string, fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const fromDir = dirname(join(repoRoot, fromFile));
  const base = specifier.startsWith('/')
    ? join(repoRoot, specifier.slice(1))
    : join(fromDir, specifier);

  for (const ext of EXTS) {
    const candidate = normalize(base + ext);
    if (existsSync(candidate)) {
      return toPosix(relative(repoRoot, candidate));
    }
    const index = normalize(join(base, `index${ext || '.ts'}`));
    if (existsSync(index)) {
      return toPosix(relative(repoRoot, index));
    }
  }
  return null;
}

/**
 * Resolve a module specifier to a repo-relative file path, using the real
 * TypeScript resolver when possible. Returns `null` for external dependencies
 * (node_modules packages, node: builtins) or unresolvable specifiers.
 */
export function resolveImportPath(
  repoRoot: string,
  fromFile: string,
  specifier: string,
): string | null {
  if (!specifier || typeof specifier !== 'string') return null;

  const options = compilerOptionsFor(repoRoot);
  const containingFile = resolve(repoRoot, fromFile);
  try {
    const result = ts.resolveModuleName(
      specifier,
      containingFile,
      options,
      {
        ...ts.sys,
        getCurrentDirectory: () => resolve(repoRoot),
      },
      undefined,
    );
    const resolved = result.resolvedModule;
    if (resolved && resolved.resolvedFileName) {
      const abs = sourceFromDeclaration(repoRoot, resolved.resolvedFileName);
      const rel = normalize(relative(resolve(repoRoot), abs));
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        return toPosix(rel);
      }
      // Resolved outside the repo → external dependency, not a file edge.
      return null;
    }
  } catch {
    // fall through to heuristic
  }
  return heuristicResolve(repoRoot, fromFile, specifier);
}
