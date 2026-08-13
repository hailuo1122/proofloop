import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectProject } from '@proofloop/analyzers';
import { DEFAULT_PROOFLOOP_YML } from '@proofloop/core';
import { evaluateCommand } from '@proofloop/security';
import YAML from 'yaml';

export async function initCommand(opts: { force?: boolean; cwd: string }): Promise<number> {
  try {
    const cwd = opts.cwd;
    const out = join(cwd, 'proofloop.yml');
    if (existsSync(out) && !opts.force) {
      console.error('proofloop.yml already exists (pass --force to overwrite)');
      return 2;
    }

    const detection = detectProject(cwd);
    const doc = YAML.parse(DEFAULT_PROOFLOOP_YML) as Record<string, unknown>;
    doc.project = {
      language: detection.language === 'unknown' ? 'typescript' : detection.language,
      packageManager: detection.packageManager ?? 'pnpm',
    };
    doc.commands = {
      lint: detection.commands.lint,
      typecheck: detection.commands.typecheck,
      unit: detection.commands.unit,
      build: detection.commands.build,
      security: detection.commands.security,
    };

    writeFileSync(out, YAML.stringify(doc), 'utf8');
    console.log(`Wrote ${out}`);
    console.log(`Language: ${detection.language} (confidence: ${detection.confidence})`);

    console.log('\nWill run (allowlisted / declared):');
    for (const [k, cmd] of Object.entries(detection.commands)) {
      if (!cmd) continue;
      const policy = evaluateCommand(cmd);
      console.log(`  - ${k}: ${cmd} [${policy.allowed ? 'allowed' : 'blocked'}]`);
    }

    console.log('\nWill NOT run by default:');
    console.log('  - rm/sudo/kubectl apply/terraform apply/git push/docker push/db migrate/curl');
    if (detection.unknowns.length) {
      console.log('\nUnknowns requiring proofloop.yml:');
      for (const u of detection.unknowns) console.log(`  - ${u}`);
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }
}
