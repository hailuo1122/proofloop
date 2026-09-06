import { basename, dirname } from 'node:path';
import { runCheckPipeline } from '@proofloop/evidence';
import { createOpenAICompatibleProvider } from '@proofloop/llm';
import { renderMarkdownReport } from '@proofloop/evidence';

export async function checkCommand(opts: {
  base?: string;
  head?: string;
  pr?: string;
  json?: boolean;
  markdown?: boolean;
  failOn?: string;
  noLlm?: boolean;
  llm?: boolean;
  cwd: string;
}): Promise<number> {
  try {
    const noLlm = opts.noLlm || opts.llm === false || !process.env.LLM_API_KEY;
    const llm =
      !noLlm && process.env.LLM_API_KEY
        ? createOpenAICompatibleProvider({
            apiKey: process.env.LLM_API_KEY,
            baseUrl: process.env.LLM_BASE_URL,
            model: process.env.LLM_MODEL,
          })
        : undefined;

    const { pack, evidencePath, reportPath } = await runCheckPipeline({
      cwd: opts.cwd,
      base: opts.base,
      head: opts.head,
      prBody: opts.pr,
      repositoryName: `${basename(dirname(opts.cwd))}/${basename(opts.cwd)}`,
      noLlm,
      onPhase: (phase, detail) => {
        process.stderr.write(`[${phase}]${detail ? ` ${detail}` : ''}\n`);
      },
      llm: llm
        ? {
            generateIntent: (input) =>
              llm.generateIntent(input as Parameters<typeof llm.generateIntent>[0]),
            generateClaims: (input) =>
              llm.generateClaims(input as Parameters<typeof llm.generateClaims>[0]),
          }
        : undefined,
    });

    process.stderr.write(`Evidence: ${evidencePath}\n`);
    process.stderr.write(`Report:   ${reportPath}\n`);
    process.stderr.write(
      `Overall:  ${pack.run.overallStatus} | merge=${pack.mergeGate?.allowMerge ? 'yes' : 'no'}${
        pack.mergeGate?.mode ? ` | mode=${pack.mergeGate.mode}` : ''
      }${pack.mergeGate?.advisoryWouldBlock ? ' (would block if blocking)' : ''}\n`,
    );
    const next = pack.nextActions ?? [];
    if (next.length) {
      process.stderr.write('Next:\n');
      for (const a of next.slice(0, 5)) {
        process.stderr.write(`  - [${a.kind}] ${a.title}\n`);
        if (a.command) process.stderr.write(`      ${a.command}\n`);
      }
    }

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(pack, null, 2)}\n`);
    } else if (opts.markdown) {
      process.stdout.write(renderMarkdownReport(pack));
    } else {
      for (const c of pack.claims) {
        process.stdout.write(`- [${c.status}] ${c.title}\n`);
      }
    }

    const failOn = opts.failOn ?? 'blocked';
    const status = pack.run.overallStatus;
    const mode = pack.mergeGate?.mode ?? pack.policies?.mode ?? 'blocking';

    // Hard failures always fail the process (even in advisory).
    if (status === 'critical_blocked' || status === 'high_blocked' || status === 'failed') {
      return 1;
    }
    // Advisory: missing evidence is reported but does not fail the CLI.
    if (mode === 'advisory') {
      return 0;
    }
    if (failOn === 'unknown-high' && status === 'unknown_high_risk') return 1;
    if (failOn === 'blocked' && status === 'unknown_high_risk') return 1;
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }
}
