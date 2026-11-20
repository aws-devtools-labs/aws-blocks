// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { AuthErrors, isAuthError } from '@aws-cdk-blocks/bb-auth';
import { ApiError } from '@aws-cdk-blocks/core';
import { withAuth } from 'aws-cdk-blocks/server';
import type { ProtectApis } from './auth-protect.test.js';

/**
 * `withAuth(fn, cookies, { allowAnonymous: true })`: server rendering for a
 * visitor without cookies. The calls inside run signed out, so a public method
 * answers and a method gated with `requireAuth` still answers its own 401.
 */
export function withAuthAnonymousTests(getApis: () => ProtectApis) {
  describe('withAuth: allowAnonymous for a request without cookies', () => {
    test('a public method answers inside withAuth(fn, null, { allowAnonymous: true })', async () => {
      const { api, protectedApi } = getApis();
      await api.authSignOut();
      const pong = await withAuth(() => protectedApi.ping(), null, { allowAnonymous: true });
      assert.deepStrictEqual(pong, { ok: true });
    });

    test('a method gated with requireAuth still answers 401 NotAuthenticated', async () => {
      const { api, protectedApi } = getApis();
      await api.authSignOut();
      await assert.rejects(
        () => withAuth(() => protectedApi.whoAmI(), null, { allowAnonymous: true }),
        (e) => isAuthError(e, AuthErrors.NotAuthenticated) && e instanceof Error && 'status' in e && e.status === 401,
      );
    });

    test('without the option, withAuth(fn, null) throws 401 and never calls the API', async () => {
      const { protectedApi } = getApis();
      let called = false;
      await assert.rejects(
        () => withAuth(async () => { called = true; return protectedApi.ping(); }, null),
        (e) => e instanceof ApiError && e.status === 401,
      );
      assert.strictEqual(called, false);
    });
  });
}
