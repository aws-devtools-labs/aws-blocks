import { ApiNamespace, ApiError, Scope, KVStore, Auth, DistributedTable, FileBucket, AppSetting, AsyncJob, EmailClient, Secret, KnowledgeBase, DistributedDatabase, sql } from '@aws-blocks/blocks';
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
const DEMO_COOKIE_ATTRS = 'HttpOnly; SameSite=Lax';

/**
 * Cookie attributes for a request. Follows the same rule as the auth cookie
 * (`@aws-blocks/auth-common`): `Secure` everywhere except plain-HTTP localhost,
 * where the dev server can't serve HTTPS and some browsers drop `Secure` cookies.
 */
function demoCookieAttrs(headers: Headers): string {
  const origin = headers.get('origin') ?? headers.get('host') ?? '';
  const isLoopback = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/.test(origin);
  return isLoopback ? DEMO_COOKIE_ATTRS : `${DEMO_COOKIE_ATTRS}; Secure`;
}

/**
 * Store key for a user's KV entry. The `user:` prefix keeps user keys apart
 * from app-level keys (e.g. `job-ran:` below), and encoding the username stops
 * a `:` in it from shifting the user/key boundary (`alice:notes` + `secret`
 * must not reach `alice` + `notes:secret`).
 */
const userKey = (username: string, key: string) => `user:${encodeURIComponent(username)}:${key}`;

/** FileBucket path under the signed-in user's own prefix (`/` in a username is encoded). */
const userPath = (username: string, path: string) => `users/${encodeURIComponent(username)}/${path}`;

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

// Secret: a single credential (API key, token). Like AppSetting but with
// version history for rotation. The mock stores it in .bb-data (no AWS).
// `allowRuntimeWrite: true` because this app rotates the value at runtime via
// rotateApiKey() → put(); without it a Secret is read-only (no put()).
const apiKey = new Secret<string>(scope, 'api-key', { allowRuntimeWrite: true });

// KnowledgeBase: semantic search over a folder of docs. Backed by Bedrock
// Knowledge Bases on deploy; locally the mock indexes ./knowledge in-process
// (no AWS). The `knowledge/` folder ships with the template.
const docs = new KnowledgeBase(scope, 'docs', { source: './knowledge' });

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

