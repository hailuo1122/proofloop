import { describe, expect, it } from 'vitest';
import { parseNameStatus } from './diff.js';

describe('parseNameStatus', () => {
  it('identifies added modified deleted and renamed files', () => {
    const output = [
      'A\tsrc/new.ts',
      'M\tsrc/auth/session.ts',
      'D\tsrc/old.ts',
      'R100\tsrc/a.ts\tsrc/b.ts',
    ].join('\n');
    const files = parseNameStatus(output);
    expect(files).toEqual([
      { status: 'added', path: 'src/new.ts' },
      { status: 'modified', path: 'src/auth/session.ts' },
      { status: 'deleted', path: 'src/old.ts' },
      { status: 'renamed', oldPath: 'src/a.ts', path: 'src/b.ts', score: 100 },
    ]);
  });
});
