import { ApiNamespace, Scope, KVStore, AuthCognito, DistributedTable } from '@aws-blocks/blocks';
import crypto from 'node:crypto';
import { z } from 'zod';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Building Blocks to see docstrings with usage, best practices, and performance characteristics
const scope = new Scope('my-app');

// Building Blocks: Use these instead of creating custom storage
const store = new KVStore(scope, 'app-store', {});

// AuthCognito: passwordless email-OTP demo with groups and custom attributes.
//
// Locally (mock), the OTP issued on sign-up / sign-in / reset is captured
// via the `codeDelivery` hook and also exposed via the `getLastCode` API
// method below so the UI can display it without a real mailbox.
//
// In Sandbox/Production this capture is disabled and `getLastCode` returns
// `null` — enforced by an env gate (the `BLOCKS_STACK_NAME` check below), not
// just convention — and Cognito delivers codes over email/SMS as configured
// on the User Pool.
let lastCode: { username: string; code: string; purpose: string } | null = null;

// `as const` on the options unlocks literal narrowing across the API:
// `requireRole('editors')` rejects `'editor'` (typo) at compile time;
// `updateUserAttribute('custom:department', …)` fails if 'department'
// was never declared. Drop `as const` (or any individual one) to opt
// back into the wide-string backward-compat types.
//
// Passwordless email-OTP: `authFlowType: 'USER_AUTH'` opens Cognito's
// choice-based flow; `preferredChallenge: 'EMAIL_OTP'` skips the picker
// and asks for an email-delivered code on the very first sign-in call.
// `signInWith: 'email'` makes the email address the username so users
// type one identifier on the sign-up + sign-in forms. MFA stays off so
// the user lands on a session in two steps: enter email → enter code.
//
// No explicit `email` userAttribute is needed: Cognito treats the
// username field as a synthetic email when `UsernameAttributes:
// ['email']` is set (which is what `signInWith: 'email'` resolves to),
// and flips `email_verified=true` on `confirmSignUp` so EMAIL_OTP
// first-factor sign-in is available immediately for returning users.
// Verified end-to-end against real Cognito in
// `scenarios.passwordless-demo.sandbox.test.ts`; mocked to match in
// `index.ts#usernameAliasAttr`.
//
// `signUp({ autoSignIn: true })` is the BB's default (toggled at the
// state-machine boundary), so once the sign-up code is confirmed the
// Authenticator drives a "Continue" step that exchanges the bridging
// session for tokens — no second OTP, no separate sign-in.
const auth = new AuthCognito(scope, 'auth', {
  crossDomain: process.env.BLOCKS_SANDBOX === 'true',
  passwordPolicy: { minLength: 8, requireDigits: true },
  signInWith: 'email' as const,
  authFlowType: 'USER_AUTH' as const,
  preferredChallenge: 'EMAIL_OTP' as const,
  userAttributes: [
    { name: 'department', required: false },
  ] as const,
  groups: ['editors', 'readers'] as const,
  mfa: 'off' as const,
  selfSignUp: true,
  codeDelivery: async (username, code, purpose) => {
    // BLOCKS_STACK_NAME is set in every deployed Lambda; unset locally/mock —
    // gate the OTP so it never leaks in prod/sandbox.
    if (!process.env.BLOCKS_STACK_NAME) {
      lastCode = { username, code, purpose };
      console.log(`[auth] ${purpose} code for "${username}": ${code}`);
    }
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
  // These throw 403 when the signed-in user isn't in the named group.
  // Group membership is assigned out-of-band — see the UI hint for the
  // CLI command, or use the AWS Console → Cognito → Users pages.
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
    const indexMap = {
      priority: 'byPriority',
      title: 'byTitle',
      createdAt: 'byCreatedAt',
    } as const;
    const iterator = todos.query({
      index: sortBy ? indexMap[sortBy] : 'byCreatedAt',
      where: { userSub: { equals: user.userSub } },
    });
    const out: Array<z.infer<typeof todoSchema>> = [];
    for await (const t of iterator) out.push(t);
    return out;
  },

  async updateTodo(todoId: string, updates: { completed?: boolean; priority?: number; title?: string }) {
    const user = await auth.requireAuth(context);
    const existing = await todos.get({ userSub: user.userSub, todoId });
    if (!existing) throw new Error('Todo not found');
    await todos.put({ ...existing, ...updates });
    return { success: true };
  },

  async deleteTodo(todoId: string) {
    const user = await auth.requireAuth(context);
    await todos.delete({ userSub: user.userSub, todoId });
    return { success: true };
  },

  // ── Profile ──────────────────────────────────────────────────────────
  // Live-read attributes (auto-refreshes the signed-in user's claims).
  async fetchUserAttributes() {
    return await auth.fetchUserAttributes(context);
  },

  // Update a single custom attribute. Returns a per-attribute outcome —
  // for `email`, the outcome has `nextStep = CONFIRM_ATTRIBUTE_WITH_CODE`
  // and the user must call `confirmAttribute` with the emailed code.
  //
  // `updateUserAttributes` is typed against the literal attribute union
  // derived from the BB's `userAttributes` + `as const`. A plain object
  // shorthand (`{ department }`) infers a widened `string` key, so we
  // spell the key out so the literal survives into the call.
  async updateDepartment(department: string) {
    return await auth.updateUserAttributes(context, { 'department': department });
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
    const out: any[] = [];
    for await (const d of auth.fetchDevices(context)) out.push(d);
    return out;
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
   * Returns the most recently issued verification code (signUp / sign-in / reset).
   * Only available in local/mock dev: the `BLOCKS_STACK_NAME` env gate forces this
   * to `null` in any deployed environment (Sandbox/Production), so a live OTP
   * can never leak through this method — real Cognito delivers codes via
   * email/SMS and the UI should instruct the user to check their mailbox.
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
