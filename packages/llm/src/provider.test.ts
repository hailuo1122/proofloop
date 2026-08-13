import { describe, expect, it } from 'vitest';
import { IntentOutputSchema } from './schemas.js';

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
