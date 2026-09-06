import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface ResolvedPyImport {
  specifier: string;
  resolvedPath: string | null;
}

export interface PyFileAnalysis {
  file: string;
  imports: string[];
  resolvedImports: ResolvedPyImport[];
  functions: string[];
  classes: string[];
  callTargets: string[];
  isPytest: boolean;
}

const IMPORT_RE = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
const DEF_RE = /^\s*def\s+([A-Za-z_][\w]*)\s*\(/gm;
const CLASS_RE = /^\s*class\s+([A-Za-z_][\w]*)\s*[:(]/gm;
const PYTEST_RE = /^\s*def\s+(test_[A-Za-z_][\w]*)\s*\(/gm;
const CALL_RE = /\b([A-Za-z_][\w]*)\s*\(/g;

/**
 * Fallback structural analysis using grammar-oriented regex over source lines.
 * Used only when no Python interpreter is available; the primary path is
 * `analyzePythonFilesViaAst` (real stdlib `ast` via a subprocess JSON bridge).
 */
export function analyzePythonFiles(root: string, files: string[]): PyFileAnalysis[] {
  const results: PyFileAnalysis[] = [];
  for (const rel of files) {
    if (!rel.endsWith('.py')) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const source = readFileSync(abs, 'utf8');
    const imports = [...source.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? '').filter(Boolean);
    const functions = [...source.matchAll(DEF_RE)].map((m) => m[1]!);
    const classes = [...source.matchAll(CLASS_RE)].map((m) => m[1]!);
    const pytestFns = [...source.matchAll(PYTEST_RE)].map((m) => m[1]!);
    const callTargets = new Set<string>();
    for (const m of source.matchAll(CALL_RE)) {
      const name = m[1]!;
      if (!['def', 'class', 'if', 'for', 'while', 'with', 'return', 'print'].includes(name)) {
        callTargets.add(name);
      }
    }
    const resolvedImports = imports.map((specifier) => ({
      specifier,
      resolvedPath: resolvePythonImport(root, rel, specifier),
    }));
    results.push({
      file: rel,
      imports,
      resolvedImports,
      functions,
      classes,
      callTargets: [...callTargets],
      isPytest: pytestFns.length > 0 || rel.startsWith('tests/') || rel.includes('/test_'),
    });
  }
  return results;
}

/**
 * Embedded Python script: parse each file with the stdlib `ast` module and
 * emit a JSON map { absPath: { imports, functions, classes, calls, pytest } }.
 * Real grammar/parser, not regex — handles async def, nested defs, relative
 * imports (`from . import x`), aliased imports, and call expressions.
 */
const PY_AST_SCRIPT = `
import ast, json, sys

def analyze(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            src = f.read()
        tree = ast.parse(src)
    except Exception as e:
        return {"error": str(e), "imports": [], "functions": [], "classes": [], "calls": [], "pytest": 0}
    imports = []
    functions = []
    classes = []
    calls = set()
    pytest = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                imports.append(a.name)
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            imports.append("." * node.level + mod)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(node.name)
            if node.name.startswith("test_"):
                pytest = 1
        elif isinstance(node, ast.ClassDef):
            classes.append(node.name)
        elif isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Name):
                calls.add(f.id)
            elif isinstance(f, ast.Attribute):
                calls.add(f.attr)
    return {"imports": imports, "functions": functions, "classes": classes, "calls": sorted(calls), "pytest": pytest}

out = {}
for p in sys.argv[1:]:
    out[p] = analyze(p)
json.dump(out, sys.stdout)
`;

const execFileAsync = promisify(execFile);

/** Cached Python interpreter discovery: undefined = not probed yet. */
let pythonPath: string | null | undefined;

async function findPython(): Promise<string | null> {
  if (pythonPath !== undefined) return pythonPath;
  const candidates = process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python'];
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ['--version'], { timeout: 5000 });
      pythonPath = bin;
      return bin;
    } catch {
      // try next candidate
    }
  }
  pythonPath = null;
  return null;
}

/**
 * Real Python AST analysis via a subprocess JSON bridge (stdlib `ast`).
 * Returns `null` when no Python interpreter is available, so callers can
 * fall back to the regex analyzer.
 */
export async function analyzePythonFilesViaAst(
  root: string,
  files: string[],
): Promise<PyFileAnalysis[] | null> {
  const py = files.filter((f) => f.endsWith('.py'));
  if (py.length === 0) return [];
  const bin = await findPython();
  if (!bin) return null;
  const args = ['-c', PY_AST_SCRIPT, ...py.map((f) => join(root, f))];
  const { stdout } = await execFileAsync(bin, args, {
    timeout: 20000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const raw = JSON.parse(stdout) as Record<string, { error?: string; imports?: string[]; functions?: string[]; classes?: string[]; calls?: string[]; pytest?: number }>;
  const results: PyFileAnalysis[] = [];
  for (const rel of py) {
    const info = raw[join(root, rel)];
    if (!info || info.error) continue;
    const imports = info.imports ?? [];
    results.push({
      file: rel,
      imports,
      resolvedImports: imports.map((specifier) => ({
        specifier,
        resolvedPath: resolvePythonImport(root, rel, specifier),
      })),
      functions: info.functions ?? [],
      classes: info.classes ?? [],
      callTargets: info.calls ?? [],
      isPytest: info.pytest === 1 || rel.startsWith('tests/') || rel.includes('/test_'),
    });
  }
  return results;
}

/**
 * Preferred entry point: real AST when a Python interpreter exists, regex
 * fallback otherwise. The fallback is weaker — surface it instead of failing
 * silently, or operators cannot tell AST-accurate results from regex guesses.
 */
export async function analyzePythonFilesAsync(
  root: string,
  files: string[],
): Promise<PyFileAnalysis[]> {
  try {
    const viaAst = await analyzePythonFilesViaAst(root, files);
    if (viaAst) return viaAst;
    if (files.length > 0 && (await findPython()) === null) {
      console.warn(
        '[proofloop] No Python interpreter found — falling back to regex-based Python import analysis (less accurate).',
      );
    }
  } catch (err) {
    console.warn(
      `[proofloop] Python AST bridge failed (${err instanceof Error ? err.message : String(err)}); falling back to regex-based import analysis.`,
    );
  }
  return analyzePythonFiles(root, files);
}

function resolvePythonImport(repoRoot: string, fromFile: string, specifier: string): string | null {
  // Only resolve relative-looking dotted packages under the repo (best-effort).
  if (!specifier || specifier.startsWith('.')) {
    // relative: from .foo import / from ..bar
    const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
    const rest = specifier.replace(/^\.+/, '').replace(/\./g, sep);
    let dir = dirname(join(repoRoot, fromFile));
    for (let i = 1; i < dots; i++) dir = dirname(dir);
    const base = rest ? join(dir, rest) : dir;
    return existingPy(repoRoot, base);
  }
  const parts = specifier.split('.');
  const candidates = [
    join(repoRoot, ...parts) + '.py',
    join(repoRoot, ...parts, '__init__.py'),
    join(repoRoot, 'src', ...parts) + '.py',
    join(repoRoot, 'src', ...parts, '__init__.py'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return toPosix(relative(repoRoot, c));
  }
  return null;
}

function existingPy(repoRoot: string, base: string): string | null {
  const candidates = [base + '.py', join(base, '__init__.py')];
  for (const c of candidates) {
    if (existsSync(c)) return toPosix(relative(repoRoot, c));
  }
  return null;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}
