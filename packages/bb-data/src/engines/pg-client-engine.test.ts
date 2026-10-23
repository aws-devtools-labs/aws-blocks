// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mock } from 'node:test';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { PgClientEngine } from './pg-client-engine.js';
import { tlsConnectionMessage } from './pg-client-engine.js';
import type { PgClientEngineConfig } from './pg-client-engine.js';
import { DatabaseErrors } from '../errors.js';

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
  const mockClient = Object.assign(new EventEmitter(), {
    query: t.mock.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {};
      return { rows: [{ count: 5 }] };
    }),
    release: t.mock.fn(),
  });

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
  assert.strictEqual(mockClient.listenerCount('error'), 0, 'transaction error listener detached on commit');
});

test('PgClientEngine: rollbackTransaction releases client', async (t) => {
  const mockClient = Object.assign(new EventEmitter(), {
    query: t.mock.fn(async () => ({})),
    release: t.mock.fn(),
  });

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
  assert.strictEqual(mockClient.listenerCount('error'), 0, 'transaction error listener detached on rollback');
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

test('PgClientEngine: strips sslmode from the URL so a pinned CA takes effect', () => {
  // node `pg` ignores a programmatic `ssl.ca` when `sslmode` is in the URL, which
  // would silently defeat the documented `fromExisting({ ssl: { ca } })` escape
  // hatch. The engine must strip it so the pinned CA is honored.
  const engine = new PgClientEngine({
    connectionString: 'postgres://u:p@h:5432/d?sslmode=require&application_name=x',
    ssl: { rejectUnauthorized: true, ca: 'pem' },
  });
  const cs = (engine as any).pool.options.connectionString as string;
  assert.ok(!/sslmode/i.test(cs), `expected sslmode stripped, got: ${cs}`);
  assert.match(cs, /application_name=x/); // unrelated params are preserved
  assert.deepStrictEqual((engine as any).pool.options.ssl, { minVersion: 'TLSv1.2', rejectUnauthorized: true, ca: 'pem' });
});

// --- tlsConnectionMessage (post-handshake confirmation) ---

describe('tlsConnectionMessage', () => {
  const CONN = 'postgres://u:p@db.example.com:5432/postgres';

  test('pinned CA → log level, names the pinned CA and the host', () => {
    const { level, message } = tlsConnectionMessage({ rejectUnauthorized: true, ca: 'pem' }, CONN);
    assert.strictEqual(level, 'log');
    assert.match(message, /verified against the pinned CA/);
    assert.match(message, /db\.example\.com:5432/);
  });

  test('no CA (verify against trust store) → log level, names the built-in trust store', () => {
    const { level, message } = tlsConnectionMessage({ rejectUnauthorized: true }, CONN);
    assert.strictEqual(level, 'log');
    assert.match(message, /Node's built-in trust store/);
  });

  test('undefined ssl is treated as verifying (engine default)', () => {
    const { level, message } = tlsConnectionMessage(undefined, CONN);
    assert.strictEqual(level, 'log');
    assert.match(message, /verified/);
  });

  test('opt-out (rejectUnauthorized: false) → warn level, says NOT verified', () => {
    const { level, message } = tlsConnectionMessage({ rejectUnauthorized: false }, CONN);
    assert.strictEqual(level, 'warn');
    assert.match(message, /NOT verified/);
    assert.match(message, /man-in-the-middle/);
  });

  test('an unparseable connection string simply omits the host (no throw)', () => {
    const { message } = tlsConnectionMessage({ rejectUnauthorized: true }, 'not a url');
    assert.doesNotMatch(message, / to /);
    assert.match(message, /verified/);
  });
});

// --- Pool resilience (real pg.Pool, fake network-free Client) ---

/**
 * Minimal stand-in for `pg.Client` that a real `pg.Pool` can drive without a
 * network. Supports both the promise and callback `query` forms (the pool's own
 * `pool.query()` uses the callback form). `failNextBegin` makes the next `BEGIN`
 * reject, as a server would on a statement timeout or a connection dropped
 * between checkout and `BEGIN`.
 */
class FakeClient extends EventEmitter {
  static instances: FakeClient[] = [];
  static failNextBegin: Error | null = null;
  _queryable = true;
  _ending = false;
  ended = false;

  constructor() {
    super();
    FakeClient.instances.push(this);
  }

  connect(cb?: (err: Error | null) => void): void {
    setImmediate(() => cb?.(null));
  }

  query(sql: string, values?: unknown, cb?: (err: Error | null, res?: unknown) => void): Promise<unknown> | undefined {
    const callback = typeof values === 'function' ? (values as typeof cb) : cb;
    let result: Promise<unknown>;
    if (sql === 'BEGIN' && FakeClient.failNextBegin) {
      result = Promise.reject(FakeClient.failNextBegin);
      FakeClient.failNextBegin = null;
    } else {
      result = Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 });
    }
    if (!callback) return result;
    result.then((res) => callback(null, res), (err: Error) => callback(err));
    return undefined;
  }

  end(cb?: () => void): Promise<void> {
    this.ended = true;
    this._ending = true;
    this._queryable = false;
    setImmediate(() => cb?.());
    return Promise.resolve();
  }
}

/** The engine's private pool (test-only view; the field is intentionally not public). */
function poolOf(engine: PgClientEngine): pg.Pool {
  const pool: unknown = Reflect.get(engine, 'pool');
  assert.ok(pool instanceof pg.Pool, 'engine.pool should be a pg.Pool');
  return pool;
}

/** Build an engine whose private pool is a real `pg.Pool` backed by FakeClient. */
function engineWithFakeClient(config: Partial<PgClientEngineConfig> = {}): PgClientEngine {
  // The engine constructs `new pg.Pool(...)` from the shared `pg` export; swap it
  // for the duration of the constructor so the pool drives FakeClient.
  const pgExports = pg as unknown as { Pool: typeof pg.Pool };
  const RealPool = pgExports.Pool;
  // FakeClient implements only the slice of pg.Client that pg-pool calls.
  const Client = FakeClient as unknown as typeof pg.Client;
  pgExports.Pool = class extends RealPool {
    constructor(options?: pg.PoolConfig) {
      super({ ...options, Client });
    }
  };
  try {
    return new PgClientEngine({ connectionString: 'postgres://u:secret-pw@127.0.0.1:1/db', ...config });
  } finally {
    pgExports.Pool = RealPool;
  }
}

describe('PgClientEngine: pool resilience', () => {
  beforeEach(() => {
    FakeClient.instances = [];
    FakeClient.failNextBegin = null;
  });

  test('a failed BEGIN releases the client with the error, so a max:1 pool can check out again', async (t) => {
    t.mock.method(console, 'log', () => {});
    // `connectionTimeoutMillis` turns a leaked slot into a fast failure instead of a hang.
    const engine = engineWithFakeClient({ poolSize: 1, connectionTimeoutMillis: 500 });
    const releases: unknown[] = [];
    poolOf(engine).on('release', (err: unknown) => releases.push(err));

    const beginError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    FakeClient.failNextBegin = beginError;
    await assert.rejects(() => engine.beginTransaction(), (e: Error) => e.name === DatabaseErrors.QueryFailed);

    assert.strictEqual(releases.length, 1, 'the checked-out client must be released exactly once');
    assert.strictEqual(releases[0], beginError, 'released with the BEGIN error so pg discards the connection');
    assert.strictEqual(FakeClient.instances[0].ended, true, 'the possibly broken connection is closed, not reused');

    // The single slot is free again: a new transaction and a plain query both get a client.
    const handle = await engine.beginTransaction();
    await engine.commitTransaction(handle);
    assert.deepStrictEqual(await engine.query('SELECT 1'), [{ ok: 1 }]);
    assert.strictEqual(releases.length, 3);
    await engine.destroy();
  });

  test("an idle client's 'error' does not crash the process and the pool keeps serving", async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
    const engine = engineWithFakeClient({ poolSize: 1 });

    assert.deepStrictEqual(await engine.query('SELECT 1'), [{ ok: 1 }]);
    const idle = FakeClient.instances[0];

    // A dropped idle socket: pg-pool removes the client and re-emits on the pool.
    // With no pool 'error' listener, EventEmitter throws, which in production
    // surfaces as an uncaught exception that terminates the process.
    const dropped = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: 'ECONNRESET',
      client: { connectionParameters: { password: 'secret-pw' } },
    });
    assert.doesNotThrow(() => idle.emit('error', dropped));

    assert.strictEqual(warn.mock.callCount(), 1, 'logs one warning');
    const args = warn.mock.calls[0].arguments;
    assert.ok(
      args.every((a) => typeof a === 'string'),
      'logs only strings, never the raw error object',
    );
    assert.match(args.join(' '), /idle database connection was closed unexpectedly \(ECONNRESET\)/);
    assert.doesNotMatch(args.join(' '), /Connection terminated/, 'driver text is never logged');
    assert.doesNotMatch(args.join(' '), /secret-pw/);

    assert.deepStrictEqual(await engine.query('SELECT 1'), [{ ok: 1 }]);
    assert.strictEqual(FakeClient.instances.length, 2, 'the pool opened a fresh connection');
    await engine.destroy();
  });

  test('a connection dropped mid-transaction does not crash the process, and its listener ends with the checkout', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
    const engine = engineWithFakeClient({ poolSize: 1, connectionTimeoutMillis: 500 });

    const handle = await engine.beginTransaction();
    const client = FakeClient.instances[0];
    // pg-pool detaches its idle listener at checkout; only the engine's remains.
    assert.strictEqual(client.listenerCount('error'), 1);

    // pg marks a client whose socket ended unqueryable and emits 'error' on the
    // client itself. With no listener, that emit throws and kills the process.
    client._queryable = false;
    const dropped = Object.assign(new Error('Connection terminated unexpectedly'), {
      client: { connectionParameters: { password: 'secret-pw' } },
    });
    assert.doesNotThrow(() => client.emit('error', dropped));

    assert.strictEqual(warn.mock.callCount(), 1, 'logs one warning');
    const args = warn.mock.calls[0].arguments;
    assert.ok(
      args.every((a) => typeof a === 'string'),
      'logs only strings, never the raw error object',
    );
    assert.match(args.join(' '), /closed unexpectedly during a transaction\./);
    assert.doesNotMatch(args.join(' '), /Connection terminated/, 'driver text is never logged');
    assert.doesNotMatch(args.join(' '), /secret-pw/);

    await engine.rollbackTransaction(handle);
    assert.strictEqual(client.ended, true, 'the dead connection is discarded, not pooled');

    // The slot is free; a fresh client, once released, carries only pg-pool's idle listener.
    await engine.commitTransaction(await engine.beginTransaction());
    assert.strictEqual(FakeClient.instances.length, 2);
    assert.strictEqual(FakeClient.instances[1].listenerCount('error'), 1, 'no stale transaction listener in the pool');
    await engine.destroy();
  });

  test('the connection warning never carries server text, a newline, or a malformed code', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'log', () => {});
    const engine = engineWithFakeClient({ poolSize: 1 });
    // A server-supplied FATAL message is attacker- or operator-controlled text.
    const hostile = Object.assign(
      new Error('FATAL: postgres://admin:hunter2@db.internal/app\n[PgClientEngine] forged log line'),
      { code: 'XX000 hunter2' },
    );

    // Idle path (pool listener).
    await engine.query('SELECT 1');
    FakeClient.instances[0].emit('error', hostile);
    // Transaction path (per-checkout listener).
    const handle = await engine.beginTransaction();
    const txClient = FakeClient.instances[1];
    txClient._queryable = false;
    txClient.emit('error', hostile);
    await engine.rollbackTransaction(handle);

    assert.strictEqual(warn.mock.callCount(), 2);
    for (const call of warn.mock.calls) {
      assert.strictEqual(call.arguments.length, 1);
      const [line] = call.arguments;
      assert.strictEqual(typeof line, 'string');
      assert.doesNotMatch(String(line), /hunter2|postgres:\/\/|forged|XX000/);
      assert.ok(!/[\r\n]/.test(String(line)), 'the warning is a single line');
      assert.match(String(line), /closed unexpectedly( during a transaction)?\. /, 'a malformed code is omitted');
    }
    await engine.destroy();
  });
});
