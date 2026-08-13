import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { requireApiToken, scopeForRequest, webhookSecretRequired } from './auth.js';
import { ProofloopError } from '@proofloop/core';

describe('auth', () => {
  const prev = { ...process.env };

  afterEach(() => {
    process.env = { ...prev };
  });

  it('allows mutations when token unset', async () => {
    delete process.env.PROOFLOOP_API_TOKEN;
    await requireApiToken(
      { url: '/api/repositories', method: 'POST', headers: {} } as never,
      {} as never,
    );
  });

  it('rejects missing token when configured', async () => {
    process.env.PROOFLOOP_API_TOKEN = 'secret';
    await expect(
      requireApiToken(
        { url: '/api/repositories', method: 'POST', headers: {} } as never,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ProofloopError);
  });

  it('accepts bearer token', async () => {
    process.env.PROOFLOOP_API_TOKEN = 'secret';
    await requireApiToken(
      {
        url: '/api/repositories',
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      } as never,
      {} as never,
    );
  });

  it('allows github and gitlab webhooks without API token', async () => {
    process.env.PROOFLOOP_API_TOKEN = 'secret';
    await requireApiToken(
      { url: '/api/github/webhook', method: 'POST', headers: {} } as never,
      {} as never,
    );
    await requireApiToken(
      { url: '/api/gitlab/webhook', method: 'POST', headers: {} } as never,
      {} as never,
    );
  });

  it('requires webhook secret in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PROOFLOOP_REQUIRE_WEBHOOK_SECRET;
    expect(webhookSecretRequired()).toBe(true);
  });

  it('protects GET routes when a token is configured', async () => {
    process.env.PROOFLOOP_API_TOKEN = 'secret';
    await expect(
      requireApiToken(
        { url: '/api/repositories', method: 'GET', headers: {} } as never,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ProofloopError);
    await requireApiToken(
      {
        url: '/api/repositories',
        method: 'GET',
        headers: { authorization: 'Bearer secret' },
      } as never,
      {} as never,
    );
  });

  it('supports org-scoped keys via PROOFLOOP_API_KEYS', async () => {
    process.env.PROOFLOOP_API_KEYS = 'keyA:org_1,keyB:org_2';
    const reqA = {
      url: '/api/repositories',
      method: 'GET',
      headers: { authorization: 'Bearer keyA' },
    } as never;
    await requireApiToken(reqA, {} as never);
    expect(scopeForRequest(reqA as never).organizationId).toBe('org_1');

    const reqB = {
      url: '/api/repositories',
      method: 'GET',
      headers: { authorization: 'Bearer keyB' },
    } as never;
    await requireApiToken(reqB, {} as never);
    expect(scopeForRequest(reqB as never).organizationId).toBe('org_2');

    await expect(
      requireApiToken(
        { url: '/api/repositories', method: 'GET', headers: { authorization: 'Bearer nope' } } as never,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(ProofloopError);
  });

  it('global token has no org scope', async () => {
    process.env.PROOFLOOP_API_TOKEN = 'secret';
    const req = {
      url: '/api/repositories',
      method: 'GET',
      headers: { authorization: 'Bearer secret' },
    } as never;
    await requireApiToken(req, {} as never);
    expect(scopeForRequest(req as never).organizationId).toBeNull();
  });
});
