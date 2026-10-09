/**
 * Backend — aws-blocks/index.ts
 *
 * Real-time todo app with per-user isolation and optimistic locking.
 *
 * This file defines your API, auth, data model, and real-time channels.
 * The frontend imports these exports directly via `import { ... } from 'aws-blocks'`.
 *
 * ─── IMPORTANT ───────────────────────────────────────────────────────────────
 * Do NOT use local files, in-memory arrays, or local databases for persistence.
 * Use Building Blocks for cloud persistence and other common cloud abstractions.
 * They work locally with automatic mocks and deploy to AWS with zero configuration.
 *
 * For the full list of blocks and how to use them, see:
 *   node_modules/@aws-blocks/blocks/README.md
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { ApiNamespace, ApiError, Scope, Auth, DistributedTable, Realtime } from '@aws-blocks/blocks';
import { z } from 'zod';

const scope = new Scope('my-app');

// ─── Auth ────────────────────────────────────────────────────────────────────
// Email + password sign-in (see node_modules/@aws-blocks/bb-auth/README.md).
// Sign-up confirms the email address with a 6-digit code; once the user enters
// it they are signed in automatically. On AWS, Cognito emails the code.
const auth = new Auth(scope, 'auth', {
  session: { crossDomain: process.env.BLOCKS_SANDBOX === 'true' },
  // Local dev only: no email is sent, so print the code in the `npm run dev`
  // terminal. Ignored on AWS.
  codeDelivery: async (username, code, purpose) => {
    console.log(`[auth] ${purpose} code for ${username}: ${code}`);
  },
});
export const authApi = auth.createApi();

// ─── Data ────────────────────────────────────────────────────────────────────
// Zod schema = runtime validation + TypeScript types + DynamoDB table shape.
const todoSchema = z.object({
  userSub: z.string(),      // partition key — the owner's stable id (per-user isolation)
  todoId: z.string(),       // sort key — unique within a user
  title: z.string(),
  completed: z.boolean(),
  priority: z.number(),     // 1=high, 2=medium, 3=low
  version: z.number(),      // optimistic locking — incremented on each update
  createdAt: z.number(),
});

const todos = new DistributedTable(scope, 'todos', {
  schema: todoSchema,
  key: { partitionKey: 'userSub', sortKey: 'todoId' },
});

// ─── Realtime ────────────────────────────────────────────────────────────────
const rt = new Realtime(scope, 'live', {
  namespaces: {
    todos: Realtime.namespace(z.object({
      action: z.enum(['created', 'updated', 'deleted']),
      todoId: z.string(),
    })),
  },
});

// ─── API ─────────────────────────────────────────────────────────────────────
export const api = new ApiNamespace(scope, 'api', (context) => ({

  async subscribeTodos() {
    const user = await auth.requireAuth(context);
    return rt.getChannel('todos', user.userSub);
  },

  async createTodo(title: string, priority: number = 2) {
    const user = await auth.requireAuth(context);
    const todoId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const todo = {
      userSub: user.userSub,
      todoId,
      title,
      completed: false,
      priority,
      version: 1,
      createdAt: Date.now(),
    };
    await todos.put(todo);
    await rt.publish('todos', user.userSub, { action: 'created' as const, todoId });
    return todo;
  },

  /** List todos, optionally sorted by priority or title. */
  async listTodos(sortBy?: 'priority' | 'title') {
    const user = await auth.requireAuth(context);
    const list = await Array.fromAsync(
      todos.query({ where: { userSub: { equals: user.userSub } } })
    );
    // Sort in the API (not via a secondary index) — a per-user todo list is
    // small, so an in-memory sort is simpler and avoids provisioning GSIs.
    if (sortBy === 'priority') return list.sort((a, b) => a.priority - b.priority);
    if (sortBy === 'title') return list.sort((a, b) => a.title.localeCompare(b.title));
    // Default: creation order (sorted by todoId).
    return list;
  },

  /**
   * Toggle todo completion with optimistic locking.
   * Uses `ifFieldEquals` to detect concurrent writes. On conflict,
   * throws ConditionalCheckFailedException — caller should re-read and retry.
   */
  async toggleTodo(todoId: string) {
    const user = await auth.requireAuth(context);
    const todo = await todos.get({ userSub: user.userSub, todoId });
    if (!todo) throw new ApiError('Todo not found', 404, { name: 'TodoNotFoundException' });
    await todos.put(
      { ...todo, completed: !todo.completed, version: todo.version + 1 },
      { ifFieldEquals: { version: todo.version } },
    );
    await rt.publish('todos', user.userSub, { action: 'updated' as const, todoId });
    return { success: true };
  },

  /** Update a todo's priority with optimistic locking. */
  async updatePriority(todoId: string, priority: number) {
    const user = await auth.requireAuth(context);
    const todo = await todos.get({ userSub: user.userSub, todoId });
    if (!todo) throw new ApiError('Todo not found', 404, { name: 'TodoNotFoundException' });
    await todos.put(
      { ...todo, priority, version: todo.version + 1 },
      { ifFieldEquals: { version: todo.version } },
    );
    await rt.publish('todos', user.userSub, { action: 'updated' as const, todoId });
    return { success: true };
  },

  /** Delete a todo. Broadcasts 'deleted' to all connected clients. */
  async deleteTodo(todoId: string) {
    const user = await auth.requireAuth(context);
    await todos.delete({ userSub: user.userSub, todoId });
    await rt.publish('todos', user.userSub, { action: 'deleted' as const, todoId });
    return { success: true };
  },
}));
