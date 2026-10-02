// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DistributedDatabase sync: CDC folding, the reconcile protocol, and the
 * client shape end to end against the PGlite mock and the local bell.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scope, isBlocksError, matchRoute } from '@aws-blocks/core';
import type { BlocksContext } from '@aws-blocks/core';
import { attach, closeWebSocketServer } from '@aws-blocks/bb-realtime/ws-server';
import { sql } from '@aws-blocks/data-common';
import type { Shape } from '@aws-blocks/data-common/sync';
import { DistributedDatabase, DistributedDatabaseErrors } from '../index.mock.js';
import { decodeResponseHints, runWithResponseHints } from '@aws-blocks/core/bb-utils';
import { settle } from '@aws-blocks/data-common/sync-client';
import { classifyWrite } from '@aws-blocks/data-common';
import { BellBatcher, BellFolder, keysOf, parseCdcRecord } from './cdc.js';
import { openKeys, sealKeys } from './bell-keys.js';
import type { SyncRuntime } from './runtime.js';
import { bucketDigest } from './protocol.js';
import { ReconcileShape, parseValue } from './reconcile-shape.js';
import { ReconcileServer, bucketOf, rowHash } from './reconcile-server.js';
import { buildClaims } from '@aws-blocks/data-common/sync';

interface Todo {
  id: string;
  owner_id: string;
  title: string;
  done: boolean;
  position: number;
}

/** A CDC record as Lambda delivers it: base64 JSON. */
function cdc(record: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(record)).toString('base64');
}

function change(table: string, tsMs: number, op = 'c', schema = 'public'): string {
  return cdc({
    type: 'full',
    op,
    before: op === 'd' ? { id: 'k' } : null,
    after: op === 'd' ? null : { id: 'k' },
    source: { version: '1.0', ts_ms: tsMs, ts_ns: tsMs * 1e6, txId: `tx${tsMs}`, schema, table, db: 'postgres' },
  });
}

describe('CDC records → bells', () => {
  test('parses full and chunked records; skips fragments and malformed data', () => {
    assert.deepStrictEqual(parseCdcRecord(change('todos', 10)), {
      kind: 'change',
      schema: 'public',
      table: 'todos',
      tsMs: 10,
      image: { op: 'c', row: { id: 'k' } },
    });
    // An oversized record's main part still names its table, so it rings.
    const chunked = cdc({
      type: 'chunked',
      op: 'u',
      before: null,
      after: null,
      chunked: { after: { chunk_id: 'c1', total_fragments: 2, crc32c: '1' } },
      source: { ts_ms: 20, schema: 'public', table: 'todos' },
    });
    // No inline image: the bell carries no keys (full reconcile).
    assert.deepStrictEqual(parseCdcRecord(chunked), { kind: 'change', schema: 'public', table: 'todos', tsMs: 20, image: null });
    assert.deepStrictEqual(parseCdcRecord(cdc({ type: 'fragment', chunk_id: 'c1', index: 0, data: '{' })), {
      kind: 'skip',
      reason: 'fragment',
    });
    assert.deepStrictEqual(parseCdcRecord(Buffer.from('not json').toString('base64')), { kind: 'skip', reason: 'malformed' });
    assert.deepStrictEqual(parseCdcRecord(cdc({ type: 'full' })), { kind: 'skip', reason: 'no-source' });
  });

  test('folds duplicates and out-of-order records into one bell per synced table', () => {
    const folder = new BellFolder(['todos', 'app.lists']);
    for (const data of [
      change('todos', 30),
      change('todos', 10), // out of order
      change('todos', 30), // duplicate delivery
      change('todos', 20, 'd'),
      change('lists', 5, 'u', 'app'),
      change('lists', 7, 'u'), // public.lists is not synced
      change('users', 40), // not synced
    ]) {
      folder.add(parseCdcRecord(data));
    }
    const bells = folder.drain();
    assert.deepStrictEqual([...bells.keys()], ['todos', 'app.lists']);
    assert.strictEqual(bells.get('todos')?.tsMs, 30);
    assert.strictEqual(bells.get('app.lists')?.tsMs, 5);
    // Duplicates and deletes fold into one key (deletes carry it in `before`).
    assert.deepStrictEqual(keysOf(bells.get('todos')?.images ?? [], 'id'), ['k']);
    assert.strictEqual(folder.drain().size, 0);
  });

  test('records of one Lambda invocation publish one bell per table', async () => {
    const rung: string[] = [];
    const batcher = new BellBatcher(new BellFolder(['todos']), async (table) => {
      rung.push(table);
    });
    // The core dispatcher calls the handler for every record in the same tick.
    await Promise.all([change('todos', 1), change('todos', 2), change('todos', 2), change('other', 3)].map((d) => batcher.handle(d)));
    assert.deepStrictEqual(rung, ['todos']);
    await batcher.handle(change('todos', 4));
    assert.deepStrictEqual(rung, ['todos', 'todos']);
  });
});

