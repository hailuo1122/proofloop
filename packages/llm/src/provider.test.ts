import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenAICompatibleProvider, type OpenAICompatibleConfig } from './provider.js';
import { IntentOutputSchema } from './schemas.js';

const cfg: OpenAICompatibleConfig = {
  apiKey: 'sk-test-secret-123',
  baseUrl: 'https://llm.test/v1',
  model: 'test-model',
};

function okResponse(content: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }),
  };
}

const validIntent = {
  summary: 'Add login',
  assumptions: [],
  confidence: 'low',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LLM schemas', () => {
  it('rejects unverified free text shapes', () => {
    expect(() => IntentOutputSchema.parse({ summary: 1 })).toThrow();
    expect(
      IntentOutputSchema.parse({
        summary: 'ok',
        assumptions: [],
        confidence: 'low',
      }).summary,
    ).toBe('ok');
  });
});

describe('OpenAICompatibleProvider', () => {
  it('parses a valid response through the schema', async () => {
    const fetchMock = vi.fn(async () => okResponse(validIntent));
    vi.stubGlobal('fetch', fetchMock);
    const provider = createOpenAICompatibleProvider(cfg);
    const out = await provider.generateIntent({ files: [{ path: 'a.ts', status: 'added' }] });
    expect(IntentOutputSchema.parse(out).summary).toBe('Add login');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once after a transient HTTP failure and succeeds', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 502, json: async () => ({}) };
        return okResponse(validIntent);
      }),
    );
    const provider = createOpenAICompatibleProvider(cfg);
    const out = await provider.generateIntent({ files: [] });
    expect(out.summary).toBe('Add login');
  });

  it('surfaces persistent HTTP failures as llm_http_*, not llm_schema_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    const provider = createOpenAICompatibleProvider(cfg);
    await expect(provider.generateIntent({ files: [] })).rejects.toThrow(/llm_http_500/);
  });

  it('reports llm_schema_error only when the model answers off-schema twice', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return okResponse({ totally: 'wrong' });
      }),
    );
    const provider = createOpenAICompatibleProvider(cfg);
    await expect(provider.generateIntent({ files: [] })).rejects.toThrow('llm_schema_error');
    expect(calls).toBe(2);
  });

  it('redacts the API key from fetch failure messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`connect ECONNREFUSED with key ${cfg.apiKey} leaked`);
      }),
    );
    const provider = createOpenAICompatibleProvider(cfg);
    const err = await provider.generateIntent({ files: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('[REDACTED_API_KEY]');
    expect((err as Error).message).not.toContain(cfg.apiKey);
  });
});
