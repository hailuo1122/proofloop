import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleGithubWebhook } from './github.js';
import { migrate } from './db/migrate.js';
import { resetDbForTests } from './db/client.js';
import { getGithubInstallation, listGithubInstallations } from './store.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetDbForTests();
});

function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function errorCode(result: { body: Record<string, unknown> }): string {
  const error = result.body.error;
  return error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';
}

describe('handleGithubWebhook signature enforcement', () => {
  it('rejects webhooks when no secret is configured', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const result = await handleGithubWebhook({
      headers: { 'x-github-event': 'pull_request' },
      body: { action: 'opened' },
      rawBody: '{"action":"opened"}',
    });
    expect(result.status).toBe(503);
    expect(errorCode(result)).toBe('webhook_secret_required');
  });

  it('rejects requests with an invalid signature', async () => {
    process.env.GITHUB_WEBHOOK_SECRET = 'sekret';
    const result = await handleGithubWebhook({
      headers: {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=deadbeef',
      },
      body: { action: 'opened' },
      rawBody: '{"action":"opened"}',
    });
    expect(result.status).toBe(401);
    expect(errorCode(result)).toBe('invalid_signature');
  });

  it('verifies against the raw body bytes, not the re-serialized object', async () => {
    process.env.GITHUB_WEBHOOK_SECRET = 'sekret';
    // GitHub signs the exact bytes. Key order / whitespace differences in a
    // re-serialized object must NOT be accepted as valid.
    const rawBody = '{"action":"opened","n":1}';
    const body = JSON.parse(rawBody);
    const reordered = JSON.stringify({ n: 1, action: 'opened' });

    const wrong = await handleGithubWebhook({
      headers: {
        'x-github-event': 'ping',
        'x-hub-signature-256': sign('sekret', reordered),
      },
      body,
      rawBody,
    });
    expect(wrong.status).toBe(401);

    const right = await handleGithubWebhook({
      headers: {
        'x-github-event': 'ping',
        'x-hub-signature-256': sign('sekret', rawBody),
      },
      body,
      rawBody,
    });
    expect(right.status).toBe(200);
    expect(right.body.ignored).toBe(true);
  });

  it('accepts non-pull_request events with a valid signature', async () => {
    process.env.GITHUB_WEBHOOK_SECRET = 'sekret';
    const rawBody = '{"zen":"keep it simple"}';
    const result = await handleGithubWebhook({
      headers: {
        'x-github-event': 'ping',
        'x-hub-signature-256': sign('sekret', rawBody),
      },
      body: JSON.parse(rawBody),
      rawBody,
    });
    expect(result.status).toBe(200);
    expect(result.body.ignored).toBe(true);
  });
});

describe('handleGithubWebhook App lifecycle events', () => {
  const dirs: string[] = [];

  beforeEach(() => {
    resetDbForTests();
    const dir = mkdtempSync(join(tmpdir(), 'pl-gh-'));
    dirs.push(dir);
    process.env.DATABASE_URL = `file:${join(dir, 'test.db')}`;
    process.env.GITHUB_WEBHOOK_SECRET = 'sekret';
    migrate(process.env.DATABASE_URL);
  });

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // Windows may briefly lock the sqlite file
      }
    }
  });

  it('records installation.created and marks deleted installations', async () => {
    const createdRaw = JSON.stringify({
      action: 'created',
      installation: { id: 123, account: { login: 'acme', type: 'Organization', id: 9 } },
    });
    const created = await handleGithubWebhook({
      headers: {
        'x-github-event': 'installation',
        'x-hub-signature-256': sign('sekret', createdRaw),
      },
      body: JSON.parse(createdRaw),
      rawBody: createdRaw,
    });
    expect(created.status).toBe(200);
    expect(created.body.status).toBe('active');
    expect(getGithubInstallation(123)?.accountLogin).toBe('acme');

    const deletedRaw = JSON.stringify({ action: 'deleted', installation: { id: 123 } });
    const deleted = await handleGithubWebhook({
      headers: {
        'x-github-event': 'installation',
        'x-hub-signature-256': sign('sekret', deletedRaw),
      },
      body: JSON.parse(deletedRaw),
      rawBody: deletedRaw,
    });
    expect(deleted.body.status).toBe('deleted');
    expect(getGithubInstallation(123)?.status).toBe('deleted');
  });

  it('records marketplace purchases with plan info', async () => {
    const raw = JSON.stringify({
      action: 'purchased',
      effective_date: '2026-08-13T00:00:00Z',
      marketplace_purchase: {
        plan: { name: 'Team' },
        account: { login: 'acme', type: 'Organization', id: 9 },
      },
      installation: { id: 456 },
    });
    const result = await handleGithubWebhook({
      headers: {
        'x-github-event': 'marketplace_purchase',
        'x-hub-signature-256': sign('sekret', raw),
      },
      body: JSON.parse(raw),
      rawBody: raw,
    });
    expect(result.status).toBe(200);
    expect(result.body.plan).toBe('Team');
    expect(getGithubInstallation(456)?.plan).toBe('Team');
    expect(getGithubInstallation(456)?.status).toBe('active');
  });

  it('queues a check for check_suite rerequested on a configured repo', async () => {
    process.env.PROOFLOOP_AUTO_REGISTER = '1';
    const raw = JSON.stringify({
      action: 'rerequested',
      check_suite: { head_sha: 'a'.repeat(40), head_branch: 'main' },
      repository: {
        name: 'shop',
        owner: { login: 'acme' },
        clone_url: 'https://github.com/acme/shop.git',
        default_branch: 'main',
      },
      installation: { id: 123 },
    });
    // No localPath + no workspace root configured → webhook reports missing_local_path
    // rather than failing, proving it reached the enqueue path.
    delete process.env.PROOFLOOP_WORKSPACE_ROOT;
    const result = await handleGithubWebhook({
      headers: {
        'x-github-event': 'check_suite',
        'x-hub-signature-256': sign('sekret', raw),
      },
      body: JSON.parse(raw),
      rawBody: raw,
    });
    expect(result.status).toBe(200);
    expect(result.body.ignored).toBe(true);
    expect(result.body.reason).toBe('missing_local_path');
    expect(listGithubInstallations().length).toBeGreaterThanOrEqual(0);
  });
});
