import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvidencePackSchema, renderMarkdownReport } from '@proofloop/evidence';

export async function reportCommand(
  runId: string,
  opts: { cwd: string; format?: string },
): Promise<number> {
  try {
    const dir = join(opts.cwd, '.proofloop', 'runs', runId);
    const evidencePath = join(dir, 'evidence.json');
    if (!existsSync(evidencePath)) {
      console.error(`Evidence pack not found: ${evidencePath}`);
      return 2;
    }
    const pack = EvidencePackSchema.parse(JSON.parse(readFileSync(evidencePath, 'utf8')));
    if (opts.format === 'json') {
      process.stdout.write(`${JSON.stringify(pack, null, 2)}\n`);
    } else {
      const mdPath = join(dir, 'report.md');
      if (existsSync(mdPath)) process.stdout.write(readFileSync(mdPath, 'utf8'));
      else process.stdout.write(renderMarkdownReport(pack));
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }
}
