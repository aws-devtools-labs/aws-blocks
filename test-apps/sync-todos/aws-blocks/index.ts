// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Sync Todos — a local-first todo list backed by database sync.
//
// Reads: `todos()` returns a live shape. The browser keeps a local copy of the
// caller's rows and applies changes as they happen, so lookups never touch the
// network. Writes: ordinary API methods. When one returns, the shape already
// has the write.
//
// The same app runs on either engine:
//   SYNC_TODOS_ENGINE=aurora (default): Database — Aurora + Electric
//   SYNC_TODOS_ENGINE=dsql:             DistributedDatabase — Aurora DSQL + CDC

import {
  ApiNamespace,
  AuthBasic,
  Database,
  DistributedDatabase,
  Scope,
  sql,
} from '@aws-blocks/blocks';
import type { Shape, ShapeOptions, Transaction } from '@aws-blocks/blocks';

const scope = new Scope('sync-todos');

const auth = new AuthBasic(scope, 'auth', { sessionDuration: 86400 });
export const authApi = auth.createApi();

/** What this app needs from either engine. */
interface SyncedDatabase {
  shape<T>(options: ShapeOptions<T>): Promise<Shape<T>>;
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  execute(query: ReturnType<typeof sql>): Promise<{ rowCount: number }>;
}

const engine = process.env.SYNC_TODOS_ENGINE === 'dsql' ? 'dsql' : 'aurora';

const db: SyncedDatabase =
  engine === 'dsql'
    ? new DistributedDatabase(scope, 'dsql', {
        migrationsPath: './aws-blocks/migrations-dsql',
        sync: { tables: ['todos', 'todo_shares'] },
      })
    : new Database(scope, 'db', {
        migrationsPath: './aws-blocks/migrations',
        sync: { tables: ['todos', 'todo_shares'] },
      });

export interface Todo {
  id: string;
  owner_id: string;
  title: string;
  done: boolean;
  position: number;
  /** `timestamptz` arrives as a string. */
  created_at: string;
}

/** Most rows `seed()` inserts in one call. */
const MAX_SEED = 5000;

/** Rows per write transaction; under Aurora DSQL's limit of 3,000. */
const ROWS_PER_TRANSACTION = 2500;

export const api = new ApiNamespace(scope, 'api', (context) => ({
  /** The caller's todos, as a live shape. */
  async todos() {
    const user = await auth.requireAuth(context);
    return db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${user.userId}` });
  },

  /** Todos other users shared with the caller: a filter that reads another table. */
  async sharedWithMe() {
    const user = await auth.requireAuth(context);
    return db.shape<Todo>({
      table: 'todos',
      where: sql`id IN (SELECT todo_id FROM todo_shares WHERE user_id = ${user.userId})`,
    });
  },

  /** The caller's todos as a changes-only shape: load pages with requestSnapshot(). */
  async pagedTodos() {
    const user = await auth.requireAuth(context);
    return db.shape<Todo>({
      table: 'todos',
      where: sql`owner_id = ${user.userId}`,
      mode: 'changes_only',
      queryableColumns: ['title', 'done', 'position'],
    });
  },

  async whoami() {
    const user = await auth.requireAuth(context);
    return { userId: user.userId };
  },

  async share(todoId: string, userId: string) {
    const user = await auth.requireAuth(context);
    const own = await db.transaction((tx) => tx.queryOne(sql`SELECT id FROM todos WHERE id = ${todoId} AND owner_id = ${user.userId}`));
    if (!own) throw new Error('Not your todo');
    await db.execute(sql`INSERT INTO todo_shares (id, todo_id, user_id) VALUES (${crypto.randomUUID()}, ${todoId}, ${userId})`);
  },

  async unshare(todoId: string) {
    const user = await auth.requireAuth(context);
    const own = await db.transaction((tx) => tx.queryOne(sql`SELECT id FROM todos WHERE id = ${todoId} AND owner_id = ${user.userId}`));
    if (!own) throw new Error('Not your todo');
    await db.execute(sql`DELETE FROM todo_shares WHERE todo_id = ${todoId}`);
  },

  async addTodo(title: string) {
    const user = await auth.requireAuth(context);
    const id = crypto.randomUUID();
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO todos (id, owner_id, title, position)
        VALUES (${id}, ${user.userId}, ${title}, (SELECT COALESCE(MAX(position), 0) + 1 FROM todos WHERE owner_id = ${user.userId}))
      `);
      return { id };
    });
  },

  async setDone(id: string, done: boolean) {
    const user = await auth.requireAuth(context);
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE todos SET done = ${done} WHERE id = ${id} AND owner_id = ${user.userId}`);
    });
  },

  async deleteTodo(id: string) {
    const user = await auth.requireAuth(context);
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM todos WHERE id = ${id} AND owner_id = ${user.userId}`);
    });
  },

  /** Insert `count` generated todos for the caller, to measure local reads at scale. */
  async seed(count: number) {
    const user = await auth.requireAuth(context);
    const n = Math.max(1, Math.min(MAX_SEED, Math.floor(count)));
    // Aurora DSQL changes at most 3,000 rows per transaction: insert in chunks.
    for (let start = 1; start <= n; start += ROWS_PER_TRANSACTION) {
      const end = Math.min(n, start + ROWS_PER_TRANSACTION - 1);
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO todos (id, owner_id, title, position)
          SELECT gen_random_uuid()::text, ${user.userId}, 'Seeded todo ' || g, g
            FROM generate_series(${start}::int, ${end}::int) AS g
        `);
      });
    }
    return { inserted: n };
  },

  async clearTodos() {
    const user = await auth.requireAuth(context);
    for (;;) {
      const { rowCount } = await db.execute(sql`
        DELETE FROM todos WHERE id IN (
          SELECT id FROM todos WHERE owner_id = ${user.userId} LIMIT ${ROWS_PER_TRANSACTION}
        )
      `);
      if (rowCount < ROWS_PER_TRANSACTION) break;
    }
  },
}));
