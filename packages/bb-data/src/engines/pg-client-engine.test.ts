// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mock } from 'node:test';
import { PgClientEngine } from './pg-client-engine.js';

// We test PgClientEngine by verifying it correctly delegates to pg.Pool.
// Since pg is an external dep, we mock at the module level.

test('PgClientEngine: query delegates to pool.query and returns rows', async (t) => {
  const mockPool = {
    query: t.mock.fn(async () => ({ rows: [{ id: '1', name: 'test' }] })),
    connect: t.mock.fn(),
    end: t.mock.fn(async () => {}),
  };

  // Construct engine and inject mock pool
  const engine = new PgClientEngine({ connectionString: 'postgres://mock' });
  (engine as any).pool = mockPool;

  const rows = await engine.query<{ id: string }>('SELECT * FROM t WHERE id = $1', ['1']);
  assert.deepStrictEqual(rows, [{ id: '1', name: 'test' }]);
  assert.strictEqual(mockPool.query.mock.callCount(), 1);
  assert.deepStrictEqual(mockPool.query.mock.calls[0].arguments, ['SELECT * FROM t WHERE id = $1', ['1']]);
});

test('PgClientEngine: execute returns rowCount', async (t) => {
  const mockPool = {
    query: t.mock.fn(async () => ({ rowCount: 3 })),
    connect: t.mock.fn(),
    end: t.mock.fn(async () => {}),
  };

  const engine = new PgClientEngine({ connectionString: 'postgres://mock' });
  (engine as any).pool = mockPool;

  const result = await engine.execute('DELETE FROM t WHERE active = $1', [false]);
  assert.strictEqual(result.rowCount, 3);
});

test('PgClientEngine: execute returns 0 when rowCount is null', async (t) => {
  const mockPool = {
    query: t.mock.fn(async () => ({ rowCount: null })),
    connect: t.mock.fn(),
    end: t.mock.fn(async () => {}),
  };

  const engine = new PgClientEngine({ connectionString: 'postgres://mock' });
  (engine as any).pool = mockPool;

  const result = await engine.execute('CREATE TABLE x (id int)');
  assert.strictEqual(result.rowCount, 0);
});

test('PgClientEngine: transaction lifecycle (begin, queryInTransaction, commit)', async (t) => {
  const mockClient = {
    query: t.mock.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      return { rows: [{ count: 5 }] };
    }),
    release: t.mock.fn(),
  };

  const mockPool = {
    query: t.mock.fn(),
    connect: t.mock.fn(async () => mockClient),
    end: t.mock.fn(async () => {}),
  };

  const engine = new PgClientEngine({ connectionString: 'postgres://mock' });
  (engine as any).pool = mockPool;

  const handle = await engine.beginTransaction();
  const rows = await engine.queryInTransaction<{ count: number }>(handle, 'SELECT count(*) FROM t');
  assert.deepStrictEqual(rows, [{ count: 5 }]);

  await engine.commitTransaction(handle);
  assert.strictEqual(mockClient.release.mock.callCount(), 1);
});

test('PgClientEngine: rollbackTransaction releases client', async (t) => {
  const mockClient = {
    query: t.mock.fn(async () => ({})),
    release: t.mock.fn(),
  };

  const mockPool = {
    query: t.mock.fn(),
    connect: t.mock.fn(async () => mockClient),
    end: t.mock.fn(async () => {}),
  };

  const engine = new PgClientEngine({ connectionString: 'postgres://mock' });
  (engine as any).pool = mockPool;

  const handle = await engine.beginTransaction();
  await engine.rollbackTransaction(handle);
  assert.strictEqual(mockClient.release.mock.callCount(), 1);
});

test('PgClientEngine: destroy calls pool.end', async (t) => {
  const mockPool = {
    query: t.mock.fn(),
    connect: t.mock.fn(),
    end: t.mock.fn(async () => {}),
  };

  const engine = new PgClientEngine({ connectionString: 'postgres://mock' });
  (engine as any).pool = mockPool;

  await engine.destroy();
  assert.strictEqual(mockPool.end.mock.callCount(), 1);
});

test('PgClientEngine: rejects a placeholder (non-postgres URL) connection string', () => {
  // The random base64url placeholder left by an unprovisioned secret.
  assert.throws(
    () => new PgClientEngine({ connectionString: 'k9Fz3xQ2_aB7cD8eF1gH4iJ6kL0mN5pQ' }),
    (e: Error) => e.name === 'ConnectionFailedException' && /npm run sandbox/.test(e.message),
  );
});

test('PgClientEngine: accepts postgres:// and postgresql:// URLs', () => {
  assert.doesNotThrow(() => new PgClientEngine({ connectionString: 'postgres://u:p@h:5432/d' }));
  assert.doesNotThrow(() => new PgClientEngine({ connectionString: 'postgresql://u:p@h:6543/d' }));
});

test('PgClientEngine: verifies the server certificate by default (ssl omitted)', () => {
  // Security default: when no ssl is supplied the pool must reject an
  // unverified certificate. The runtime/generated paths rely on this default.
  const engine = new PgClientEngine({ connectionString: 'postgres://u:p@h:5432/d' });
  assert.deepStrictEqual((engine as any).pool.options.ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: true });
});

test('PgClientEngine: respects an explicit ssl config (CA pin / opt-out)', () => {
  const pinned = new PgClientEngine({
    connectionString: 'postgres://u:p@h:5432/d',
    ssl: { rejectUnauthorized: true, ca: 'my-ca-pem' },
  });
  assert.deepStrictEqual((pinned as any).pool.options.ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: true, ca: 'my-ca-pem' });

  const optedOut = new PgClientEngine({
    connectionString: 'postgres://u:p@h:5432/d',
    ssl: { rejectUnauthorized: false },
  });
  // The TLS 1.2 floor applies even on the unverified opt-out path (TLS version is
  // orthogonal to certificate verification).
  assert.deepStrictEqual((optedOut as any).pool.options.ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: false });
});

test('PgClientEngine: applies a TLS 1.2 floor a caller can override', () => {
  const engine = new PgClientEngine({
    connectionString: 'postgres://u:p@h:5432/d',
    ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.3' },
  });
  assert.deepStrictEqual((engine as any).pool.options.ssl, { minVersion: 'TLSv1.3', rejectUnauthorized: true });
});
