// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Sync Todos — a local-first todo list backed by Database sync.
//
// Reads: `todos()` returns a live shape. The browser keeps a local copy of the
// caller's rows and applies changes as they happen, so lookups never touch the
// network. Writes: ordinary API methods. Each returns the transaction id, so
// the client can wait until its own write has synced back.

import { ApiNamespace, AuthBasic, Database, Scope, currentTxid, sql } from '@aws-blocks/blocks';

const scope = new Scope('sync-todos');

const auth = new AuthBasic(scope, 'auth', { sessionDuration: 86400 });
export const authApi = auth.createApi();

const db = new Database(scope, 'db', {
  migrationsPath: './aws-blocks/migrations',
  sync: { tables: ['todos'] },
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

export const api = new ApiNamespace(scope, 'api', (context) => ({
  /** The caller's todos, as a live shape. */
  async todos() {
    const user = await auth.requireAuth(context);
    return db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${user.userId}` });
  },

  async addTodo(title: string) {
    const user = await auth.requireAuth(context);
    const id = crypto.randomUUID();
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO todos (id, owner_id, title, position)
        VALUES (${id}, ${user.userId}, ${title}, (SELECT COALESCE(MAX(position), 0) + 1 FROM todos WHERE owner_id = ${user.userId}))
      `);
      return { id, txid: await currentTxid(tx) };
    });
  },

  async setDone(id: string, done: boolean) {
    const user = await auth.requireAuth(context);
    return db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE todos SET done = ${done} WHERE id = ${id} AND owner_id = ${user.userId}`);
      return { txid: await currentTxid(tx) };
    });
  },

  async deleteTodo(id: string) {
    const user = await auth.requireAuth(context);
    return db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM todos WHERE id = ${id} AND owner_id = ${user.userId}`);
      return { txid: await currentTxid(tx) };
    });
  },

  /** Insert `count` generated todos for the caller, to measure local reads at scale. */
  async seed(count: number) {
    const user = await auth.requireAuth(context);
    const n = Math.max(1, Math.min(MAX_SEED, Math.floor(count)));
    return db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO todos (id, owner_id, title, position)
        SELECT gen_random_uuid()::text, ${user.userId}, 'Seeded todo ' || g, g
          FROM generate_series(1, ${n}::int) AS g
      `);
      return { inserted: n, txid: await currentTxid(tx) };
    });
  },

  async clearTodos() {
    const user = await auth.requireAuth(context);
    return db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM todos WHERE owner_id = ${user.userId}`);
      return { txid: await currentTxid(tx) };
    });
  },
}));
