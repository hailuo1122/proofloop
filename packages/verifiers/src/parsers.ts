export interface ParsedSuiteSummary {
  tests?: number;
  failures?: number;
  errors?: number;
  skipped?: number;
  format: 'junit' | 'coverage' | 'sarif' | 'unknown';
  summary: string;
}

export function parseJUnitXml(xml: string): ParsedSuiteSummary {
  const tests = Number(/tests="(\d+)"/.exec(xml)?.[1] ?? NaN);
  const failures = Number(/failures="(\d+)"/.exec(xml)?.[1] ?? NaN);
  const errors = Number(/errors="(\d+)"/.exec(xml)?.[1] ?? NaN);
  const skipped = Number(/skipped="(\d+)"/.exec(xml)?.[1] ?? NaN);
  return {
    tests: Number.isFinite(tests) ? tests : undefined,
    failures: Number.isFinite(failures) ? failures : undefined,
    errors: Number.isFinite(errors) ? errors : undefined,
    skipped: Number.isFinite(skipped) ? skipped : undefined,
    format: 'junit',
    summary: `JUnit tests=${tests || '?'} failures=${failures || 0} errors=${errors || 0}`,
  };
}

export function parseCoverageJson(raw: string): ParsedSuiteSummary {
  try {
    const data = JSON.parse(raw) as { total?: { lines?: { pct?: number } } };
    const pct = data.total?.lines?.pct;
    return {
      format: 'coverage',
      summary: pct != null ? `Line coverage ${pct}%` : 'Coverage JSON parsed (no total.lines.pct)',
    };
  } catch {
    return { format: 'unknown', summary: 'Invalid coverage JSON' };
  }
}

export function parseSarif(raw: string): ParsedSuiteSummary {
  try {
    const data = JSON.parse(raw) as { runs?: Array<{ results?: unknown[] }> };
    const count = data.runs?.reduce((n, r) => n + (r.results?.length ?? 0), 0) ?? 0;
    return { format: 'sarif', summary: `SARIF findings: ${count}` };
  } catch {
    return { format: 'unknown', summary: 'Invalid SARIF' };
  }
}
