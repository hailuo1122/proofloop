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

function loadCompilerOptions(tsconfigPath: string): ts.CompilerOptions {
  const currentMtime = existsSync(tsconfigPath) ? statSync(tsconfigPath).mtimeMs : 0;
  const cached = optionsCache.get(tsconfigPath);
  if (cached && cached.mtimeMs === currentMtime) return cached.options;
  let options = DEFAULT_OPTIONS;
  if (existsSync(tsconfigPath)) {
    try {
      const parsed = ts.getParsedCommandLineOfConfigFile(
        tsconfigPath,
        {},
        {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: () => undefined,
          readDirectory: ts.sys.readDirectory.bind(ts.sys),
        },
      );
      if (parsed && parsed.options) options = parsed.options;
    } catch {
      console.warn(
        `[proofloop] Failed to parse ${tsconfigPath}; falling back to default module resolution options.`,
      );
    }
  }
  // Cache per tsconfig path, invalidated on mtime change so long-lived API
  // workers pick up config edits without restarting.
  optionsCache.set(tsconfigPath, { mtimeMs: currentMtime, options });
  return options;
}

/**
 * Find the nearest tsconfig.json at or above `fromDir`, stopping at the repo
 * root. Monorepos keep per-package tsconfigs; using the nearest one preserves
 * package-level `paths`/`baseUrl` that a root-only lookup would silently lose.
 */
function findNearestTsconfig(fromDir: string, repoRoot: string): string | null {
  let dir = fromDir;
  const stop = resolve(repoRoot);
  for (;;) {
    const candidate = join(dir, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    if (resolve(dir) === stop) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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

  // Prefer the nearest tsconfig.json to the importing file (monorepos keep
  // per-package configs); fall back to the repo root config, then defaults.
  const containingFile = resolve(repoRoot, fromFile);
  const tsconfig =
    findNearestTsconfig(dirname(containingFile), repoRoot) ?? join(repoRoot, 'tsconfig.json');
  const options = loadCompilerOptions(tsconfig);
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