// DistributedDatabase: a relational, strongly-consistent SQL database (Aurora
// DSQL on deploy; PGlite locally via the mock, no AWS). Unlike DistributedTable
// (key-value), it runs multi-row SQL transactions atomically — used here for a
// money transfer between accounts that must move both balances or neither.
// Schema lives in aws-blocks/dsql-migrations/*.sql, applied automatically.
const ledger = new DistributedDatabase(scope, 'ledger', {
  migrationsPath: './aws-blocks/dsql-migrations',
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
    return await store.get(userKey(user.username, key));
  },
  
  async setValue(key: string, value: string) {
    const user = await auth.requireAuth(context);
    await store.put(userKey(user.username, key), value);
    return { success: true };
  },

  // ── Protected (requireAuth) — FileBucket upload/download demo ────────
  // Return Transferable handles the client middleware hydrates into
  // live `.upload(body)` / `.download()` objects, so the browser transfers
  // bytes directly to/from storage without managing presigned URLs by hand.
  // Paths are scoped to the signed-in user, so one user can't read or
  // overwrite another user's files.
  async getUploadSlot(path: string, contentType: string) {
    const user = await auth.requireAuth(context);
    return files.createUploadHandle(userPath(user.username, path), { contentType });
  },

  async getFileHandle(path: string) {
    const user = await auth.requireAuth(context);
    return files.getFileHandle(userPath(user.username, path));
  },

  // ── Public read / protected write — AppSetting (runtime config) demo ──
  // The flag is app-wide: anyone may read it, only a signed-in user may change it.
  // In a real app, restrict setFlag further (an admin role) or set it out-of-band.
  async getFlag() {
    return await featureFlag.get();
  },

  async setFlag(value: string) {
    await auth.requireAuth(context);
    await featureFlag.put(value);
    return { success: true };
  },

  // ── Protected (requireAuth) — Secret (credential with rotation history) demo ─
  // In a real app a secret is set out-of-band (console/CLI), never returned to
  // the browser. This demo exposes it only to show rotation history: after
  // rotating, the previous value stays readable until the next rotation.
  async rotateApiKey(value: string) {
    await auth.requireAuth(context);
    await apiKey.put(value);
    return { success: true };
  },

  async getApiKey() {
    await auth.requireAuth(context);
    return await apiKey.get();
  },

  async getPreviousApiKey() {
    await auth.requireAuth(context);
    return await apiKey.get({ version: 'previous' });
  },

  async apiKeyVersionCount() {
    await auth.requireAuth(context);
    return (await apiKey.listVersions()).length;
  },

  // ── Public — KnowledgeBase (semantic doc search) demo ────────────────
  // Retrieve the most relevant chunks for a query from the ./knowledge corpus.
  // Returns text + relevance score + source path for each hit.
  async searchDocs(query: string, maxResults: number = 3) {
    const results = await docs.retrieve(query, { maxResults });
    return results.map((r) => ({ text: r.text, score: r.score, source: r.source }));
  },

  // ── Protected submit / public read — AsyncJob (background processing) demo ─
  // Submit a job and wait for it to complete. The handler writes a marker
  // into the store; `jobRan` confirms the effect landed. Submitting is gated
  // because each call queues work and writes a store item.
  async runGreetingJob(name: string) {
    await auth.requireAuth(context);
    const { jobId } = await greetingJob.submit({ name });
    const status = await greetingJob.waitUntilComplete(jobId, { timeoutMs: 10000 });
    return { jobId, state: status.state };
  },

  async jobRan(name: string) {
    return (await store.get(`job-ran:${name}`)) === 'done';
  },

  // ── Protected (requireAuth) — EmailClient (transactional email) demo ─
  async sendWelcome(to: string) {
    await auth.requireAuth(context);
    const result = await email.send({
      to,
      subject: 'Welcome',
      body: 'Thanks for trying the demo app.',
    });
    return { messageId: result.messageId };
  },
  
  // ── Public — cookie round-trip demo (fixed cookie name) ──────────────
  async setCookie(value: string) {
    context.response.headers.set(
      'set-cookie',
      `${DEMO_COOKIE}=${encodeURIComponent(value)}; Max-Age=3600; ${demoCookieAttrs(context.request.headers)}`,
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
    context.response.headers.set('set-cookie', `${DEMO_COOKIE}=; Max-Age=0; ${demoCookieAttrs(context.request.headers)}`);
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
  },

  // ── DistributedDatabase (SQL) demo — atomic money transfer ───────────
  // Create an account with a starting balance.
  async openAccount(name: string, balance: number) {
    await ledger.execute(
      sql`INSERT INTO accounts (name, balance) VALUES (${name}, ${balance})
          ON CONFLICT (name) DO UPDATE SET balance = ${balance}`,
    );
    return { name, balance };
  },

  // Read one account's balance.
  async balanceOf(name: string) {
    const row = await ledger.queryOne<{ balance: number }>(
      sql`SELECT balance FROM accounts WHERE name = ${name}`,
    );
    return { name, balance: row ? Number(row.balance) : null };
  },

  // Move `amount` from one account to another inside a single transaction:
  // both updates commit together or neither does. This is the capability
  // DistributedTable cannot express — a multi-row atomic write. The debit is
  // guarded by `balance >= amount` so a missing sender or insufficient funds
  // matches zero rows; throwing an ApiError then aborts the transaction and the
  // credit is rolled back too, making the atomic-abort path observable. ApiError
  // (not a plain Error) is wire-safe, so the 'TransferDeclined' name and message
  // reach the client instead of being scrubbed to a generic 500.
  async transfer(from: string, to: string, amount: number) {
    await ledger.transaction(async (tx) => {
      const { rowCount: debited } = await tx.execute(
        sql`UPDATE accounts SET balance = balance - ${amount} WHERE name = ${from} AND balance >= ${amount}`,
      );
      if (debited === 0) {
        throw new ApiError(`transfer declined: '${from}' is missing or has less than ${amount}`, 400, {
          name: 'TransferDeclined',
        });
      }
      const { rowCount: credited } = await tx.execute(
        sql`UPDATE accounts SET balance = balance + ${amount} WHERE name = ${to}`,
      );
      if (credited === 0) {
        throw new ApiError(`transfer declined: recipient '${to}' does not exist`, 400, {
          name: 'TransferDeclined',
        });
      }
    });
    return { success: true };
  }
}));
