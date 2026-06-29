// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Scope } from '@aws-blocks/core';
import { Database } from './index.aws.js';

/**
 * AWS-layer guard for the deployed runtime's TLS posture.
 *
 * `Database._initBase()` (index.aws.ts) is the seam that restores verify-by-default
 * for external `fromExisting({ connectionString })` connections: it forwards the
 * caller's `conn.ssl` into `PgClientEngine`, and when `ssl` is omitted the engine
 * defaults to `{ rejectUnauthorized: true }`. The engine default is unit-tested in
 * pg-client-engine.test.ts, but nothing asserted that the *aws layer* actually
 * threads `conn.ssl` through — so a refactor here could silently regress the
 * deployed default back to unverified without failing a test. These tests build a
 * Database with a string connection and inspect the resulting pool's `ssl`.
 *
 * `getEngine()` triggers `_initBase()` lazily; the underlying `pg.Pool` is created
 * eagerly in the engine constructor but does not connect until the first query, so
 * no database is needed.
 */
describe('Database (aws runtime): _initBase forwards conn.ssl to the pool', () => {
  const CONN = 'postgres://u:p@db.example.com:5432/postgres';

  async function poolSslFor(connection: any): Promise<unknown> {
    const scope = new Scope('tls-test-' + Math.random().toString(36).slice(2));
    const db = new Database(scope, 'db', { connection });
    const engine = await db.getEngine();
    return (engine as any).pool.options.ssl;
  }

  test('omitted ssl → pool verifies the server certificate (rejectUnauthorized: true)', async () => {
    const ssl = await poolSslFor({ connectionString: CONN });
    // No `ssl` passed: the deployed Lambda must verify by default. The engine adds
    // its TLS 1.2 floor alongside the verifying default.
    assert.deepStrictEqual(ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: true });
  });

  test('explicit CA-pin ssl is forwarded to the pool', async () => {
    const ssl = await poolSslFor({
      connectionString: CONN,
      ssl: { rejectUnauthorized: true, ca: 'my-ca-pem' },
    });
    assert.deepStrictEqual(ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: true, ca: 'my-ca-pem' });
  });

  test('explicit opt-out ssl ({ rejectUnauthorized: false }) is forwarded to the pool', async () => {
    const ssl = await poolSslFor({
      connectionString: CONN,
      ssl: { rejectUnauthorized: false },
    });
    // The caller's explicit opt-out is honored; the TLS 1.2 floor still applies
    // (TLS version is orthogonal to certificate verification).
    assert.deepStrictEqual(ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: false });
  });

  test('a resolved (async) connection string also verifies by default', async () => {
    const ssl = await poolSslFor({ connectionString: { get: async () => CONN } });
    assert.deepStrictEqual(ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: true });
  });
});
