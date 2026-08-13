import {
  ClaimsOutputSchema,
  ExplanationOutputSchema,
  IntentOutputSchema,
  VerificationPlanSchema,
  type ClaimsOutput,
  type ExplanationOutput,
  type IntentOutput,
  type VerificationPlan,
} from './schemas.js';

export interface IntentInput {
  prBody?: string;
  files: Array<{ path: string; status: string }>;
  rules?: string[];
  testDirs?: string[];
}

export interface ClaimsInput {
  intentSummary: string;
  files: Array<{ path: string; status: string }>;
  symbols?: string[];
  rules?: string[];
}

export interface VerificationSelectionInput {
  claims: Array<{ title: string; category: string }>;
  availableCommands: Record<string, string | undefined>;
}

export interface EvidenceExplanationInput {
  claims: Array<{ title: string; status: string; relatedFiles: string[] }>;
  verifications: Array<{ id: string; command: string; status: string; resultSummary: string }>;
}

export interface LlmProvider {
  generateIntent(input: IntentInput): Promise<IntentOutput>;
  generateClaims(input: ClaimsInput): Promise<ClaimsOutput>;
  selectVerifications(input: VerificationSelectionInput): Promise<VerificationPlan>;
  explainEvidence(input: EvidenceExplanationInput): Promise<ExplanationOutput>;
}

const SYSTEM = `You are ProofLoop's structured analyst.
Rules:
- Never invent files, commands, test results, or environments.
- Use unknown when the input is insufficient.
- Separate facts, inferences, and suggestions.
- Every claim needs source and relatedFiles.
- "Code looks reasonable" is NOT evidence.
- Return JSON only matching the requested schema.`;

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

async function chatJson(cfg: OpenAICompatibleConfig, user: string): Promise<unknown> {
  const base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model ?? 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`llm_http_${res.status}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('llm_empty');
  return JSON.parse(content);
}

async function withSchemaRetry<T>(
  parse: (raw: unknown) => T,
  invoke: () => Promise<unknown>,
): Promise<T> {
  try {
    return parse(await invoke());
  } catch (first) {
    try {
      return parse(await invoke());
    } catch {
      const err = new Error('llm_schema_error');
      (err as Error & { cause?: unknown }).cause = first;
      throw err;
    }
  }
}

export function createOpenAICompatibleProvider(cfg: OpenAICompatibleConfig): LlmProvider {
  return {
    async generateIntent(input) {
      return withSchemaRetry(
        (raw) => IntentOutputSchema.parse(raw),
        () =>
          chatJson(
            cfg,
            `Extract change intent as JSON {summary,assumptions,confidence,facts,inferences,suggestions}. Input: ${JSON.stringify(input)}`,
          ),
      );
    },
    async generateClaims(input) {
      return withSchemaRetry(
        (raw) => ClaimsOutputSchema.parse(raw),
        () =>
          chatJson(
            cfg,
            `Generate claims JSON {claims:[...]}. Do not mark verified. Input: ${JSON.stringify(input)}`,
          ),
      );
    },
    async selectVerifications(input) {
      return withSchemaRetry(
        (raw) => VerificationPlanSchema.parse(raw),
        () =>
          chatJson(
            cfg,
            `Select verifications JSON {steps:[...]}. Only suggest available commands. Input: ${JSON.stringify(input)}`,
          ),
      );
    },
    async explainEvidence(input) {
      return withSchemaRetry(
        (raw) => ExplanationOutputSchema.parse(raw),
        () =>
          chatJson(
            cfg,
            `Explain evidence JSON {claims:[{claimTitle,facts,evidence,unknowns,humanSuggestions}]}. Input: ${JSON.stringify(input)}`,
          ),
      );
    },
  };
}

export function createDisabledLlmProvider(): LlmProvider {
  return {
    async generateIntent() {
      throw new Error('llm_disabled');
    },
    async generateClaims() {
      throw new Error('llm_disabled');
    },
    async selectVerifications() {
      throw new Error('llm_disabled');
    },
    async explainEvidence() {
      throw new Error('llm_disabled');
    },
  };
}
