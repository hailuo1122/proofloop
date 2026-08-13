const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: 'authorization',
    regex: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._\-+/=]+/gi,
  },
  {
    name: 'cookie',
    regex: /((?:Set-)?Cookie:\s*)[^\r\n]+/gi,
  },
  {
    name: 'password',
    regex: /(password|passwd|pwd)\s*[:=]\s*["']?[^"'\\\s]+["']?/gi,
  },
  {
    name: 'token',
    regex: /(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|token)\s*[:=]\s*["']?[^"'\\\s]+["']?/gi,
  },
  {
    name: 'aws_key',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  {
    name: 'private_key',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    name: 'github_pat',
    regex: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: 'github_fine_grained',
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: 'openai_key',
    // sk-… including sk-proj-… (hyphenated segments)
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'gitlab_pat',
    regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
];

export function redactSecrets(input: string): { text: string; redacted: boolean } {
  let text = input;
  let redacted = false;
  for (const p of PATTERNS) {
    const next = text.replace(p.regex, (match, g1) => {
      redacted = true;
      if (typeof g1 === 'string' && match.startsWith(g1)) {
        return `${g1}[REDACTED]`;
      }
      return '[REDACTED]';
    });
    text = next;
  }
  return { text, redacted };
}

export function summarizeLog(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  // Reserve room for the truncation notice, then split the remaining budget
  // between head and tail so the output never exceeds maxChars.
  const notice = `\n...\n[truncated ${text.length - maxChars} chars]\n...\n`;
  const remaining = Math.max(0, maxChars - notice.length);
  const headLen = Math.floor(remaining * 0.75);
  const tailLen = remaining - headLen;
  return `${text.slice(0, headLen)}${notice}${text.slice(-tailLen)}`;
}
