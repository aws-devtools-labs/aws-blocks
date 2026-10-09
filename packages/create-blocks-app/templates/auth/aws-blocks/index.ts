import { ApiNamespace, ApiError, Scope, KVStore, Auth, DistributedTable } from '@aws-blocks/blocks';
import crypto from 'node:crypto';
import { z } from 'zod';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Building Blocks to see docstrings with usage, best practices, and performance characteristics
const scope = new Scope('my-app');

// Building Blocks: Use these instead of creating custom storage
const store = new KVStore(scope, 'app-store', {});

// Auth: email + password sign-in with groups and a custom attribute.
// Full API: node_modules/@aws-blocks/bb-auth/README.md
//
// `users.signInWith: ['email']` makes the email address the sign-in name, so
// users type one identifier on the sign-up and sign-in forms. Sign-up confirms
// that address with a 6-digit code; once the user enters it, the
// <Authenticator> signs them in (no second password entry).
//
// ⚠️ `users.signInWith`, required attributes and existing custom attributes
// can't change once the user pool is deployed — decide them before your first
// `npm run sandbox` / `npm run deploy`.
//
// Inline options are captured literally, so the API narrows to them:
// `requireRole(context, 'editor')` (typo) is a compile error, and so is
// `updateUserAttributes(context, { team: … })`, because only `department` is
// declared. No `as const` needed.
//
// Locally (`npm run dev`) no email is sent. The `codeDelivery` hook receives
// every code (sign-up, password reset, attribute verification); this app logs
// it and serves it to the UI through the local-only `getLastCode` method below.
// On AWS, Cognito emails the codes and the hook never runs, so `getLastCode`
// returns `null` there.
let lastCode: { username: string; code: string; purpose: string } | null = null;

const auth = new Auth(scope, 'auth', {
  session: { crossDomain: process.env.BLOCKS_SANDBOX === 'true' },
  users: {
    signInWith: ['email'],
    groups: ['editors', 'readers'],
    attributes: [{ name: 'department' }],
  },
  codeDelivery: async (username, code, purpose) => {
    lastCode = { username, code, purpose };
    console.log(`[auth] ${purpose} code for ${username}: ${code}`);
  },
});

// DistributedTable: per-user todos, keyed by userSub (stable even if the
// user changes their display name / username).
const todoSchema = z.object({
  userSub: z.string(),
  todoId: z.string(),
  title: z.string(),
  completed: z.boolean(),
  priority: z.number(), // 1=high, 2=medium, 3=low
  createdAt: z.number()
});

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

// State machine driving the <Authenticator> UI component
export const authApi = auth.createApi();

