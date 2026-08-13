import { afterEach, describe, expect, it } from 'vitest';
import { handleGitlabWebhook } from './gitlab.js';

describe('GitLab webhook', () => {
  const prev = { ...process.env };

  afterEach(() => {
    process.env = { ...prev };
  });

  it('rejects when GITLAB_WEBHOOK_SECRET is unset', async () => {
    delete process.env.GITLAB_WEBHOOK_SECRET;
    const result = await handleGitlabWebhook({
      headers: { 'x-gitlab-event': 'Merge Request Hook' },
      body: { object_kind: 'merge_request', object_attributes: { action: 'open' } },
    });
    expect(result.status).toBe(503);
  });

  it('rejects invalid X-Gitlab-Token when secret configured', async () => {
    process.env.GITLAB_WEBHOOK_SECRET = 'expected';
    const result = await handleGitlabWebhook({
      headers: { 'x-gitlab-token': 'wrong', 'x-gitlab-event': 'Merge Request Hook' },
      body: { object_kind: 'merge_request' },
    });
    expect(result.status).toBe(401);
  });

  it('ignores non-MR actions', async () => {
    process.env.GITLAB_WEBHOOK_SECRET = 'expected';
    const result = await handleGitlabWebhook({
      headers: {
        'x-gitlab-token': 'expected',
        'x-gitlab-event': 'Merge Request Hook',
      },
      body: {
        object_kind: 'merge_request',
        object_attributes: { action: 'close' },
      },
    });
    expect(result.status).toBe(200);
    expect(result.body.ignored).toBe(true);
  });
});
