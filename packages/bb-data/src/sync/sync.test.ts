// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync (db.shape) tests: token claims, and the mock shape server driven end to
 * end by the real `@electric-sql/client` through `LiveShape`.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scope, matchRoute } from '@aws-blocks/core';
import type { BlocksContext } from '@aws-blocks/core';
import { isBlocksError } from '@aws-blocks/core';
import { sql } from '@aws-blocks/data-common';
import { Database, DatabaseErrors } from '../index.mock.js';
import { decodeResponseHints, runWithResponseHints } from '@aws-blocks/core/bb-utils';
import { settle } from '@aws-blocks/data-common/sync-client';
import { SETTLE_TIMEOUT_MS } from './live-shape.js';
import type { Shape } from '../types.js';
import { LiveShape } from './live-shape.js';
import { buildClaims, signClaims, verifyToken, deriveTokenKey, claimsToElectricParams, shapePath } from './shape-claims.js';

interface Todo {
  id: string;
  owner_id: string;
  title: string;
  done: boolean;
  position: number;
}

describe('shape claims', () => {
  const sync = { tables: ['todos'] };
  const key = deriveTokenKey('test-secret');

  test('signs the table, filter, params, and columns into the token', () => {
    const claims = buildClaims<Todo>('app-db', sync, {
      table: 'todos',
      where: sql`owner_id = ${'u1'} AND position > ${3}`,
      columns: ['id', 'title'],
    });
    const verdict = verifyToken(signClaims(claims, key), key, 'app-db');
    assert.ok(verdict.ok);
    assert.strictEqual(verdict.claims.w, 'owner_id = $1 AND position > $2');
    assert.deepStrictEqual(verdict.claims.p, ['u1', '3']);
    assert.strictEqual(
      claimsToElectricParams(verdict.claims).toString(),
      'table=todos&where=owner_id+%3D+%241+AND+position+%3E+%242&params%5B1%5D=u1&params%5B2%5D=3&columns=id%2Ctitle',
    );
  });

  test('rejects a tampered, expired, or foreign token', () => {
    const claims = buildClaims<Todo>('app-db', sync, { table: 'todos' });
    const token = signClaims(claims, key);
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, w: 'true' })).toString('base64url');
    assert.deepStrictEqual(verifyToken(`${forged}.${sig}`, key, 'app-db'), { ok: false, reason: 'signature' });
    assert.deepStrictEqual(verifyToken(`${payload}.${sig}`, deriveTokenKey('other'), 'app-db'), { ok: false, reason: 'signature' });
    assert.deepStrictEqual(verifyToken(token, key, 'other-db'), { ok: false, reason: 'database' });
    const expired = signClaims({ ...claims, exp: Date.now() - 1 }, key);
    assert.deepStrictEqual(verifyToken(expired, key, 'app-db'), { ok: false, reason: 'expired' });
    assert.deepStrictEqual(verifyToken(null, key, 'app-db'), { ok: false, reason: 'malformed' });
  });

  test('the endpoint path ignores the stack, so local and AWS agree', () => {
    // Local: the root scope's parent is a `{ id }` sentinel with no stack name.
    const local = { id: 'db', parent: { id: 'app', parent: { id: undefined } } };
    // AWS: the same tree under a stack (no `parent` of its own).
    const aws = { id: 'db', parent: { id: 'app', parent: { id: 'app-sandbox-abc123', node: {} } } };
    assert.strictEqual(shapePath(local), '/aws-blocks/sync/app-db/v1/shape');
    assert.strictEqual(shapePath(aws), '/aws-blocks/sync/app-db/v1/shape');
  });

  test('rejects shapes outside the sync config', () => {
    const invalid = (fn: () => unknown) =>
      assert.throws(fn, (e: unknown) => isBlocksError(e, DatabaseErrors.ShapeInvalid));
    invalid(() => buildClaims('app-db', undefined, { table: 'todos' }));
    invalid(() => buildClaims('app-db', sync, { table: 'users' }));
    invalid(() => buildClaims<Todo>('app-db', sync, { table: 'todos', columns: ['title'] }));
    invalid(() => buildClaims('app-db', sync, { table: 'todos', where: sql`owner_id = ${null}` }));
    invalid(() => buildClaims('app-db', sync, { table: 'todos', ttlSeconds: 0 }));
  });
});

