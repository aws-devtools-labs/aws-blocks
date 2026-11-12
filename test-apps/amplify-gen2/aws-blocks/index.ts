import { ApiNamespace, Scope } from '@aws-blocks/core';
import { Auth } from '@aws-blocks/bb-auth';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { DistributedDatabase } from '@aws-blocks/bb-distributed-data';
import { sql } from '@aws-blocks/data-common';

// Keep the Scope id a STABLE LOGICAL id — it must be byte-for-byte identical at
// synth time and at Lambda runtime, since physical resource names (tables, IAM
// grants, env-var keys) are derived from it. Per-deployment uniqueness already
// comes from the stack name, which BlocksBackend folds in via BLOCKS_STACK_NAME. Do
// NOT mix in build-only values (e.g. BLOCKS_STACK_SUFFIX) — they are absent at
// runtime, so the names baked at synth would not match what the code looks up.
const scope = new Scope('amp-gen2');

const store = new KVStore(scope, 'notes', {});

const db = new DistributedDatabase(scope, 'db', {
  migrationsPath: './aws-blocks/migrations',
});

// Amplify's user pool, wrapped. At synth amplify/blocks.ts sets these to CDK
// tokens; in the Lambda they are unset, and `Auth` reads the deployed pool and
// client ids from its own config. With `allowBearerAuth` on, the guards accept
// the **access** tokens of the client given to `fromExisting` (aws-blocks/client.js
// sends them).
const auth = new Auth(scope, 'auth', {
  userPool: Auth.fromExisting(process.env.AMPLIFY_USER_POOL_ID ?? '', process.env.AMPLIFY_USER_POOL_CLIENT_ID),
  allowBearerAuth: true,
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  // Public — no auth required
  async greet(name: string) {
    return { message: `Hello from Blocks, ${name}!`, timestamp: Date.now() };
  },

  // Protected — requires signed-in user
  async putNote(key: string, value: string) {
    const user = await auth.requireAuth(context);
    await store.put(`${user.userSub}:${key}`, value);
    return { success: true };
  },

  async getNote(key: string) {
    const user = await auth.requireAuth(context);
    return { value: await store.get(`${user.userSub}:${key}`) };
  },

  // ── Database (Aurora DSQL) ──────────────────────────────────────────────

  async createTodo(title: string) {
    const user = await auth.requireAuth(context);
    const id = `todo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await db.execute(sql`
      INSERT INTO todos (id, title, owner_id) VALUES (${id}, ${title}, ${user.userSub})
    `);
    return { id, title, ownerId: user.userSub };
  },

  async listTodos() {
    const user = await auth.requireAuth(context);
    const rows = await db.query<{ id: string; title: string; completed: boolean; created_at: string }>(sql`
      SELECT id, title, completed, created_at FROM todos WHERE owner_id = ${user.userSub} ORDER BY created_at DESC
    `);
    return rows;
  },

  async completeTodo(id: string) {
    const user = await auth.requireAuth(context);
    const result = await db.execute(sql`
      UPDATE todos SET completed = true WHERE id = ${id} AND owner_id = ${user.userSub}
    `);
    return { success: result.rowCount > 0 };
  },

  async deleteTodo(id: string) {
    const user = await auth.requireAuth(context);
    const result = await db.execute(sql`
      DELETE FROM todos WHERE id = ${id} AND owner_id = ${user.userSub}
    `);
    return { success: result.rowCount > 0 };
  },
}));
