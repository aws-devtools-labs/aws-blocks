// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `validateUser` (decision Q10) on the `auth-gated` instance: one policy for
 * every sign-up and sign-in — only `@allowed.example` addresses may join.
 *
 * - Local and deployed: an email + password sign-up outside the policy is
 *   rejected with the developer's `AuthErrors` name and message; one inside
 *   it proceeds.
 * - Local: a stub-IdP sign-in outside the policy is rejected on the callback
 *   and issues no session (a deployed stub IdP is unavailable by design).
 * - Deployed only: a `SignUp` sent straight to Cognito with the pool's client
 *   id — bypassing the app — is rejected by the PreSignUp trigger.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { AuthErrors } from '@aws-blocks/bb-auth';
import { isBlocksError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';
import { isDeployedE2e } from './test-support.js';

const POLICY_MESSAGE = 'Only @allowed.example accounts may join';

function getBaseUrl(): string {
  const config = JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf-8'));
  return String(config.apiUrl).replace(/\/aws-blocks\/api$/, '');
}

/** `name=value` pairs from a response's `Set-Cookie` headers (cleared cookies dropped). */
function cookiesOf(resp: Response): string[] {
  return (resp.headers.getSetCookie?.() ?? [])
    .filter((sc) => !sc.includes('Max-Age=0'))
    .map((sc) => sc.split(';')[0] ?? '')
    .filter((nv) => nv.includes('='));
}

/** A stack output of the deployed e2e build (`.blocks-sandbox/outputs.json`). */
function stackOutput(prefix: string): string {
  const outputs: Record<string, Record<string, string>> = JSON.parse(
    readFileSync('.blocks-sandbox/outputs.json', 'utf-8'),
  );
  const value = Object.values(outputs)
    .flatMap((stackOutputs) => Object.entries(stackOutputs))
    .find(([key]) => key.startsWith(prefix))?.[1];
  if (!value) throw new Error(`${prefix}* not found in .blocks-sandbox/outputs.json`);
  return value;
}

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function authValidateUserTests(getApi: () => typeof apiType) {
  describe('Auth validateUser — sign-up and sign-in policy (auth-gated)', () => {
    test('an email + password sign-up outside the policy is rejected with the canonical error', async () => {
      const api = getApi();
      const id = unique();
      try {
        await api.gatedSignUp(`mal${id}`, 'secret1', `mal${id}@blocked.example`);
        assert.fail('Expected the sign-up to be rejected');
      } catch (e) {
        assert.ok(isBlocksError(e, AuthErrors.NotAuthorized), `Expected ${AuthErrors.NotAuthorized}, got ${e}`);
        assert.strictEqual(e instanceof Error ? e.message : undefined, POLICY_MESSAGE);
      }
    });

    test('a sign-up inside the policy proceeds to email confirmation', async () => {
      const api = getApi();
      const id = unique();
      const result = await api.gatedSignUp(`ada${id}`, 'secret1', `ada${id}@allowed.example`);
      assert.strictEqual(result.isSignUpComplete, false);
    });

    test('a stub-IdP sign-in outside the policy is rejected and issues no session', async () => {
      const baseUrl = getBaseUrl();
      const start = await fetch(`${baseUrl}/aws-blocks/auth/gated/signin/gated-idp`, { redirect: 'manual' });
      assert.strictEqual(start.status, 302, `sign-in kickoff should 302, got ${start.status}`);
      const pending = cookiesOf(start);
      const authorize = await fetch(start.headers.get('location') ?? '', { redirect: 'manual' });
      assert.strictEqual(authorize.status, 302, `stub IdP authorize should 302, got ${authorize.status}`);
      const callback = await fetch(authorize.headers.get('location') ?? '', {
        redirect: 'manual',
        headers: { cookie: pending.join('; ') },
      });
      assert.strictEqual(callback.status, 403);
      const body = await callback.json();
      assert.strictEqual(body.name, AuthErrors.NotAuthorized);
      assert.strictEqual(body.error, POLICY_MESSAGE);
      const session = cookiesOf(callback).filter((c) => /^auth_[^=]*auth-gated=/.test(c));
      assert.deepStrictEqual(session, [], 'no session cookie');
    });

    test(
      'a SignUp sent straight to Cognito is rejected by the PreSignUp trigger',
      { skip: !isDeployedE2e },
      async () => {
        const clientId = stackOutput('GatedAuthClientId');
        const region = stackOutput('GatedAuthRegion');
        const id = unique();
        // Cognito's public API needs no AWS credentials for SignUp — anyone with the
        // client id can call it, which is exactly why the trigger exists.
        const resp = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-amz-json-1.1',
            'X-Amz-Target': 'AWSCognitoIdentityProviderService.SignUp',
          },
          body: JSON.stringify({
            ClientId: clientId,
            Username: `direct${id}`,
            Password: 'Secret-1234',
            UserAttributes: [{ Name: 'email', Value: `direct${id}@blocked.example` }],
          }),
        });
        assert.strictEqual(resp.status, 400);
        const body = await resp.json();
        assert.match(String(body.__type), /UserLambdaValidationException$/);
        // The rejection carries the policy's error (tagged base64url JSON), never internals.
        const payload = /bb-auth-rejection:([A-Za-z0-9_-]+)/.exec(String(body.message))?.[1];
        assert.ok(payload, `expected an encoded validateUser rejection, got ${body.message}`);
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        assert.strictEqual(decoded.n, AuthErrors.NotAuthorized);
        assert.strictEqual(decoded.m, POLICY_MESSAGE);
      },
    );
  });
}