export const api = new ApiNamespace(scope, 'api', (context) => ({
  // ── Public ────────────────────────────────────────────────────────────
  async ping() {
    return { message: 'pong', timestamp: Date.now() };
  },

  // ── Protected (requireAuth) ──────────────────────────────────────────
  async whoAmI() {
    const user = await auth.requireAuth(context);
    return {
      username: user.username,
      userSub: user.userSub,
      groups: user.groups,
      attributes: user.attributes,
    };
  },

  // ── Role-gated (requireRole) ─────────────────────────────────────────
  // These throw 403 `NotAuthorizedException` when the signed-in user isn't in
  // the named group. `requireRole` reads the user's current membership, so a
  // group change applies on their next request. Membership is assigned
  // out-of-band — see the UI hint for the CLI command, or use the AWS Console →
  // Cognito → Users pages (or the opt-in `auth.admin` surface, `admin: {}`).
  async editorsOnly() {
    const user = await auth.requireRole(context, 'editors');
    return { message: `Welcome, editor ${user.username}` };
  },

  async readersOnly() {
    const user = await auth.requireRole(context, 'readers');
    return { message: `Hello reader ${user.username}` };
  },

  // ── Todos (per-user DistributedTable) ────────────────────────────────
  async createTodo(title: string, priority: number = 2) {
    const user = await auth.requireAuth(context);
    const ulid = Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
    const todo = {
      userSub: user.userSub,
      todoId: ulid,
      title,
      completed: false,
      priority,
      createdAt: Date.now(),
    };
    await todos.put(todo);
    return todo;
  },

  async listTodos(sortBy?: 'priority' | 'title' | 'createdAt') {
    const user = await auth.requireAuth(context);
    const list = await Array.fromAsync(
      todos.query({ where: { userSub: { equals: user.userSub } } })
    );
    // Sort in the API (not via a secondary index) — a per-user todo list is
    // small, so an in-memory sort is simpler and avoids provisioning GSIs.
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

  // ── Profile ──────────────────────────────────────────────────────────
  // Live-read attributes from the user pool (custom ones read back as
  // `custom:<name>`).
  async getUserAttributes() {
    return await auth.getUserAttributes(context);
  },

  // Update a custom attribute. Returns a per-attribute outcome — for `email`,
  // the outcome has `nextStep = CONFIRM_ATTRIBUTE_WITH_CODE` and the user must
  // call `confirmAttribute` with the emailed code.
  //
  // `updateUserAttributes` only accepts the attributes declared in
  // `users.attributes` (plus the standard ones).
  async updateDepartment(department: string) {
    return await auth.updateUserAttributes(context, { department });
  },

  async updateEmail(newEmail: string) {
    return await auth.updateUserAttributes(context, { email: newEmail });
  },

  // Attribute names are narrowed at the BB boundary, so we only accept the
  // ones this pool actually exposes. The UI never calls these with other
  // names — the type narrows both sides of the wire.
  async confirmAttribute(name: 'email' | 'department', code: string) {
    await auth.confirmUserAttribute(context, name, code);
    return { success: true };
  },

  async sendAttributeVerificationCode(name: 'email' | 'department') {
    await auth.sendUserAttributeVerificationCode(context, name);
    return { success: true };
  },

  async changePassword(oldPassword: string, newPassword: string) {
    await auth.updatePassword(context, oldPassword, newPassword);
    return { success: true };
  },

  // ── Devices ──────────────────────────────────────────────────────────
  async listDevices() {
    return await Array.fromAsync(auth.scanDevices(context));
  },

  // `forgetDevice` requires an explicit device key (the BB doesn't track
  // "current device" on the server side — the caller identifies which
  // device from `listDevices()`). When the demo passes no key we're a
  // no-op on an empty slot, matching the button label's "forget current"
  // ergonomics without the BB having to guess.
  async forgetCurrentDevice(deviceKey: string = '') {
    await auth.forgetDevice(context, deviceKey);
    return { success: true };
  },

  // ── Sign-out modes ───────────────────────────────────────────────────
  // `signOutEverywhere` calls Cognito's GlobalSignOut, which invalidates
  // the refresh token at the pool — all sessions minted from this account
  // become unable to refresh on their next attempt.
  async signOutEverywhere() {
    await auth.signOut(context, { global: true });
    return { success: true };
  },

  // ── KV demo (not auth-gated for brevity) ─────────────────────────────
  async getValue(key: string) {
    return await store.get(key);
  },

  async setValue(key: string, value: string) {
    await store.put(key, value);
    return { success: true };
  },

  // ── Mock-only helper ─────────────────────────────────────────────────
  /**
   * Returns the most recently issued verification code (sign-up / reset /
   * attribute verification). Only available in local dev: on AWS the
   * `codeDelivery` hook never runs, and the `BLOCKS_STACK_NAME` env gate (set in
   * every deployed Lambda) forces `null` as well, so a live code can never leak
   * through this method — Cognito emails codes and the UI should instruct the
   * user to check their mailbox.
   *
   * The `@blocksSkipCodegen` JSDoc tag tells the OpenRPC spec emitter to drop
   * this method, so Swift / Kotlin / other native code generators never see
   * it. The TypeScript client (Proxy-based) still resolves the call at
   * runtime, which is exactly what the local browser demo wants.
   *
   * @blocksSkipCodegen
   */
  async getLastCode() {
    // BLOCKS_STACK_NAME is set in every deployed Lambda; unset locally/mock —
    // gate the OTP so it never leaks in prod/sandbox.
    return !process.env.BLOCKS_STACK_NAME ? lastCode : null;
  },
}));
