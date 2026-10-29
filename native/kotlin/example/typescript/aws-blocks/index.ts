import { ApiNamespace, Scope, KVStore, Auth, AppSetting, DistributedTable, Realtime, FileBucket, relayOrigin } from '@aws-blocks/blocks';
import type { RealtimeChannel } from '@aws-blocks/blocks';
export type { RealtimeChannel } from '@aws-blocks/blocks';
import crypto from 'node:crypto';
import { z } from 'zod';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Building Blocks to see docstrings with usage, best practices, and performance characteristics
const scope = new Scope('my-app');

// Building Blocks: Use these instead of creating custom storage
const store = new KVStore(scope, 'app-store', {});


// Google sign-in, federated directly by this backend (no Cognito user pool).
// The client ID is public, so it is a plain string: replace the placeholder with
// your OAuth client's ID. The client secret is a secret AppSetting. See README →
// "Configuring OIDC".
const GOOGLE_CLIENT_ID = 'replace-me.apps.googleusercontent.com';
const googleClientSecret = new AppSetting(scope, 'google-client-secret', { secret: true });

const auth = new Auth(scope, 'auth', {
  emailPassword: false,
  oidcProviders: {
    google: {
      issuer: 'https://accounts.google.com',
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: googleClientSecret,
      federateVia: 'direct',
    },
  },
  // Lets native clients authenticate with `Authorization: Bearer <access token>`
  // (the Swift and Dart SDKs do). The Kotlin apps use the session cookie.
  allowBearerAuth: true,
  redirects: {
    allowedRelayOrigins: [relayOrigin('blocks.testapp://oidcRedirect')],
  },
});

// DistributedTable: Use Zod schemas for type-safe tables with indexes.
// Per-user todos: the partition key is the owner's `userSub` (stable for the
// user's lifetime), and every method below reads and writes only the caller's
// partition, so one user can never list, read or change another user's todos.
const todoSchema = z.object({
  userSub: z.string(),
  todoId: z.string(),
  title: z.string(),
  completed: z.boolean(),
  priority: z.number(), // 1=high, 2=medium, 3=low
  createdAt: z.number()
});

/** Inferred Todo type — used in return type annotations so the spec emitter
 *  produces a named `Todo` schema in `components.schemas` with `$ref` pointers. */
interface Todo {
  userSub: string;
  todoId: string;
  title: string;
  completed: boolean;
  priority: number;
  createdAt: number;
}

const todos = new DistributedTable(scope, 'todos', {
  schema: todoSchema,
  key: {
    partitionKey: 'userSub',
    sortKey: 'todoId'
  },
  indexes: {
    byPriority: {
      partitionKey: 'userSub',
      sortKey: 'priority'
    },
    byTitle: {
      partitionKey: 'userSub',
      sortKey: 'title'
    },
    byCreatedAt: {
      partitionKey: 'userSub',
      sortKey: 'createdAt'
    }
  }
});

// Realtime - Cursor tracking (same pattern as Kotlin example app)
const cursorSchema = z.object({ userId: z.string(), x: z.number(), y: z.number(), color: z.string() });

export interface Cursor {
  userId: string;
  x: number;
  y: number;
  color: string;
}

const realtime = new Realtime(scope, 'collab', {
  namespaces: {
    cursors: Realtime.namespace(cursorSchema),
  },
});

// FileBucket - File storage (S3)
const bucket = new FileBucket(scope, 'files', {});

// Simple hello world API for testing CDK deployment
export const hello = new ApiNamespace(scope, 'hello', (context) => ({
  async greet(name: string) {
    return { message: `Hello, ${name}!`, timestamp: Date.now() };
  }
}));

export const authApi = auth.createApi();

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getCursorChannel(): Promise<RealtimeChannel<Cursor>> {
    return realtime.getChannel('cursors', 'default');
  },

  async publishCursor(cursor: Cursor) {
    await realtime.publish('cursors', 'default', cursor);
  },

  async getUploadUrl(path: string, contentType?: string) {
    return await bucket.createUploadHandle(path, contentType ? { contentType } : undefined);
  },

  async getDownloadUrl(path: string) {
    return await bucket.getFileHandle(path);
  },

  async getValue(key: string) {
    return await store.get(key);
  },
  
  async setValue(key: string, value: string) {
    await store.put(key, value);
    return { success: true };
  },
  
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
  async createTodo(title: string, priority: number = 2): Promise<Todo> {
    const user = await auth.requireAuth(context);
    
    // ULID: timestamp-based sortable ID
    const ulid = Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
    
    const todo = {
      userSub: user.userSub,
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
    
    // Query the caller's partition: through an index for a sort order, else the
    // table's primary key. Never scan() per-user data — a scan reads every user's.
    const iterator = sortBy
      ? todos.query({ index: indexMap[sortBy], where: { userSub: { equals: user.userSub } } })
      : todos.query({ where: { userSub: { equals: user.userSub } } });
    
    return await Array.fromAsync(iterator);
  },

  async updateTodo(todoId: string, updates: { completed?: boolean; priority?: number; title?: string }) {
    const user = await auth.requireAuth(context);
    
    const existing = await todos.get({ userSub: user.userSub, todoId });
    if (!existing) throw new Error('Todo not found');

    // Copy only the editable fields. The RPC layer does not strip properties the
    // signature doesn't declare, so spreading `updates` would let a caller rewrite
    // `userSub` / `todoId` and write into another user's partition.
    const { completed, priority, title } = updates ?? {};
    await todos.put({
      ...existing,
      ...(completed !== undefined ? { completed } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(title !== undefined ? { title } : {}),
    });
    return { success: true };
  },

  async deleteTodo(todoId: string) {
    const user = await auth.requireAuth(context);
    
    await todos.delete({ userSub: user.userSub, todoId });
    return { success: true };
  }
}));
