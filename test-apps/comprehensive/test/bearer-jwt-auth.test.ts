// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import type { api as apiType } from 'aws-blocks';

// AuthBearerJwt surfaces a 401 with this error name when a request carries no
// valid bearer token.
const MissingToken = 'MissingTokenException';
const InvalidToken = 'InvalidTokenException';

function getBaseUrl(): string {
  const config = JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf-8'));
  const apiUrl: string = config.apiUrl;
  return apiUrl.replace(/\/aws-blocks\/api$/, '');
}

/**
 * Drive an API method over the raw JSON-RPC wire so we can attach an
 * `Authorization: Bearer` header per call — the generated client is
 * cookie-based and does not expose per-request bearer headers.
 */
async function rpcCall(
  baseUrl: string,
  method: string,
  args: unknown[],
  init?: { bearer?: string },
): Promise<{ status: number; result?: unknown; error?: { name?: string; message?: string } }> {
  const resp = await fetch(`${baseUrl}/aws-blocks/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: `api.${method}`, params: args, id: 1 }),
  });
  const body = await resp.json();
  return { status: resp.status, result: body.result, error: body.error };
}

export function bearerJwtAuthTests(getApi: () => typeof apiType) {
  describe('AuthBearerJwt', () => {
    test('a minted token authorizes the gated method', async () => {
      const api = getApi();
      // Mint a real token from the app's in-memory issuer (dev-only helper).
      const { token } = await api.bearerJwtMint('user-1', 'user-1@example.com');
      assert.ok(token, 'expected a minted token');

      const res = await rpcCall(getBaseUrl(), 'bearerJwtRequired', [], { bearer: token });
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status} (${JSON.stringify(res.error)})`);
      const result = res.result as { user: { userId: string; username: string } };
      assert.strictEqual(result.user.userId, 'user-1');
      assert.strictEqual(result.user.username, 'user-1@example.com');
    });

    test('a missing token is rejected with 401 MissingToken', async () => {
      const res = await rpcCall(getBaseUrl(), 'bearerJwtRequired', []);
      assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
      assert.strictEqual(res.error?.name, MissingToken, `expected ${MissingToken}, got ${res.error?.name}`);
    });

    test('a malformed token is rejected with 401 InvalidToken', async () => {
      const res = await rpcCall(getBaseUrl(), 'bearerJwtRequired', [], { bearer: 'not-a-real-jwt' });
      assert.strictEqual(res.status, 401, `expected 401, got ${res.status}`);
      assert.strictEqual(res.error?.name, InvalidToken, `expected ${InvalidToken}, got ${res.error?.name}`);
    });
  });
}
