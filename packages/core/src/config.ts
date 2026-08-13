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
  return ProofloopConfigSchema.parse(raw ?? {});
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
