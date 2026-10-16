import { ApiNamespace, ApiError, Scope, KVStore, AuthBasic, DistributedTable } from '@aws-blocks/blocks';
import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Cookie round-trip demo. The name is fixed so callers can't overwrite the
 * auth session cookie (or any other cookie) on your domain. `HttpOnly` keeps
 * it out of reach of page scripts and `SameSite=Lax` keeps it off cross-site
 * requests. The value is URI-encoded, so CR/LF or `;` can't inject headers or
 * cookie attributes.
 */
const DEMO_COOKIE = 'blocks-demo';
const DEMO_COOKIE_ATTRS = 'HttpOnly; Secure; SameSite=Lax';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Building Blocks to see docstrings with usage, best practices, and performance characteristics
const scope = new Scope('my-app');

// Building Blocks: Use these instead of creating custom storage
const store = new KVStore(scope, 'app-store', {});

const auth = new AuthBasic(scope, 'auth');

// DistributedTable: Use Zod schemas for type-safe tables
const todoSchema = z.object({
  userId: z.string(),
  todoId: z.string(),
  title: z.string(),
  completed: z.boolean(),
  priority: z.number(), // 1=high, 2=medium, 3=low
  createdAt: z.number()
});

/** Inferred Todo type — used in return type annotations so the spec emitter
 *  produces a named `Todo` schema in `components.schemas` with `$ref` pointers. */
interface Todo {
  userId: string;
  todoId: string;
  title: string;
  completed: boolean;
  priority: number;
  createdAt: number;
}

const todos = new DistributedTable(scope, 'todos', {
  schema: todoSchema,
  key: {
    partitionKey: 'userId',
    sortKey: 'todoId'
  }
});

// Simple hello world API for testing CDK deployment
export const hello = new ApiNamespace(scope, 'hello', (context) => ({
  async greet(name: string) {
    return { message: `Hello, ${name}!`, timestamp: Date.now() };
  }
}));

export const authApi = auth.createApi();

export const api = new ApiNamespace(scope, 'api', (context) => ({
  // ── Protected (requireAuth) — keys are namespaced per user ────────────
  async getValue(key: string) {
    const user = await auth.requireAuth(context);
    return await store.get(`${user.username}:${key}`);
  },
  
  async setValue(key: string, value: string) {
    const user = await auth.requireAuth(context);
    await store.put(`${user.username}:${key}`, value);
    return { success: true };
  },
  
  // ── Public — cookie round-trip demo (fixed cookie name) ──────────────
  async setCookie(value: string) {
    context.response.headers.set(
      'set-cookie',
      `${DEMO_COOKIE}=${encodeURIComponent(value)}; Max-Age=3600; ${DEMO_COOKIE_ATTRS}`,
    );
    return { success: true };
  },
  
  async getCookie() {
    const cookies = context.request.headers.get('cookie') || '';
    const match = cookies.split('; ').find(c => c.startsWith(`${DEMO_COOKIE}=`));
    if (!match) return null;
    try {
      return decodeURIComponent(match.slice(DEMO_COOKIE.length + 1));
    } catch {
      return null; // malformed value sent by the client
    }
  },
  
  async deleteCookie() {
    context.response.headers.set('set-cookie', `${DEMO_COOKIE}=; Max-Age=0; ${DEMO_COOKIE_ATTRS}`);
    return { success: true };
  },

  // DistributedTable example methods
  // ── Protected (requireAuth) — these gate before touching per-user data ─
  async createTodo(title: string, priority: number = 2): Promise<Todo> {
    const user = await auth.requireAuth(context);
    
    // ULID: timestamp-based sortable ID
    const now = Date.now();
    const ulid = now.toString(36) + crypto.randomBytes(8).toString('hex');
    const todo = { userId: user.username, todoId: ulid, title, completed: false, priority, createdAt: now };
    await todos.put(todo);
    return todo;
  },

  async listTodos(sortBy?: 'priority' | 'title' | 'createdAt'): Promise<Todo[]> {
    const user = await auth.requireAuth(context);

    const list = await Array.fromAsync(
      todos.query({ where: { userId: { equals: user.username } } })
    );

    // Sort in the API (not via a secondary index) — a per-user todo list is
    // small, so an in-memory sort is simpler and avoids provisioning GSIs.
    // demo only: loads all todos into memory, no pagination. query() accepts a `limit` for real apps.
    if (sortBy === 'priority') return list.sort((a, b) => a.priority - b.priority);
    if (sortBy === 'title') return list.sort((a, b) => a.title.localeCompare(b.title));
    // Default (and 'createdAt'): newest-last by creation time.
    return list.sort((a, b) => a.createdAt - b.createdAt);
  },

  async updateTodo(todoId: string, updates: { completed?: boolean; priority?: number; title?: string }) {
    const user = await auth.requireAuth(context);
    
    const existing = await todos.get({ userId: user.username, todoId });
    if (!existing) throw new ApiError('Todo not found', 404, { name: 'TodoNotFoundException' });
    
    await todos.put({ ...existing, ...updates });
    return { success: true };
  },

  async deleteTodo(todoId: string) {
    const user = await auth.requireAuth(context);
    
    await todos.delete({ userId: user.username, todoId });
    return { success: true };
  }
}));
