// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { AgentCoreIdentity } from './index.mock.js';
import type { AgentCoreIdentityOptions } from './types.js';

function newIdentity(options?: AgentCoreIdentityOptions): AgentCoreIdentity {
  return new AgentCoreIdentity({ id: 'testapp' }, `id-${randomUUID()}`, options);
}

test('getApiKey returns the configured dev key', async () => {
  const id = newIdentity({ providers: [{ type: 'apiKey', name: 'stripe', apiKey: 'sk_test_123' }] });
  assert.equal(await id.getApiKey('stripe'), 'sk_test_123');
});

test('getApiKey falls back to an env var', async () => {
  process.env.BLOCKS_AGENTCORE_APIKEY_GITHUB = 'ghp_abc';
  const id = newIdentity({ providers: [{ type: 'apiKey', name: 'github' }] });
  assert.equal(await id.getApiKey('github'), 'ghp_abc');
  delete process.env.BLOCKS_AGENTCORE_APIKEY_GITHUB;
});

test('getApiKey throws when no credential is available', async () => {
  const id = newIdentity({ providers: [{ type: 'apiKey', name: 'empty' }] });
  await assert.rejects(() => id.getApiKey('empty'), /No dev API key/);
});

test('unknown provider rejects', async () => {
  const id = newIdentity();
  await assert.rejects(() => id.getApiKey('nope'), /Unknown credential provider/);
});

test('provider type mismatch rejects', async () => {
  const id = newIdentity({ providers: [{ type: 'apiKey', name: 'stripe', apiKey: 'x' }] });
  await assert.rejects(() => id.getOAuthToken('stripe'), /expected "oauth2"/);
});

test('getOAuthToken returns a bearer token with the requested scopes', async () => {
  const id = newIdentity({
    providers: [{ type: 'oauth2', name: 'google', discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration' }],
  });
  const token = await id.getOAuthToken('google', { scopes: ['calendar.read', 'email'] });
  assert.equal(token.tokenType, 'Bearer');
  assert.deepEqual(token.scopes, ['calendar.read', 'email']);
  assert.ok(token.accessToken.includes('google'));
  assert.ok(token.expiresAt && new Date(token.expiresAt).getTime() > Date.now());
});

test('getOAuthToken uses provider default scopes when none passed', async () => {
  const id = newIdentity({ providers: [{ type: 'oauth2', name: 'slack', scopes: ['chat:write'] }] });
  const token = await id.getOAuthToken('slack');
  assert.deepEqual(token.scopes, ['chat:write']);
});

test('getWorkloadAccessToken distinguishes caller identities', async () => {
  const id = newIdentity({ workloadName: 'wl' });
  const self = await id.getWorkloadAccessToken();
  const byUser = await id.getWorkloadAccessToken({ userId: 'alice' });
  const byJwt = await id.getWorkloadAccessToken({ jwt: 'header.payload.sig' });
  assert.equal(self.workloadName, 'wl');
  assert.ok(self.workloadAccessToken.endsWith('self'));
  assert.ok(byUser.workloadAccessToken.includes('user:alice'));
  assert.notEqual(byJwt.workloadAccessToken, self.workloadAccessToken);
});

test('layer parity: mock/aws/cdk/browser expose the same public methods', async () => {
  const mock = await import('./index.mock.js');
  const aws = await import('./index.aws.js');
  const cdk = await import('./index.cdk.js');
  const browser = await import('./index.browser.js');

  const methods = (cls: any): string[] =>
    Object.getOwnPropertyNames(cls.prototype).filter((m) => m !== 'constructor');

  const expected = ['getWorkloadAccessToken', 'getApiKey', 'getOAuthToken'];
  for (const layer of [mock.AgentCoreIdentity, aws.AgentCoreIdentity, cdk.AgentCoreIdentity]) {
    const present = methods(layer);
    for (const m of expected) {
      assert.ok(present.includes(m), `expected method "${m}" on ${layer.name}`);
    }
  }
  assert.equal(typeof browser.AgentCoreIdentity, 'function');
});