describe('mock shape server', () => {
  const scope = new Scope(`synctest${process.pid}`);
  const migrations = mkdtempSync(join(tmpdir(), 'bb-data-sync-'));
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
  const db = new Database(scope, 'db', { migrationsPath: migrations, sync: { tables: ['todos'] } });
  const boardMigrations = mkdtempSync(join(tmpdir(), 'bb-data-boards-'));
  writeFileSync(
    join(boardMigrations, '001_boards.sql'),
    `CREATE TABLE members (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, user_id TEXT NOT NULL);
     CREATE TABLE cards (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_by TEXT);`,
  );
  const boards = new Database(scope, 'boards', { migrationsPath: boardMigrations, sync: { tables: ['cards', 'members'] } });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const matched = matchRoute(req.method ?? 'GET', url.pathname);
    if (!matched) {
      res.writeHead(404).end();
      return;
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let status = 200;
    let body: unknown = '';
    const headers = new Headers();
    const context: BlocksContext = {
      request: {
        headers: new Headers(),
        body: null,
        json: async () => ({}),
        text: async () => '',
        url,
        params: matched.params,
        signal: abort.signal,
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
  let baseUrl = '';
  const shapes: Shape<unknown>[] = [];

  const open = async <T>(shape: Shape<T>): Promise<Shape<T>> => {
    const live = new LiveShape<T>(shape.toJSON(), { resolveUrl: async (path) => `${baseUrl}${path}` });
    shapes.push(live);
    return live;
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
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await db.execute(sql`INSERT INTO todos (id, owner_id, title, position) VALUES ('a', 'u1', 'first', 1), ('b', 'u2', 'other', 2)`);
  });

  after(async () => {
    for (const shape of shapes) shape.close();
    // Let in-flight live requests observe the disconnect before the engine closes.
    await new Promise((resolve) => setTimeout(resolve, 250));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await (await db.getEngine()).destroy();
    await (await boards.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
    rmSync(`.bb-data/${boards.fullId}`, { recursive: true, force: true });
    rmSync(migrations, { recursive: true, force: true });
    rmSync(boardMigrations, { recursive: true, force: true });
  });

  test('syncs the initial rows that match the filter, with parsed types', async () => {
    const shape = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u1'}` }));
    await shape.ready;
    assert.deepStrictEqual(shape.rows, [{ id: 'a', owner_id: 'u1', title: 'first', done: false, position: 1 }]);
    assert.strictEqual(shape.get('a')?.title, 'first');
    assert.strictEqual(shape.isUpToDate, true);
  });

  test('applies inserts, updates, moves out of the filter, and deletes', async () => {
    const shape = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u1'} AND done = ${false}` }));
    await shape.ready;

    await db.execute(sql`INSERT INTO todos (id, owner_id, title) VALUES ('c', 'u1', 'second')`);
    await until(shape, (rows) => rows.some((row) => row.id === 'c'));

    await db.execute(sql`UPDATE todos SET title = 'renamed' WHERE id = 'c'`);
    await until(shape, () => shape.get('c')?.title === 'renamed');

    await db.execute(sql`UPDATE todos SET done = true WHERE id = 'a'`);
    await until(shape, () => shape.get('a') === undefined);

    await db.execute(sql`DELETE FROM todos WHERE id = 'c'`);
    await until(shape, (rows) => rows.length === 0);

    // Another owner's row never appears.
    await db.execute(sql`UPDATE todos SET title = 'still other' WHERE id = 'b'`);
    assert.strictEqual(shape.get('b'), undefined);
  });

  test('limits rows to the shape columns', async () => {
    const shape = await open(
      await db.shape<Pick<Todo, 'id' | 'title'>>({ table: 'todos', where: sql`id = ${'b'}`, columns: ['id', 'title'] }),
    );
    await shape.ready;
    assert.deepStrictEqual(shape.rows, [{ id: 'b', title: 'still other' }]);
  });

  /** Run `fn` as an API call does: collect its response hints, then settle open shapes as the client does. */
  const asApiCall = async <T>(fn: () => Promise<T>) => {
    const { result, header } = await runWithResponseHints(fn);
    const hints = decodeResponseHints(header);
    const started = Date.now();
    await settle(hints);
    return { result, hints, settledMs: Date.now() - started };
  };

  test('a write in an API call reports its txid; the shape has the row when the call resolves', async () => {
    const shape = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u3'}` }));
    await shape.ready;
    const { hints } = await asApiCall(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO todos (id, owner_id, title) VALUES ('d', 'u3', 'mine')`);
      }),
    );
    const [hint] = hints.values['data/sync'] as { txids: string[]; tables: string[] }[];
    assert.strictEqual(hint.txids.length, 1);
    assert.deepStrictEqual(hint.tables, ['todos']);
    assert.strictEqual(shape.get('d')?.title, 'mine');
  });

  test('a write outside a transaction is tracked too; a read reports nothing', async () => {
    const shape = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u3'}` }));
    await shape.ready;
    await asApiCall(() => db.execute(sql`UPDATE todos SET title = 'mine!' WHERE id = 'd'`));
    assert.strictEqual(shape.get('d')?.title, 'mine!');
    const read = await asApiCall(() => db.query(sql`SELECT * FROM todos`));
    assert.deepStrictEqual(read.hints.values, {});
  });

  test('with several shapes open, a write in one does not stall on the others', async () => {
    const mine = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u5'}` }));
    const other = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u6'}` }));
    await Promise.all([mine.ready, other.ready]);
    const { settledMs } = await asApiCall(() => db.execute(sql`INSERT INTO todos (id, owner_id, title) VALUES ('g', 'u5', 'mine')`));
    assert.strictEqual(mine.get('g')?.title, 'mine');
    assert.ok(settledMs < SETTLE_TIMEOUT_MS / 2, `settled in ${settledMs} ms`);
  });

  test('a write no open shape sees gives up after the timeout', async () => {
    const shape = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u3'}` }));
    await shape.ready;
    const { settledMs } = await asApiCall(() => db.execute(sql`INSERT INTO todos (id, owner_id, title) VALUES ('e', 'u4', 'theirs')`));
    assert.ok(settledMs >= SETTLE_TIMEOUT_MS - 50 && settledMs < SETTLE_TIMEOUT_MS + 1000, `settled in ${settledMs} ms`);
    assert.strictEqual(shape.get('e'), undefined);
  });

  test('a shape opened after the write sees it in its snapshot', async () => {
    const { hints } = await runWithResponseHints(() => db.execute(sql`INSERT INTO todos (id, owner_id, title) VALUES ('f', 'u3', 'later')`)).then(
      ({ header }) => ({ hints: decodeResponseHints(header) }),
    );
    const shape = await open(await db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${'u3'}` }));
    await shape.ready;
    const started = Date.now();
    await settle(hints);
    assert.ok(Date.now() - started < 200, 'visible in the snapshot: no wait');
    assert.strictEqual(shape.get('f')?.title, 'later');
  });

  test('rejects requests without a valid token', async () => {
    const shape = await db.shape<Todo>({ table: 'todos' });
    const { path, token } = shape.toJSON();
    const missing = await fetch(`${baseUrl}${path}?offset=-1`);
    assert.strictEqual(missing.status, 403);
    await missing.body?.cancel();
    const tampered = await fetch(`${baseUrl}${path}?offset=-1&token=${token.slice(0, -2)}xx`);
    assert.strictEqual(tampered.status, 403);
    assert.strictEqual((await tampered.json()).name, DatabaseErrors.ShapeInvalid);
  });

  test('answers an unknown handle with 409 must-refetch', async () => {
    const { path, token } = (await db.shape<Todo>({ table: 'todos' })).toJSON();
    const response = await fetch(`${baseUrl}${path}?offset=5_0&handle=nope&token=${token}`);
    assert.strictEqual(response.status, 409);
    assert.ok(response.headers.get('electric-handle'));
    assert.deepStrictEqual(await response.json(), [{ headers: { control: 'must-refetch' } }]);
  });

  test('a server-side shape handle does not sync', async () => {
    const shape = await db.shape<Todo>({ table: 'todos' });
    await assert.rejects(shape.ready, /server-side handle/);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(shape)).__blocks, 'data/shape');
  });

  interface Card {
    id: string;
    board_id: string;
    title: string;
    position: number;
    created_by: string | null;
  }

  test('subquery filters: rows move in and out when the other table changes', async () => {
    await boards.execute(sql`INSERT INTO cards (id, board_id, title) VALUES ('c1', 'b1', 'one'), ('c2', 'b2', 'two')`);
    const shape = await open(
      await boards.shape<Card>({ table: 'cards', where: sql`board_id IN (SELECT board_id FROM members WHERE user_id = ${'alice'})` }),
    );
    await shape.ready;
    assert.deepStrictEqual(shape.rows, []);
    await boards.execute(sql`INSERT INTO members (id, board_id, user_id) VALUES ('m1', 'b1', 'alice')`);
    await until(shape, (rows) => rows.some((row) => row.id === 'c1'));
    await boards.execute(sql`DELETE FROM members WHERE id = 'm1'`);
    await until(shape, (rows) => rows.length === 0);
  });

  test('a filter reading an unsynced table is rejected', async () => {
    await assert.rejects(
      db.shape({ table: 'todos', where: sql`owner_id IN (SELECT user_id FROM admins)` }),
      (e: unknown) => isBlocksError(e, DatabaseErrors.ShapeInvalid),
    );
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
    await until(shape, (rows) => rows.length === 5);
    const search = await shape.requestSnapshot({ where: { title: { like: 'Card 1%' } }, orderBy: [{ field: 'position' }] });
    assert.strictEqual(search.length, 11);
    await until(shape, (rows) => rows.length === 16);

    await boards.execute(sql`UPDATE cards SET title = 'Top' WHERE id = 'p30'`);
    await until(shape, () => shape.get('p30')?.title === 'Top');
    await boards.execute(sql`INSERT INTO cards (id, board_id, title, position) VALUES ('p31', 'paged', 'New', 31)`);
    await until(shape, () => shape.get('p31') !== undefined);
    await assert.rejects(shape.requestSnapshot({ where: { board_id: 'other' } as never }), (e: unknown) => e instanceof Error);
  });

  test('column mapping: rows use camelCase fields', async () => {
    interface CamelCard {
      id: string;
      boardId: string;
      createdBy: string | null;
    }
    await boards.execute(sql`INSERT INTO cards (id, board_id, title, created_by) VALUES ('m-1', 'mapped', 'Mapped', 'alice')`);
    const shape = await open(
      await boards.shape<CamelCard>({
        table: 'cards',
        where: sql`board_id = ${'mapped'}`,
        columns: ['id', 'boardId', 'createdBy'],
        columnMapping: 'snakeCamel',
      }),
    );
    await shape.ready;
    assert.deepStrictEqual(shape.get('m-1'), { id: 'm-1', boardId: 'mapped', createdBy: 'alice' });
  });

});
