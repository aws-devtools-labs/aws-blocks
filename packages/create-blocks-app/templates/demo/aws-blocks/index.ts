import { ApiNamespace, ApiError, Scope, KVStore, Auth, DistributedTable, FileBucket, AppSetting, AsyncJob, EmailClient } from '@aws-blocks/blocks';
import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Reject cookie name/value components that contain CR or LF characters.
 * Prevents HTTP response-header (Set-Cookie) injection from user-controlled input.
 */
function assertNoCrlf(value: string, field: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid cookie ${field}: must not contain CR or LF characters`);
  }
}

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Building Blocks to see docstrings with usage, best practices, and performance characteristics
const scope = new Scope('my-app');

// Building Blocks: Use these instead of creating custom storage
const store = new KVStore(scope, 'app-store', {});

// FileBucket: object storage for binary files (uploads, reports, images).
// Non-versioned here to keep the demo simple; versioning is on by default.
const files = new FileBucket(scope, 'app-files', { versioned: false });

// AppSetting: a single runtime config value (feature flag, threshold, URL).
const featureFlag = new AppSetting<string>(scope, 'feature-flag', { value: 'off' });

// EmailClient: transactional email. The mock captures sent mail (no SES).
const email = new EmailClient(scope, 'mailer', { fromAddress: 'noreply@example.com' });

// AsyncJob: background processing. The handler runs locally (no SQS/Lambda).
// trackStatus lets a caller await completion. This demo handler records that it
// ran by writing a marker into the KVStore, so a caller can confirm the effect.
const greetingJob = new AsyncJob<{ name: string }>(scope, 'greeting-job', {
  trackStatus: true,
  handler: async (payload) => {
    await store.put(`job-ran:${payload.name}`, 'done');
  },
});

// Auth: email + password sign-in (see node_modules/@aws-blocks/bb-auth/README.md).
// Sign-up confirms the email address with a 6-digit code; once the user enters
// it they are signed in automatically. On AWS, Cognito emails the code.
const auth = new Auth(scope, 'auth', {
  // Users sign in with their email, matched ignoring case. Both are fixed when
  // the user pool is created, and this is also the pool shape Amplify's client
  // libraries expect, so a frontend can later sign in with them too.
  users: { signInWith: ['email'], caseSensitive: false },
  // Local dev only: no email is sent, so print the code in the `npm run dev`
  // terminal. Ignored on AWS.
  codeDelivery: async (username, code, purpose) => {
    console.log(`[auth] ${purpose} code for ${username}: ${code}`);
  },
});

// DistributedTable: Use Zod schemas for type-safe tables.
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

  // ── Public — FileBucket upload/download demo ─────────────────────────
  // Return Transferable handles the client middleware hydrates into
  // live `.upload(body)` / `.download()` objects, so the browser transfers
  // bytes directly to/from storage without managing presigned URLs by hand.
  async getUploadSlot(path: string, contentType: string) {
    return files.createUploadHandle(path, { contentType });
  },

  async getFileHandle(path: string) {
    return files.getFileHandle(path);
  },

  // ── Public — AppSetting (runtime config) demo ────────────────────────
  async getFlag() {
    return await featureFlag.get();
  },

  async setFlag(value: string) {
    await featureFlag.put(value);
    return { success: true };
  },

  // ── Public — AsyncJob (background processing) demo ───────────────────
  // Submit a job and wait for it to complete. The handler writes a marker
  // into the store; `jobRan` confirms the effect landed.
  async runGreetingJob(name: string) {
    const { jobId } = await greetingJob.submit({ name });
    const status = await greetingJob.waitUntilComplete(jobId, { timeoutMs: 10000 });
    return { jobId, state: status.state };
  },

  async jobRan(name: string) {
    return (await store.get(`job-ran:${name}`)) === 'done';
  },

  // ── Public — EmailClient (transactional email) demo ──────────────────
  async sendWelcome(to: string) {
    const result = await email.send({
      to,
      subject: 'Welcome',
      body: 'Thanks for trying the demo app.',
    });
    return { messageId: result.messageId };
  },
  
  // ── Public — cookie round-trip demo ──────────────────────────────────
  async setCookie(name: string, value: string) {
    assertNoCrlf(name, 'name');
    assertNoCrlf(value, 'value');
    context.response.headers.set('set-cookie', `${name}=${value}; Max-Age=3600; Secure; SameSite=None; Partitioned`);
    return { success: true };
  },
  
  async getCookie(name: string) {
    const cookies = context.request.headers.get('cookie') || '';
    const match = cookies.split('; ').find(c => c.startsWith(`${name}=`));
    return match ? match.split('=')[1] : null;
  },
  
  async deleteCookie(name: string) {
    assertNoCrlf(name, 'name');
    context.response.headers.set('set-cookie', `${name}=; Max-Age=0; Secure; SameSite=None; Partitioned`);
    return { success: true };
  },

  // DistributedTable example methods
  // ── Protected (requireAuth) — these gate before touching per-user data ─
  async createTodo(title: string, priority: number = 2): Promise<Todo> {
    const user = await auth.requireAuth(context);
    
    // ULID: timestamp-based sortable ID
    const now = Date.now();
    const ulid = now.toString(36) + crypto.randomBytes(8).toString('hex');
    const todo = { userSub: user.userSub, todoId: ulid, title, completed: false, priority, createdAt: now };
    await todos.put(todo);
    return todo;
  },

  async listTodos(sortBy?: 'priority' | 'title' | 'createdAt'): Promise<Todo[]> {
    const user = await auth.requireAuth(context);

    const list = await Array.fromAsync(
      todos.query({ where: { userSub: { equals: user.userSub } } })
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
    
    const existing = await todos.get({ userSub: user.userSub, todoId });
    if (!existing) throw new ApiError('Todo not found', 404, { name: 'TodoNotFoundException' });

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
