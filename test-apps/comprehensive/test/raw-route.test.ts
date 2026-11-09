// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

function getBaseUrl(): string {
  const config = JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf-8'));
  const apiUrl: string = config.apiUrl;
  return apiUrl.replace(/\/aws-blocks\/api$/, '');
}

export function rawRouteTests() {

  describe('RawRoute', () => {

    // ── Exact path match ──────────────────────────────────────────────────

    test('GET /hello — simple exact route', async () => {
      const res = await fetch(`${getBaseUrl()}/hello`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body, { message: 'Hello from RawRoute!' });
    });

    // ── Named path parameter ──────────────────────────────────────────────

    test('GET /greet/{name} — named path parameter', async () => {
      const res = await fetch(`${getBaseUrl()}/greet/world`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body, { message: 'Hello, world!' });
    });

    test('GET /greet/{name} — URL-decodes path parameter', async () => {
      const res = await fetch(`${getBaseUrl()}/greet/${encodeURIComponent('John Doe')}`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body, { message: 'Hello, John Doe!' });
    });

    // ── Wildcard ──────────────────────────────────────────────────────────

    test('GET /files/* — wildcard captures rest of path', async () => {
      const res = await fetch(`${getBaseUrl()}/files/docs/readme.md`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.path, 'docs/readme.md');
    });

    test('GET /files/* — wildcard with single segment', async () => {
      const res = await fetch(`${getBaseUrl()}/files/image.png`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.path, 'image.png');
    });

    test('GET /files/* — ctx.request.url.pathname is the route path, without an API Gateway stage', async () => {
      const res = await fetch(`${getBaseUrl()}/files/docs/readme.md`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      // Not `new URL(...).pathname` of the fetched URL: in sandbox that URL is the
      // execute-api stage URL (`/prod/files/...`), and the handler must not see `/prod`.
      assert.strictEqual(body.pathname, '/files/docs/readme.md');
    });

    // ── POST with body ────────────────────────────────────────────────────

    test('POST /echo — reads and echoes JSON body', async () => {
      const payload = { hello: 'world', num: 42 };
      const res = await fetch(`${getBaseUrl()}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body, payload);
    });

    // ── PUT with named parameter ──────────────────────────────────────────

    test('PUT /items/{id} — different HTTP method with param and body', async () => {
      const res = await fetch(`${getBaseUrl()}/items/abc-123`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Widget' }),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body, { id: 'abc-123', name: 'Widget', updated: true });
    });

    // ── 404 for unregistered route ────────────────────────────────────────

    test('GET /nonexistent — returns 404 for unregistered path', async () => {
      const res = await fetch(`${getBaseUrl()}/nonexistent`);
      assert.strictEqual(res.status, 404);
    });

    // ── Scope-chain path derivation ───────────────────────────────────────

    test('GET /status — derived path from direct child of scope', async () => {
      const res = await fetch(`${getBaseUrl()}/status`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body, { derived: true, path: '/status' });
    });

    test('GET /nested/info — derived path from nested scope chain', async () => {
      const res = await fetch(`${getBaseUrl()}/nested/info`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.deepStrictEqual(body, { derived: true, path: '/nested/info' });
    });

  });

}
