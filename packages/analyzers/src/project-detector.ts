import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Confidence } from '@proofloop/core';

export interface DetectedCommands {
  lint?: string;
  typecheck?: string;
  unit?: string;
  integration?: string;
  build?: string;
  security?: string;
}

export interface ProjectDetection {
  language: 'typescript' | 'python' | 'unknown';
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'pip' | 'poetry';
  commands: DetectedCommands;
  confidence: Confidence;
  evidence: string[];
  unknowns: string[];
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasFile(root: string, rel: string): boolean {
  return existsSync(join(root, rel));
}

export function detectProject(root: string): ProjectDetection {
  const evidence: string[] = [];
  const unknowns: string[] = [];
  const commands: DetectedCommands = {};

  const pkgPath = join(root, 'package.json');
  const isTs =
    hasFile(root, 'package.json') ||
    hasFile(root, 'tsconfig.json') ||
    hasFile(root, 'pnpm-lock.yaml');
  const isPy =
    hasFile(root, 'pyproject.toml') ||
    hasFile(root, 'requirements.txt') ||
    hasFile(root, 'pytest.ini') ||
    hasFile(root, 'setup.py');

  if (isTs && !isPy) {
    evidence.push('Detected Node/TypeScript manifests');
    let packageManager: ProjectDetection['packageManager'] = 'npm';
    if (hasFile(root, 'pnpm-lock.yaml') || hasFile(root, 'pnpm-workspace.yaml')) {
      packageManager = 'pnpm';
      evidence.push('pnpm lock/workspace present');
    } else if (hasFile(root, 'yarn.lock')) {
      packageManager = 'yarn';
      evidence.push('yarn.lock present');
    } else if (hasFile(root, 'package-lock.json')) {
      packageManager = 'npm';
      evidence.push('package-lock.json present');
    }

    const pkg = readJson(pkgPath);
    const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
    const run = (name: string) => {
      if (packageManager === 'pnpm') return `pnpm ${name}`;
      if (packageManager === 'yarn') return `yarn ${name}`;
      return `npm run ${name}`;
    };

    if (scripts.lint) {
      commands.lint = run('lint');
      evidence.push('script:lint');
    } else {
      unknowns.push('lint command not detected; set commands.lint in proofloop.yml');
    }
    if (scripts.typecheck) {
      commands.typecheck = run('typecheck');
      evidence.push('script:typecheck');
    } else if (hasFile(root, 'tsconfig.json')) {
      commands.typecheck = 'npx tsc --noEmit';
      evidence.push('tsconfig.json -> npx tsc --noEmit');
    } else {
      unknowns.push('typecheck command not detected');
    }
    if (scripts.test) {
      const testScript = scripts.test;
      commands.unit =
        packageManager === 'pnpm'
          ? testScript.includes('vitest')
            ? 'pnpm test -- --run'
            : 'pnpm test'
          : run('test');
      evidence.push('script:test');
    } else {
      unknowns.push('unit test command not detected');
    }
    if (scripts.build) {
      commands.build = run('build');
      evidence.push('script:build');
    }

    return {
      language: 'typescript',
      packageManager,
      commands,
      confidence: unknowns.length ? 'medium' : 'high',
      evidence,
      unknowns,
    };
  }

  if (isPy) {
    evidence.push('Detected Python manifests');
    const packageManager: ProjectDetection['packageManager'] = hasFile(root, 'pyproject.toml')
      ? 'poetry'
      : 'pip';
    if (hasFile(root, 'pytest.ini') || hasFile(root, 'pyproject.toml') || hasFile(root, 'tests')) {
      commands.unit = packageManager === 'poetry' ? 'poetry run pytest' : 'python -m pytest';
      evidence.push('pytest detected');
    } else {
      unknowns.push('pytest command not detected');
    }
    if (hasFile(root, 'pyproject.toml') || hasFile(root, 'ruff.toml')) {
      commands.lint = packageManager === 'poetry' ? 'poetry run ruff check .' : 'ruff check .';
      evidence.push('ruff candidate');
    } else {
      unknowns.push('lint command not detected for Python');
    }
    if (hasFile(root, 'mypy.ini') || hasFile(root, 'pyproject.toml')) {
      commands.typecheck = packageManager === 'poetry' ? 'poetry run mypy .' : 'mypy .';
    } else {
      unknowns.push('typecheck command not detected for Python');
    }
    return {
      language: 'python',
      packageManager,
      commands,
      confidence: unknowns.length ? 'medium' : 'high',
      evidence,
      unknowns,
    };
  }

  return {
    language: 'unknown',
    commands: {},
    confidence: 'low',
    evidence: [],
    unknowns: ['Unable to detect project language; configure proofloop.yml'],
  };
}
