import { z } from 'zod';

export const IntentOutputSchema = z.object({
  summary: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  confidence: z.enum(['low', 'medium', 'high']),
  facts: z.array(z.string()).default([]),
  inferences: z.array(z.string()).default([]),
  suggestions: z.array(z.string()).default([]),
});

export const ClaimsOutputSchema = z.object({
  claims: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      category: z.enum([
        'functional',
        'compatibility',
        'security',
        'performance',
        'architecture',
        'data',
        'ux',
      ]),
      source: z.enum(['pr_description', 'issue', 'diff_inference', 'rule']),
      confidence: z.enum(['low', 'medium', 'high']),
      riskWeight: z.number().min(0).max(100),
      relatedFiles: z.array(z.string()),
      relatedSymbols: z.array(z.string()).default([]),
    }),
  ),
});

export const VerificationPlanSchema = z.object({
  steps: z.array(
    z.object({
      type: z.enum([
        'lint',
        'typecheck',
        'unit_test',
        'integration_test',
        'build',
        'security_scan',
        'custom',
        'manual',
      ]),
      command: z.string().optional(),
      reason: z.string(),
      relatedClaimTitles: z.array(z.string()).default([]),
    }),
  ),
});

export const ExplanationOutputSchema = z.object({
  claims: z.array(
    z.object({
      claimTitle: z.string(),
      facts: z.array(z.string()),
      evidence: z.array(z.string()),
      unknowns: z.array(z.string()),
      humanSuggestions: z.array(z.string()),
    }),
  ),
});

export type IntentOutput = z.infer<typeof IntentOutputSchema>;
export type ClaimsOutput = z.infer<typeof ClaimsOutputSchema>;
export type VerificationPlan = z.infer<typeof VerificationPlanSchema>;
export type ExplanationOutput = z.infer<typeof ExplanationOutputSchema>;
