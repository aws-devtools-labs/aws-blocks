// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import assert from 'node:assert';
import { Scope } from '@aws-blocks/core';
import { Database } from './index.aws.js';
import { DatabaseErrors } from './errors.js';
import type { DatabaseOptions } from './types.js';

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

  async function poolSslFor(connection: DatabaseOptions['connection']): Promise<unknown> {
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

/**
 * When no connection is configured and no Aurora ARNs are injected, `_initBase`
 * falls through to the Data API branch and throws. The message must guide *both*
 * intents — a provisioned Aurora database and an external `fromExisting` connection
 * (Supabase/Neon/etc.) — so an external-DB user isn't shown an Aurora-only error
 * with no hint about the connectionString path. See aws-amplify/amplify-backend#3238.
 */
describe('Database (aws runtime): unconfigured connection error is intent-aware', () => {
  test('error names both the Aurora provisioning and the fromExisting external path', async () => {
    const scope = new Scope(`cfg-test-${Math.random().toString(36).slice(2)}`);
    const db = new Database(scope, 'db', {});
    await assert.rejects(
      () => db.getEngine(),
      (err: Error) => {
        assert.match(err.message, /Supabase|external database/i, 'should mention the external-DB path');
        assert.match(err.message, /fromExisting/, 'should point at Database.fromExisting({ connectionString })');
        assert.match(err.message, /CLUSTER_ARN/, 'should still cover the provisioned Aurora path');
        return true;
      },
    );
  });
});

/**
 * The external-database path resolves its connection string lazily (an AppSetting
 * backed by SSM). A transient read failure must not be cached: a warm Lambda would
 * otherwise reject every later call until it is recycled. Concurrent first callers
 * must still share a single in-flight read.
 */
describe('Database (aws runtime): connection-string init retries after a failure', () => {
  // Port 1 on loopback refuses immediately, so a query after a successful init
  // fails fast with a connection error instead of reaching a real database.
  const CONN = 'postgres://u:p@127.0.0.1:1/postgres';

  type NotesMeta = { notes: { row: { id: string }; singular: 'note'; plural: 'notes'; autoGenerated: 'id' } };
  const schema = { notes: { singular: 'note', plural: 'notes', primaryKey: 'id', columns: ['id'], autoGenerated: ['id'] } };

  type PendingRead = { resolve: (v: string) => void; reject: (e: Error) => void };

  /** A connection-string setting whose reads are settled one at a time by the test. */
  function controlledSetting() {
    const pending: PendingRead[] = [];
    const setting = {
      calls: 0,
      get: () => {
        setting.calls++;
        // Executor form: `Promise.withResolvers` is not in this repo's ES2022 lib.
        return new Promise<string>((resolve, reject) => pending.push({ resolve, reject }));
      },
    };
    const next = (): PendingRead => {
      const read = pending.shift();
      assert.ok(read, 'expected a pending connection-string read');
      return read;
    };
    return { setting, next };
  }

  function newDatabase(connectionString: { get: () => Promise<string> }) {
    const scope = new Scope(`init-retry-${Math.random().toString(36).slice(2)}`);
    return new Database(scope, 'db', { connection: { connectionString }, schema });
  }

  test('getEngine(): concurrent first callers share one read, and a rejected read is retried', async () => {
    const { setting, next } = controlledSetting();
    const db = newDatabase(setting);

    const first = db.getEngine();
    const second = db.getEngine();
    await tick();
    assert.strictEqual(setting.calls, 1, 'concurrent callers share one in-flight read');
    next().reject(new Error('SSM throttled'));
    await Promise.all([assert.rejects(first, /SSM throttled/), assert.rejects(second, /SSM throttled/)]);

    const retry = db.getEngine();
    // Observed below; keeps a wedged (cached) rejection from masking the call-count assertion.
    retry.catch(() => {});
    await tick();
    assert.strictEqual(setting.calls, 2, 'the next call re-reads the connection string');
    next().resolve(CONN);
    const engine = await retry;
    assert.strictEqual(engine.constructor.name, 'PgClientEngine');

    assert.strictEqual(await db.getEngine(), engine, 'a successful init is cached');
    assert.strictEqual(setting.calls, 2);
  });

  test('crud(): a rejected init is retried on the next call', async () => {
    const { setting, next } = controlledSetting();
    const crud = newDatabase(setting).crud<NotesMeta>({ tables: ['notes'], auth: async () => ({ userId: 'u1' }) });

    const first = crud.listNotes();
    const second = crud.listNotes();
    await tick();
    assert.strictEqual(setting.calls, 1, 'concurrent callers share one in-flight read');
    next().reject(new Error('SSM throttled'));
    await Promise.all([assert.rejects(first, /SSM throttled/), assert.rejects(second, /SSM throttled/)]);

    const retry = crud.listNotes();
    // Observed below; keeps a wedged (cached) rejection from masking the call-count assertion.
    retry.catch(() => {});
    await tick();
    assert.strictEqual(setting.calls, 2, 'the next call re-reads the connection string');
    next().resolve(CONN);
    // Init now succeeds; the query itself reaches the engine, which translates the
    // refused connection into a DatabaseErrors name.
    await assert.rejects(retry, (e: Error) => Object.values(DatabaseErrors).some((name) => name === e.name));
  });
});
