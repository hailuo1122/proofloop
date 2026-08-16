import { z } from 'zod';

export const ProofloopConfigSchema = z.object({
  project: z
    .object({
      language: z.enum(['typescript', 'python']).optional(),
      packageManager: z.enum(['npm', 'pnpm', 'yarn', 'pip', 'poetry']).optional(),
    })
    .default({}),
  commands: z
    .object({
      lint: z.string().optional(),
      typecheck: z.string().optional(),
      unit: z.string().optional(),
      integration: z.string().optional(),
      build: z.string().optional(),
      security: z.string().optional(),
    })
    .default({}),
  policies: z
    .object({
      blockOn: z.array(z.enum(['critical', 'high', 'medium', 'low'])).default(['critical', 'high']),
      requireDynamicVerificationFor: z
        .array(z.enum(['security', 'data', 'compatibility', 'functional', 'architecture', 'performance', 'ux']))
        .default(['security', 'data', 'compatibility']),
      maxTotalDurationSeconds: z.number().int().positive().default(600),
      allowNetwork: z.boolean().default(false),
    })
    .default({}),
  context: z
    .object({
      include: z.array(z.string()).default(['README.md', 'docs/**/*.md', '.github/**/*.yml']),
      exclude: z.array(z.string()).default(['node_modules/**', 'dist/**', '.env*']),
    })
    .default({}),
  redaction: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
});

export type ProofloopConfig = z.infer<typeof ProofloopConfigSchema>;

export function parseProofloopConfig(raw: unknown): ProofloopConfig {
  // Normalize empty blockOn to the default so explicit blockOn: [] doesn't
  // accidentally unblock merge (see riskBlockedByPolicy).
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const p = (raw as Record<string, unknown>).policies;
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      const b = (p as Record<string, unknown>).blockOn;
      if (Array.isArray(b) && b.length === 0) {
        (p as Record<string, unknown>).blockOn = ['critical', 'high'];
      }
    }
  }

  const result = ProofloopConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw result.error;
  }
  // Warn about unknown keys that will be silently dropped.
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const knownKeys = new Set(Object.keys(ProofloopConfigSchema.shape));
    for (const key of Object.keys(raw)) {
      if (!knownKeys.has(key)) {
        console.warn(`[proofloop] Unknown config key "${key}" will be ignored. Check spelling.`);
      }
    }
  }
  return result.data;
}

export const DEFAULT_PROOFLOOP_YML = `project:
  language: typescript
  packageManager: pnpm
commands:
  lint: pnpm lint
  typecheck: pnpm typecheck
  unit: pnpm test -- --run
  build: pnpm build
policies:
  blockOn:
    - critical
    - high
  requireDynamicVerificationFor:
    - security
    - data
    - compatibility
  maxTotalDurationSeconds: 600
  allowNetwork: false
context:
  include:
    - README.md
    - docs/**/*.md
    - .github/**/*.yml
  exclude:
    - node_modules/**
    - dist/**
    - .env*
redaction:
  enabled: true
`;
