// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Social sign-in in local dev (`npm run dev`): Cognito managed login does not
 * exist offline, so the `signIn:google` action comes back marked unavailable,
 * with the hint the `Authenticator` shows next to its disabled button, and a
 * browser that navigates to the sign-in route anyway gets an explanatory HTML
 * page instead of raw JSON. Local only — the `auth-social` block is not
 * deployed (see `aws-blocks/index.ts`).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { AuthErrors } from '@aws-blocks/bb-auth';
import type { authSocialApi as authSocialApiType } from 'aws-blocks';

function getBaseUrl(): string {
  const config = JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf-8'));
  const apiUrl: string = config.apiUrl;
  return apiUrl.replace(/\/aws-blocks\/api$/, '');
}

const HINT = 'Google sign-in works after deploy (npm run sandbox), or use stubIdp() locally.';

export function authSocialLocalTests(getApi: () => typeof authSocialApiType) {
  describe('Auth - social sign-in in local dev', () => {
    test('getAuthState() marks signIn:google unavailable, with the hint', async () => {
      const authSocialApi = getApi();
      assert.ok(authSocialApi, 'the auth-social block exists in local dev');
      const state = await authSocialApi.getAuthState();
      assert.strictEqual(state.state, 'signedOut');
      const google = state.actions.find((a) => a.name === 'signIn:google');
      assert.ok(google, 'the Google action is still listed');
      assert.strictEqual(google.unavailable, HINT);
      assert.strictEqual(google.url, '/aws-blocks/auth/social/signin/google');
      // Email + password stays usable on the same block.
      const signIn = state.actions.find((a) => a.name === 'signIn');
      assert.ok(signIn);
      assert.strictEqual(signIn.unavailable, undefined);
    });

    test('the sign-in route answers a browser with an HTML page, an API client with the JSON error', async () => {
      const url = `${getBaseUrl()}/aws-blocks/auth/social/signin/google`;
      const page = await fetch(url, { redirect: 'manual', headers: { accept: 'text/html' } });
      assert.strictEqual(page.status, 501);
      assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
      const html = await page.text();
      assert.ok(html.includes(HINT), 'the page shows the hint');
      assert.match(html, /not a configuration error/);

      const json = await fetch(url, { redirect: 'manual' });
      assert.strictEqual(json.status, 501);
      const body = await json.json();
      assert.strictEqual(body.name, AuthErrors.ProviderMisconfigured, 'the error name is unchanged');
    });
  });
}