describe('sealed bell keys', () => {
  test('round-trip, bound to the key and the table', () => {
    const sealed = sealKeys(['a', '42'], 'key-1', 'todos');
    assert.ok(sealed);
    assert.deepStrictEqual(openKeys(sealed, 'key-1', 'todos'), ['a', '42']);
    assert.strictEqual(openKeys(sealed, 'key-2', 'todos'), null);
    assert.strictEqual(openKeys(sealed, 'key-1', 'lists'), null);
    assert.strictEqual(openKeys(`${sealed.slice(0, -2)}AA`, 'key-1', 'todos'), null);
    assert.strictEqual(sealed.includes('42'), false);
  });

  test('too many keys for a bell: none (full reconcile)', () => {
    const keys = Array.from({ length: 2000 }, () => crypto.randomUUID());
    assert.strictEqual(sealKeys(keys, 'key-1', 'todos'), undefined);
  });

  test('keys are read exactly or not at all', () => {
    const image = (row: Record<string, unknown>) => ({ op: 'u' as const, row });
    assert.deepStrictEqual(keysOf([image({ id: 'a' }), image({ id: 7 }), image({ id: 'a' })], 'id'), ['a', '7']);
    assert.strictEqual(keysOf([image({ id: 2 ** 60 })], 'id'), null);
    assert.strictEqual(keysOf([image({ other: 1 })], 'id'), null);
  });
});

describe('written keys', () => {
  const tables = ['todos', 'app.lists'];
  test('plain writes on synced tables can carry RETURNING; others mark the transaction unknown', () => {
    assert.deepStrictEqual(classifyWrite(`INSERT INTO todos (id) VALUES ($1)`, tables), { table: 'todos', plain: true });
    assert.deepStrictEqual(classifyWrite(`UPDATE "todos" SET done = $1 WHERE id = $2;`, tables), { table: 'todos', plain: true });
    assert.deepStrictEqual(classifyWrite(`delete from public.todos where id = $1`, tables), { table: 'todos', plain: true });
    assert.deepStrictEqual(classifyWrite(`UPDATE app.lists SET n = 1`, tables), { table: 'app.lists', plain: true });
    assert.deepStrictEqual(classifyWrite(`INSERT INTO todos (id) VALUES ('a') RETURNING id`, tables), { table: 'todos', plain: false });
    assert.deepStrictEqual(classifyWrite(`WITH x AS (SELECT 1) INSERT INTO todos SELECT 'a'`, tables), { table: '', plain: false });
    assert.strictEqual(classifyWrite(`INSERT INTO users (id) VALUES ($1)`, tables), null);
    assert.strictEqual(classifyWrite(`SELECT * FROM todos`, tables), null);
    // A literal that looks like SQL does not fool it.
    assert.deepStrictEqual(classifyWrite(`UPDATE todos SET title = 'x; RETURNING y' WHERE id = $1`, tables), {
      table: 'todos',
      plain: true,
    });
  });
});

