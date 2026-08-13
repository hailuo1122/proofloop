export interface CommandPolicyResult {
  allowed: boolean;
  safeCommand: boolean;
  reason: string;
  matchedRule?: string;
}

const DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\b/i, reason: 'Destructive rm is blocked' },
  { pattern: /\bdel\b/i, reason: 'Destructive del is blocked' },
  { pattern: /\brmdir\b/i, reason: 'Destructive rmdir is blocked' },
  { pattern: /\bRemove-Item\b/i, reason: 'PowerShell Remove-Item is blocked' },
  { pattern: /\bsudo\b/i, reason: 'sudo is blocked' },
  { pattern: /\bpowershell\b/i, reason: 'powershell is blocked by default' },
  { pattern: /\bpwsh\b/i, reason: 'pwsh is blocked by default' },
  { pattern: /\bcmd\s+\/c\b/i, reason: 'cmd /c is blocked by default' },
  { pattern: /\bchmod\b.*\s(-R|recursive)/i, reason: 'Broad chmod is blocked' },
  { pattern: /\bkubectl\s+(apply|delete)\b/i, reason: 'kubectl apply/delete is blocked' },
  { pattern: /\bterraform\s+apply\b/i, reason: 'terraform apply is blocked' },
  { pattern: /\bdocker\s+push\b/i, reason: 'docker push is blocked' },
  { pattern: /\bgit\s+push\b/i, reason: 'git push is blocked' },
  { pattern: /\bcurl\b/i, reason: 'Network curl is blocked by default' },
  { pattern: /\bwget\b/i, reason: 'wget is blocked by default' },
  { pattern: /\bInvoke-WebRequest\b/i, reason: 'Invoke-WebRequest is blocked by default' },
  { pattern: /\b(sendmail|mailx|aws\s+ses)\b/i, reason: 'Email sending is blocked' },
  {
    pattern: /\b(prisma|drizzle-kit|knex|flyway|liquibase).*(migrate|push)\b/i,
    reason: 'Production DB migrations are blocked',
  },
  { pattern: /\bmigrate\s+(up|apply|deploy)\b/i, reason: 'DB migrate deploy is blocked' },
  { pattern: />\s*\/dev\/sd/i, reason: 'Disk device writes are blocked' },
  // Shell chaining / substitution — never allow via prefix matching
  { pattern: /[;&|`$]/, reason: 'Shell metacharacters are blocked' },
  { pattern: /\n|\r/, reason: 'Multiline commands are blocked' },
  { pattern: />\s*[^\s]/, reason: 'Output redirection is blocked' },
  { pattern: /<\s*[^\s]/, reason: 'Input redirection is blocked' },
];

const ALLOW_PREFIXES = [
  'npm run lint',
  'npm run typecheck',
  'npm test',
  'npm run test',
  'npm run build',
  'pnpm lint',
  'pnpm typecheck',
  'pnpm test',
  'pnpm build',
  'pnpm run lint',
  'pnpm run typecheck',
  'pnpm run test',
  'pnpm run build',
  'yarn lint',
  'yarn typecheck',
  'yarn test',
  'yarn build',
  'npx tsc',
  'npx eslint',
  'npx vitest',
  'npx jest',
  'python -m pytest',
  'python -m ruff',
  'python -m mypy',
  'pytest',
  'ruff',
  'mypy',
  'pip check',
  'poetry run pytest',
  'poetry run ruff',
  'poetry run mypy',
];

/** Normalize whitespace so tabs/multi-space cannot bypass exact/prefix checks. */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

export function evaluateCommand(
  command: string,
  opts?: { declaredSafeCommands?: string[]; allowNetwork?: boolean },
): CommandPolicyResult {
  const trimmed = normalizeCommand(command);
  if (!trimmed) {
    return { allowed: false, safeCommand: false, reason: 'Empty command', matchedRule: 'empty' };
  }

  for (const deny of DENY_PATTERNS) {
    if (deny.pattern.test(trimmed)) {
      if (opts?.allowNetwork && /\b(curl|wget|Invoke-WebRequest)\b/i.test(trimmed)) {
        // still block if other metacharacters present
        if (/[;&|`$]/.test(trimmed) || /\n|\r/.test(trimmed)) {
          return {
            allowed: false,
            safeCommand: false,
            reason: 'Shell metacharacters are blocked',
            matchedRule: 'shell_meta',
          };
        }
        continue;
      }
      return {
        allowed: false,
        safeCommand: false,
        reason: deny.reason,
        matchedRule: deny.pattern.source,
      };
    }
  }

  const declared = opts?.declaredSafeCommands ?? [];
  if (declared.some((c) => normalizeCommand(c) === trimmed)) {
    // Declared commands still cannot contain shell metacharacters.
    if (/[;&|`$]/.test(trimmed) || /\n|\r/.test(trimmed)) {
      return {
        allowed: false,
        safeCommand: false,
        reason: 'Declared commands cannot include shell metacharacters',
        matchedRule: 'declared_meta',
      };
    }
    return {
      allowed: true,
      safeCommand: true,
      reason: 'Explicitly declared in proofloop.yml',
      matchedRule: 'declared',
    };
  }

  const lower = trimmed.toLowerCase();
  if (ALLOW_PREFIXES.some((p) => lower === p || lower.startsWith(`${p} `))) {
    return {
      allowed: true,
      safeCommand: true,
      reason: 'Matches default read-only/verify allowlist',
      matchedRule: 'default_allow',
    };
  }

  // Package manager install/check can run postinstall scripts — require explicit declare.
  if (/^(pnpm|npm|yarn)\s+(install|ci|check)\b/i.test(trimmed)) {
    return {
      allowed: false,
      safeCommand: false,
      reason:
        'Package install/ci/check must be declared in proofloop.yml (postinstall may execute arbitrary code)',
      matchedRule: 'pm_install_undeclared',
    };
  }

  return {
    allowed: false,
    safeCommand: false,
    reason:
      'Command is not on the allowlist and not declared in proofloop.yml; configure it explicitly if needed',
    matchedRule: 'unknown_command',
  };
}
