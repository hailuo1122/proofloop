import { describe, expect, it } from 'vitest';
import { parseCoverageJson, parseJUnitXml, parseSarif } from './parsers.js';

describe('artifact parsers', () => {
  it('parses junit failures', () => {
    const xml = `<testsuite tests="3" failures="1" errors="0" skipped="0"></testsuite>`;
    const parsed = parseJUnitXml(xml);
    expect(parsed.failures).toBe(1);
    expect(parsed.summary).toContain('failures=1');
  });

  it('parses istanbul coverage summary', () => {
    const parsed = parseCoverageJson(JSON.stringify({ total: { lines: { pct: 81.5 } } }));
    expect(parsed.summary).toContain('81.5');
  });

  it('parses sarif result count', () => {
    const parsed = parseSarif(JSON.stringify({ runs: [{ results: [{}, {}] }] }));
    expect(parsed.summary).toContain('2');
  });
});