describe('reconcile protocol', () => {
  test('bucket digests are order-independent and change with any row', () => {
    const a = rowHash(['id', 'title'], { id: 'a', title: 'x' });
    const b = rowHash(['id', 'title'], { id: 'b', title: 'y' });
    assert.strictEqual(bucketDigest([a, b]), bucketDigest([b, a]));
    assert.notStrictEqual(bucketDigest([a, b]), bucketDigest([a]));
    assert.notStrictEqual(rowHash(['id', 'title'], { id: 'a', title: 'x2' }), a);
    assert.strictEqual(bucketDigest([]), '0000000000000000.0');
    assert.ok(bucketOf('a') >= 0 && bucketOf('a') < 256);
  });

  test('parses text values like Database shapes do', () => {
    assert.strictEqual(parseValue('42', 'int4'), 42);
    assert.strictEqual(parseValue('9007199254740993', 'int8'), 9007199254740993n);
    assert.strictEqual(parseValue('true', 'bool'), true);
    assert.strictEqual(parseValue('f', 'bool'), false);
    assert.deepStrictEqual(parseValue('{"a":1}', 'jsonb'), { a: 1 });
    assert.strictEqual(parseValue('1.50', 'numeric'), '1.50');
    assert.strictEqual(parseValue(null, 'text'), null);
    assert.deepStrictEqual(parseValue('{1,2,NULL}', '_int4'), [1, 2, null]);
    assert.deepStrictEqual(parseValue('{"a b","c\\"d",e}', '_text'), ['a b', 'c"d', 'e']);
    assert.deepStrictEqual(parseValue('{}', '_text'), []);
  });
});

