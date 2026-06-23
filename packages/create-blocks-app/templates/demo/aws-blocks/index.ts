import { ApiNamespace, Scope, KVStore, AuthBasic, DistributedTable } from '@aws-blocks/blocks';
import crypto from 'node:crypto';
import { z } from 'zod';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Building Blocks to see docstrings with usage, best practices, and performance characteristics
const scope = new Scope('my-app');

// Building Blocks: Use these instead of creating custom storage
const store = new KVStore(scope, 'app-store', {});


const auth = new AuthBasic(scope, 'auth', {
  crossDomain: process.env.BLOCKS_SANDBOX === 'true',
});

// DistributedTable: Use Zod schemas for type-safe tables with indexes
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
  },
  indexes: {
    byPriority: {
      partitionKey: 'userId',
      sortKey: 'priority'
    },
    byTitle: {
      partitionKey: 'userId',
      sortKey: 'title'
    },
    byCreatedAt: {
      partitionKey: 'userId',
      sortKey: 'createdAt'
    }
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
  // ── Public (no requireAuth) — anyone can call these ──────────────────
  async getValue(key: string) {
    return await store.get(key);
  },
  
  async setValue(key: string, value: string) {
    await store.put(key, value);
    return { success: true };
  },
  
  // ── Public — cookie round-trip demo ──────────────────────────────────
  async setCookie(name: string, value: string) {
    context.response.headers.set('set-cookie', `${name}=${value}; Max-Age=3600; Secure; SameSite=None; Partitioned`);
    return { success: true };
  },
  
  async getCookie(name: string) {
    const cookies = context.request.headers.get('cookie') || '';
    const match = cookies.split('; ').find(c => c.startsWith(`${name}=`));
    return match ? match.split('=')[1] : null;
  },
  
  async deleteCookie(name: string) {
    context.response.headers.set('set-cookie', `${name}=; Max-Age=0; Secure; SameSite=None; Partitioned`);
    return { success: true };
  },

  // DistributedTable example methods
  // ── Protected (requireAuth) — these gate before touching per-user data ─
  async createTodo(title: string, priority: number = 2): Promise<Todo> {
    const user = await auth.requireAuth(context);
    
    // ULID: timestamp-based sortable ID
    const ulid = Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
    
    const todo = {
      userId: user.username,
      todoId: ulid,
      title,
      completed: false,
      priority,
      createdAt: Date.now()
    };
    await todos.put(todo);
    return todo;
  },

  async listTodos(sortBy?: 'priority' | 'title' | 'createdAt'): Promise<Todo[]> {
    const user = await auth.requireAuth(context);

    const indexMap = {
      priority: 'byPriority',
      title: 'byTitle',
      createdAt: 'byCreatedAt'
    } as const;

    const iterator = todos.query({
      index: sortBy ? indexMap[sortBy] : 'byCreatedAt',
      where: { userId: { equals: user.username } }
    });

    return await Array.fromAsync(iterator);
  },

  async updateTodo(todoId: string, updates: { completed?: boolean; priority?: number; title?: string }) {
    const user = await auth.requireAuth(context);
    
    const existing = await todos.get({ userId: user.username, todoId });
    if (!existing) throw new Error('Todo not found');
    
    await todos.put({ ...existing, ...updates });
    return { success: true };
  },

  async deleteTodo(todoId: string) {
    const user = await auth.requireAuth(context);
    
    await todos.delete({ userId: user.username, todoId });
    return { success: true };
  }
}));
