import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProject } from './project-detector.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

describe('detectProject', () => {
  it('detects typescript demo-repo', () => {
    const result = detectProject(join(fixtures, 'demo-repo'));
    expect(result.language).toBe('typescript');
    expect(result.commands.unit || result.commands.lint || result.commands.typecheck).toBeTruthy();
  });

  it('detects python demo fixture', () => {
    const result = detectProject(join(fixtures, 'demo-python'));
    expect(result.language).toBe('python');
    expect(result.commands.unit).toMatch(/pytest/);
    expect(result.unknowns.every((u) => typeof u === 'string')).toBe(true);
  });
});