describe('DistributedDatabase shapes (mock)', () => {
  const scope = new Scope(`dsqlsync${process.pid}`);
  const migrations = mkdtempSync(join(tmpdir(), 'bb-ddata-sync-'));
  writeFileSync(
    join(migrations, '001_todos.sql'),
    `CREATE TABLE todos (
       id TEXT PRIMARY KEY,
       owner_id TEXT NOT NULL,
       title TEXT NOT NULL,
       done BOOLEAN NOT NULL DEFAULT false,
       position INTEGER NOT NULL DEFAULT 0
     );`,
  );
  const db = new DistributedDatabase(scope, 'db', { migrationsPath: migrations, sync: { tables: ['todos'] } });
  const plain = new DistributedDatabase(scope, 'plain');
  // A second database for subqueries, routing, changes-only, and mapping.
  const boardMigrations = mkdtempSync(join(tmpdir(), 'bb-ddata-boards-'));
  writeFileSync(join(boardMigrations, '001_members.sql'), `CREATE TABLE members (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, user_id TEXT NOT NULL);`);
  writeFileSync(
    join(boardMigrations, '002_cards.sql'),
    `CREATE TABLE cards (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_by TEXT);`,
  );
  const boards = new DistributedDatabase(scope, 'boards', { migrationsPath: boardMigrations, sync: { tables: ['cards', 'members'] } });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const matched = matchRoute(req.method ?? 'GET', url.pathname);
    if (!matched) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let status = 200;
    let body: unknown = '';
    const headers = new Headers();
    const context: BlocksContext = {
      request: {
        headers: new Headers(),
        body: null,
        json: async () => JSON.parse(text),
        text: async () => text,
        url,
        params: matched.params,
      },
      response: {
        headers,
        get status() {
          return status;
        },
        set status(code: number) {
          status = code;
        },
        send: (value: unknown) => {
          body = value;
        },
      },
    };
    await matched.route.handler(context);
    res.writeHead(status, { 'content-type': 'application/json', ...Object.fromEntries(headers) });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  attach(server);
  let baseUrl = '';
  const shapes: Shape<unknown>[] = [];

  /** Hydrate a server shape the way the client middleware does. */
  const open = async <T>(shape: Shape<T>): Promise<Shape<T>> => {
    const live = new ReconcileShape<T>(shape.toJSON(), { resolveUrl: async (path) => `${baseUrl}${path}` });
    shapes.push(live);
    return live;
  };

  /** Run `fn` as an API call does: collect its response hints, then settle open shapes as the client does. */
  const asApiCall = async <T>(fn: () => Promise<T>) => {
    const { result, header } = await runWithResponseHints(fn);
    const hints = decodeResponseHints(header);
    await settle(hints);
    return { result, hints };
  };

  /** Resolve once `predicate` holds for the shape's rows. */
  const until = <T>(shape: Shape<T>, predicate: (rows: readonly T[]) => boolean): Promise<readonly T[]> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; rows: ${JSON.stringify(shape.rows)}`)), 10_000);
      const check = (rows: readonly T[]) => {
        if (predicate(rows)) {
          clearTimeout(timer);
          unsubscribe();
          resolve(rows);
        }
      };
      const unsubscribe = shape.subscribe(check);
      check(shape.rows);
    });

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    (globalThis as { __BLOCKS_REALTIME_WS_URL__?: string }).__BLOCKS_REALTIME_WS_URL__ = `ws://127.0.0.1:${port}/realtime`;
    await db.execute(sql`INSERT INTO todos (id, owner_id, title, position) VALUES ('a', 'u1', 'first', 1), ('b', 'u2', 'other', 2)`);
  });

  after(async () => {
    for (const shape of shapes) shape.close();
    closeWebSocketServer();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await (await db.getEngine()).destroy();
    await (await plain.getEngine()).destroy();
    await (await boards.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
    rmSync(`.bb-data/${plain.fullId}`, { recursive: true, force: true });
    rmSync(`.bb-data/${boards.fullId}`, { recursive: true, force: true });
    rmSync(`.bb-data/${scope.fullId}`, { recursive: true, force: true });
    rmSync(migrations, { recursive: true, force: true });
    rmSync(boardMigrations, { recursive: true, force: true });
  });

  test('issues a reconcile shape with a bell', async () => {
    const descriptor = (await db.shape<Todo>({ table: 'todos' })).toJSON();
    assert.strictEqual(descriptor.protocol, 'reconcile');
    assert.strictEqual(descriptor.key, 'id');
    assert.ok(descriptor.bell?.wsUrl.startsWith('ws://127.0.0.1:'));
    assert.match(descriptor.path, /^\/aws-blocks\/sync\/.+-db\/v1\/shape$/);
  });

  test('a server-side shape does not sync', async () => {
    const shape = await db.shape<Todo>({ table: 'todos' });
    await assert.rejects(shape.ready, /server-side handle/);
  });

  test('syncs the initial rows that match the filter, with parsed types', async () => {
    const shape = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u1'}` }));
    await shape.ready;
    assert.deepStrictEqual(shape.rows, [{ id: 'a', owner_id: 'u1', title: 'first', done: false, position: 1 }]);
    assert.strictEqual(shape.get('a')?.title, 'first');
    assert.strictEqual(shape.isUpToDate, true);
  });

  test('an API call that writes resolves with the write in the shape: inserts, updates, moves out, deletes', async () => {
    const shape = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u1'} AND done = ${false}` }));
    await shape.ready;

    const write = (statement: ReturnType<typeof sql>) =>
      asApiCall(() =>
        db.transaction(async (tx) => {
          await tx.execute(statement);
        }),
      );

    await write(sql`INSERT INTO todos (id, owner_id, title) VALUES ('c', 'u1', 'second')`);
    assert.strictEqual(shape.get('c')?.title, 'second');

    await write(sql`UPDATE todos SET title = 'renamed' WHERE id = 'c'`);
    assert.strictEqual(shape.get('c')?.title, 'renamed');

    await write(sql`UPDATE todos SET done = true WHERE id = 'a'`);
    assert.strictEqual(shape.get('a'), undefined, 'moved out of the filter');

    await write(sql`UPDATE todos SET done = false WHERE id = 'a'`);
    assert.strictEqual(shape.get('a')?.title, 'first', 'moved back in');

    await write(sql`DELETE FROM todos WHERE id = 'c'`);
    assert.strictEqual(shape.get('c'), undefined);
    assert.deepStrictEqual(
      shape.rows.map((row) => row.id),
      ['a'],
    );
  });

  test('the bell makes other clients reconcile without polling', async () => {
    const shape = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u1'}` }));
    await shape.ready;
    await db.execute(sql`INSERT INTO todos (id, owner_id, title) VALUES ('d', 'u1', 'from elsewhere')`);
    const started = Date.now();
    await until(shape, (rows) => rows.some((row) => row.id === 'd'));
    // The timer fallback is 3 s; the bell is near-immediate.
    assert.ok(Date.now() - started < 2_500, `took ${Date.now() - started} ms`);
  });

  test('another owner never sees the rows', async () => {
    const shape = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u2'}` }));
    await shape.ready;
    assert.deepStrictEqual(
      shape.rows.map((row) => row.id),
      ['b'],
    );
  });

  test('streams only the requested columns', async () => {
    const shape = await open(
      await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u2'}`, columns: ['id', 'title'] }),
    );
    await shape.ready;
    assert.deepStrictEqual(shape.rows, [{ id: 'b', title: 'other' }]);
  });

  test('handles thousands of rows', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO todos (id, owner_id, title, position)
        SELECT 'bulk-' || g, 'u3', 'Row ' || g, g FROM generate_series(1, 2500) AS g
      `);
    });
    const shape = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u3'}` }));
    await shape.ready;
    assert.strictEqual(shape.rows.length, 2500);
    assert.strictEqual(shape.get('bulk-1234')?.position, 1234);
  });

  test('rejects a tampered token and a wrong key', async () => {
    const descriptor = (await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u1'}` })).toJSON();
    const [payload, sig] = descriptor.token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), w: 'true' })).toString(
      'base64url',
    );
    const res = await fetch(`${baseUrl}${descriptor.path}?token=${forged}.${sig}`, { method: 'POST', body: '{"digest":{}}' });
    assert.strictEqual(res.status, 403);

    const wrongKey = await open(await db.shape<Todo>({ table: 'todos', key: 'title' }));
    await assert.rejects(wrongKey.ready, /not the primary key/);
  });

  test('rejects shapes outside the sync config', async () => {
    const invalid = (promise: Promise<unknown>) =>
      assert.rejects(promise, (e: unknown) => isBlocksError(e, DistributedDatabaseErrors.ShapeInvalid));
    await invalid(db.shape({ table: 'users' }));
    await invalid(db.shape<Todo>({ table: 'todos', columns: ['title'] }));
    await invalid(plain.shape({ table: 'todos' }));
  });

  /** Ring the bell as the AWS CDC consumer does: with the changed rows' keys. */
  const ringWithKeys = (keys: string[]) =>
    (db as unknown as { sync: SyncRuntime }).sync.ring('todos', {
      tsMs: Date.now(),
      images: keys.map((id) => ({ op: 'u' as const, row: { id } })),
    });

  test('a bell with keys syncs only those rows, including moves out of the filter', async () => {
    const shape = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'k1'} AND done = ${false}` }));
    // Write through the engine, not db: no bell rings by itself.
    const engine = await db.getEngine();
    await engine.execute(`INSERT INTO todos (id, owner_id, title) VALUES ('k-a', 'k1', 'one'), ('k-b', 'k1', 'two')`);
    await shape.ready;
    assert.strictEqual(shape.rows.length, 2);

    await engine.execute(`UPDATE todos SET title = 'one!' WHERE id = 'k-a'`);
    await engine.execute(`INSERT INTO todos (id, owner_id, title) VALUES ('k-c', 'k1', 'three'), ('k-x', 'k2', 'not mine')`);
    await ringWithKeys(['k-a', 'k-c', 'k-x']);
    await until(shape, () => shape.get('k-a')?.title === 'one!' && shape.get('k-c') !== undefined);
    assert.strictEqual(shape.get('k-x'), undefined, "another owner's row never arrives");

    await engine.execute(`UPDATE todos SET done = true WHERE id = 'k-b'`); // moves out
    await engine.execute(`DELETE FROM todos WHERE id = 'k-c'`);
    await ringWithKeys(['k-b', 'k-c']);
    await until(shape, () => shape.get('k-b') === undefined && shape.get('k-c') === undefined);
    assert.deepStrictEqual(
      shape.rows.map((row) => row.id),
      ['k-a'],
    );
  });

  test('a sealed list from another table falls back to a full reconcile', async () => {
    const descriptor = (await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'k1'}` })).toJSON();
    const foreign = sealKeys(['k-a'], 'some-other-key', 'todos');
    const res = await fetch(`${baseUrl}${descriptor.path}?token=${descriptor.token}`, {
      method: 'POST',
      body: JSON.stringify({ changed: [foreign] }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).full, true);
  });

  test('held keys return only rows in the shape', async () => {
    const descriptor = (await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'k1'}` })).toJSON();
    const res = await fetch(`${baseUrl}${descriptor.path}?token=${descriptor.token}`, {
      method: 'POST',
      body: JSON.stringify({ held: ['k-a', 'k-x', 'missing'] }),
    });
    const body = await res.json();
    assert.deepStrictEqual(
      body.rows.map((entry: [number, string, { id: string }]) => entry[2].id),
      ['k-a'],
    );
  });

  test('a large full reconcile comes in pages and converges', async () => {
    const server = new ReconcileServer(async () => db.getEngine(), 20_000);
    const claims = buildClaims<Todo>(db.fullId, { tables: ['todos'] }, { table: 'todos', where: sql`owner_id = ${'u3'}` });
    const digest: Record<string, string> = {};
    let pages = 0;
    let rows = 0;
    for (;;) {
      const result = await server.serve(claims, { digest }, 'unused');
      assert.ok('ndjson' in result);
      pages++;
      const lines = result.ndjson.split('\n').map((line) => JSON.parse(line));
      for (const line of lines) {
        if (!Array.isArray(line)) continue;
        const [bucket, entries] = line as [number, [string, unknown][]];
        rows += entries.length;
        digest[String(bucket)] = bucketDigest(entries.map(([hash]) => hash));
      }
      if (!lines.some((line) => !Array.isArray(line) && line.more)) break;
    }
    assert.ok(pages > 3, `expected several pages, got ${pages}`);
    assert.strictEqual(rows, 2500);
  });

  test('writes report their keys after commit; reads report nothing', async () => {
    const read = await asApiCall(() => db.query(sql`SELECT * FROM todos`));
    assert.deepStrictEqual(read.hints.values, {});
    const rolledBack = await runWithResponseHints(() =>
      db
        .transaction(async (tx) => {
          await tx.execute(sql`INSERT INTO todos (id, owner_id, title) VALUES (${'rb'}, ${'w1'}, ${'x'})`);
          throw new Error('abort');
        })
        .catch(() => null),
    );
    assert.strictEqual(rolledBack.header, null, 'a rolled-back transaction reports nothing');
  });

  test('own writes read only the written keys, and execute() keeps its rowCount', async () => {
    const shape = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'w1'}` }));
    await shape.ready;
    const bodies: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === 'string') bodies.push(init.body);
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const { result: rowCount, hints } = await asApiCall(() =>
        db.transaction(async (tx) => {
          const { rowCount } = await tx.execute(
            sql`INSERT INTO todos (id, owner_id, title) VALUES (${'w-a'}, ${'w1'}, ${'a'}), (${'w-b'}, ${'w1'}, ${'b'})`,
          );
          return rowCount;
        }),
      );
      assert.strictEqual(rowCount, 2);
      const [hint] = hints.values['data/sync'] as { keys?: string[]; full?: boolean; tables?: string[] }[];
      assert.strictEqual(hint.keys?.length, 1);
      assert.strictEqual(hint.full, undefined);
      assert.deepStrictEqual(hint.tables, ['todos']);
      assert.strictEqual(shape.get('w-a')?.title, 'a');
      assert.strictEqual(shape.get('w-b')?.title, 'b');
      const requests = bodies.map((body) => JSON.parse(body) as Record<string, unknown>);
      assert.ok(requests.some((body) => Array.isArray(body.written)), 'used the written keys');

      // A write outside a transaction is tracked too.
      bodies.length = 0;
      await asApiCall(() => db.execute(sql`UPDATE todos SET title = ${'b2'} WHERE id = ${'w-b'}`));
      assert.strictEqual(shape.get('w-b')?.title, 'b2');
      assert.ok(bodies.some((body) => 'written' in JSON.parse(body)));

      // A write the tracker can't rewrite falls back to a full reconcile, still correct.
      const untracked = await asApiCall(() => db.query(sql`UPDATE todos SET title = ${'a2'} WHERE id = ${'w-a'} RETURNING id`));
      const [fallback] = untracked.hints.values['data/sync'] as { full?: boolean }[];
      assert.strictEqual(fallback.full, true);
      assert.strictEqual(shape.get('w-a')?.title, 'a2');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  interface Card {
    id: string;
    board_id: string;
    title: string;
    position: number;
    created_by: string | null;
  }

  /** Requests each shape made (by token), to see which shapes a write woke. */
  const watchRequests = () => {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname.includes('/aws-blocks/sync/')) seen.push(url.searchParams.get('token') ?? '');
      return realFetch(input, init);
    }) as typeof fetch;
    return { seen, restore: () => (globalThis.fetch = realFetch) };
  };

  test('subquery filters: rows move in and out when the other table changes', async () => {
    await boards.execute(sql`INSERT INTO cards (id, board_id, title) VALUES ('c1', 'b1', 'one'), ('c2', 'b2', 'two')`);
    const shape = await open(
      await boards.shape<Card>({ table: 'cards', where: sql`board_id IN (SELECT board_id FROM members WHERE user_id = ${'alice'})` }),
    );
    await shape.ready;
    assert.deepStrictEqual(shape.rows, []);
    assert.strictEqual(shape.toJSON().dependencyBells?.length, 1);

    await boards.execute(sql`INSERT INTO members (id, board_id, user_id) VALUES ('m1', 'b1', 'alice')`); // join b1
    await until(shape, (rows) => rows.some((row) => row.id === 'c1'));
    await boards.execute(sql`DELETE FROM members WHERE id = 'm1'`); // leave b1
    await until(shape, (rows) => rows.length === 0);
  });

  test('equality routing: a write wakes only shapes on its value, and a changed value moves the row', async () => {
    const a = await open(await boards.shape<Card>({ table: 'cards', where: sql`board_id = ${'route-a'}` }));
    const b = await open(await boards.shape<Card>({ table: 'cards', where: sql`board_id = ${'route-b'}` }));
    await Promise.all([a.ready, b.ready]);
    // Written after the route exists, so the index knows each row's value.
    await boards.execute(sql`INSERT INTO cards (id, board_id, title) VALUES ('r1', 'route-a', 'a1'), ('r2', 'route-b', 'b1')`);
    await until(a, () => a.get('r1') !== undefined);
    const tokenB = b.toJSON().token;
    assert.notStrictEqual(a.toJSON().bell?.channel, b.toJSON().bell?.channel);

    const requests = watchRequests();
    try {
      await boards.execute(sql`UPDATE cards SET title = 'a1!' WHERE id = 'r1'`);
      await until(a, () => a.get('r1')?.title === 'a1!');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(!requests.seen.includes(tokenB), "a write on route-a doesn't wake route-b's shape");

      await boards.execute(sql`UPDATE cards SET board_id = 'route-b' WHERE id = 'r1'`); // moves from a to b
      await until(a, () => a.get('r1') === undefined);
      await until(b, () => b.get('r1')?.title === 'a1!');
      await boards.execute(sql`DELETE FROM cards WHERE id = 'r1'`); // deletes carry only the key
      await until(b, () => b.get('r1') === undefined);
    } finally {
      requests.restore();
    }
  });

  test('changes-only shapes: start empty, load pages with requestSnapshot, then stay live', async () => {
    await boards.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO cards (id, board_id, title, position)
        SELECT 'p' || g, 'paged', 'Card ' || g, g FROM generate_series(1, 30) AS g
      `);
    });
    const shape = await open(
      await boards.shape<Card>({ table: 'cards', where: sql`board_id = ${'paged'}`, mode: 'changes_only', queryableColumns: ['title', 'position'] }),
    );
    await shape.ready;
    assert.deepStrictEqual(shape.rows, []);

    const page = await shape.requestSnapshot({ orderBy: [{ field: 'position', direction: 'desc' }], limit: 5 });
    assert.deepStrictEqual(
      page.map((row) => row.position),
      [30, 29, 28, 27, 26],
    );
    const search = await shape.requestSnapshot({ where: { title: { like: 'Card 1%' } }, orderBy: [{ field: 'position' }] });
    assert.deepStrictEqual(
      search.map((row) => row.position),
      [1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    );
    assert.strictEqual(shape.rows.length, 16);

    await boards.execute(sql`UPDATE cards SET title = 'Top' WHERE id = 'p30'`); // a loaded row changes
    await until(shape, () => shape.get('p30')?.title === 'Top');
    await boards.execute(sql`INSERT INTO cards (id, board_id, title, position) VALUES ('p31', 'paged', 'New', 31)`); // a new row in the shape
    await until(shape, () => shape.get('p31') !== undefined);
    await boards.execute(sql`DELETE FROM cards WHERE id = 'p29'`);
    await until(shape, () => shape.get('p29') === undefined);

    await assert.rejects(shape.requestSnapshot({ where: { board_id: 'other' } as never }), /not a queryable column/);
    const full = await open(await boards.shape<Card>({ table: 'cards', where: sql`board_id = ${'paged'}` }));
    await assert.rejects(full.requestSnapshot({ limit: 1 }), /changes_only/);
  });

  test('column mapping: rows and snapshot queries use camelCase fields', async () => {
    interface CamelCard {
      id: string;
      boardId: string;
      title: string;
      createdBy: string | null;
    }
    await boards.execute(sql`INSERT INTO cards (id, board_id, title, created_by) VALUES ('m-1', 'mapped', 'Mapped', 'alice')`);
    const shape = await open(
      await boards.shape<CamelCard>({
        table: 'cards',
        where: sql`board_id = ${'mapped'}`,
        columns: ['id', 'boardId', 'title', 'createdBy'],
        columnMapping: 'snakeCamel',
      }),
    );
    await shape.ready;
    assert.deepStrictEqual(shape.get('m-1'), { id: 'm-1', boardId: 'mapped', title: 'Mapped', createdBy: 'alice' });
  });

  test('a schema change resets the shape and reloads it in the new form', async () => {
    const shape = await open(await boards.shape<Card & { color?: string }>({ table: 'cards', where: sql`board_id = ${'mapped'}` }));
    await shape.ready;
    assert.strictEqual(shape.get('m-1')?.color, undefined);
    const engine = (await boards.getEngine()) as unknown as { withDdl<R>(fn: () => Promise<R>): Promise<R>; execute(sql: string): Promise<unknown> };
    await engine.withDdl(() => engine.execute(`ALTER TABLE cards ADD COLUMN color TEXT`));
    // The server re-reads table metadata every minute; drop its cache so the test needn't wait.
    (boards as unknown as { sync: { server: { tables: Map<string, unknown> } } }).sync.server.tables.clear();
    await boards.execute(sql`UPDATE cards SET color = 'red' WHERE id = 'm-1'`);
    await until(shape, () => shape.get('m-1')?.color === 'red');
  });

});
