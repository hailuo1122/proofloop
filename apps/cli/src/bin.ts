#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { checkCommand } from './commands/check.js';
import { explainCommand } from './commands/explain.js';
import { reportCommand } from './commands/report.js';
import { confirmCommand } from './commands/confirm.js';

const program = new Command();
program
  .name('proofloop')
  .description('Evidence-first AI code change verification')
  .version('0.1.0');

program
  .command('init')
  .description('Detect project and write proofloop.yml draft')
  .option('--force', 'Overwrite existing proofloop.yml', false)
  .option(
    '--profile <name>',
    'adopt (advisory) | standard (blocking) | strict',
    'standard',
  )
  .option('--cwd <path>', 'Working directory', process.cwd())
  .action(async (opts) => {
    const code = await initCommand(opts);
    process.exitCode = code;
  });

program
  .command('check')
  .description('Analyze diff, run verifications, write Evidence Pack')
  .option('--base <ref>', 'Base git ref')
  .option('--head <ref>', 'Head git ref', 'HEAD')
  .option('--pr <body>', 'PR description text')
  .option('--json', 'Print evidence JSON to stdout', false)
  .option('--markdown', 'Print markdown report to stdout', false)
  .option('--fail-on <level>', 'failed|blocked|unknown-high', 'blocked')
  .option('--no-llm', 'Disable LLM', false)
  .option('--cwd <path>', 'Working directory', process.cwd())
  .action(async (opts) => {
    const code = await checkCommand(opts);
    process.exitCode = code;
  });

program
  .command('explain')
  .description('Explain claims from an Evidence Pack')
  .argument('<runId>', 'Run id')
  .option('--cwd <path>', 'Working directory', process.cwd())
  .action(async (runId, opts) => {
    const code = await explainCommand(runId, opts);
    process.exitCode = code;
  });

program
  .command('report')
  .description('Print stored report for a run')
  .argument('<runId>', 'Run id')
  .option('--format <fmt>', 'markdown|json', 'markdown')
  .option('--cwd <path>', 'Working directory', process.cwd())
  .action(async (runId, opts) => {
    const code = await reportCommand(runId, opts);
    process.exitCode = code;
  });

program
  .command('confirm')
  .description('Record human review for a claim (manual verification)')
  .argument('<runId>', 'Run id')
  .argument('<claimId>', 'Claim id')
  .option('--accept', 'Accept claim with human confirmation', false)
  .option('--reject', 'Reject claim', false)
  .option('--note <text>', 'Review note (required)')
  .option('--reviewer <name>', 'Reviewer identity (required)')
  .option('--cwd <path>', 'Working directory', process.cwd())
  .action(async (runId, claimId, opts) => {
    const code = await confirmCommand(runId, claimId, opts);
    process.exitCode = code;
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
});
