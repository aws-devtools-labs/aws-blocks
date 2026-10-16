// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Native-bindings test backend — exercises the blocks that native clients
// (Swift, Kotlin, Dart) consume: auth (three `Auth` instances: email +
// password, a Cognito-style configuration, and OIDC through the local stub
// IdP), realtime, file storage, and key-value.

import {
  ApiNamespace,
  Scope,
  KVStore,
  Realtime,
  RealtimeChannel,
  FileBucket,
  DistributedTable,
} from '@aws-blocks/blocks';
import { Auth, relayOrigin, stubIdp } from '@aws-blocks/bb-auth';
import type { AuthenticatedUser, AuthOptions, CodeDeliveryPurpose, SignInResult } from '@aws-blocks/bb-auth';
export type { RealtimeChannel, DisconnectReason, SubscribeOptions } from '@aws-blocks/blocks';
import crypto from 'node:crypto';
import { z } from 'zod';

const scope = new Scope('native-bindings');

// ============================================================================
// Building Block Instances
// ============================================================================

// --- KVStore -----------------------------------------------------------------
const store = new KVStore(scope, 'store', {});

// --- Verification codes (local dev only) --------------------------------------
// Every self-service sign-up confirms the email address with a code. Locally no
// email is sent: `codeDelivery` (a mock-only hook — the AWS runtime ignores it
// and Cognito emails the code) hands each code to this backend, and the
// `*GetLastCode` methods let the native e2e suites read it back. Against a
// deployed backend they return `null`.
interface DeliveredCode {
  code: string;
  purpose: CodeDeliveryPurpose;
}

function codeInbox() {
  const codes = new Map<string, DeliveredCode>();
  return {
    deliver: async (username: string, code: string, purpose: CodeDeliveryPurpose) => {
      codes.set(username, { code, purpose });
      console.log(`[auth] ${purpose} code for "${username}": ${code}`);
    },
    last: (username: string): DeliveredCode | null => codes.get(username) ?? null,
  };
}

// --- Auth: email + password ----------------------------------------------------
// Block id kept from the `AuthBasic` instance this replaces.
const basicCodes = codeInbox();
const authBasic = new Auth(scope, 'auth-basic', {
  // Disposable test stack: say so explicitly (a real app retains its pool).
  removalPolicy: 'destroy',
  codeDelivery: basicCodes.deliver,
});

// --- Auth: Cognito-style configuration -----------------------------------------
// Block id and options kept from the `AuthCognito` instance this replaces.
// `email` is a built-in standard attribute, so it is not declared under
// `users.attributes` (only custom attributes are).
const cognitoCodes = codeInbox();
const authCognito = new Auth(scope, 'auth-cognito', {
  emailPassword: {
    selfSignUp: true,
    passwordPolicy: { minLength: 8, requireDigits: true },
  },
  users: { groups: ['admins', 'users'] },
  mfa: { mode: 'off', types: ['TOTP'] },
  removalPolicy: 'destroy',
  codeDelivery: cognitoCodes.deliver,
});

// --- Auth: OIDC through the local stub IdP --------------------------------------
// Block id kept from the `AuthOIDC` instance this replaces. No email + password,
// so no Cognito user pool is provisioned for this block.
//
// The stub IdP is local-only by default; this test app opts in with
// `unsafeAllowDeployed: true`, so a deployed backend (a disposable CI stack)
// serves it too and the native OIDC suites can sign in against it — never do
// this in a real app: a deployed stub signs anyone in as its users. To federate
// a real IdP instead, deploy with NATIVE_E2E_OIDC_ISSUER and
// NATIVE_E2E_OIDC_CLIENT_ID (requirements in `.github/workflows/native-sdk-e2e.yml`):
// the provider keyed `google` (the id the suites sign in with) then federates
// that IdP directly, as a public PKCE client. `index.cdk.ts` forwards both
// variables to the deployed handler, so the Lambda builds the same provider
// synth did.
const e2eIdpIssuer = process.env.NATIVE_E2E_OIDC_ISSUER;
const e2eIdpClientId = process.env.NATIVE_E2E_OIDC_CLIENT_ID;

let lastOidcSignIn: { userId: string; email: string | null; provider: string } | null = null;

const oidcAuth = new Auth(scope, 'auth-oidc', {
  emailPassword: false,
  oidcProviders: {
    google:
      e2eIdpIssuer && e2eIdpClientId
        ? { issuer: e2eIdpIssuer, clientId: e2eIdpClientId }
        : stubIdp({ onAuthorize: (req) => req.users[0], unsafeAllowDeployed: true }),
  },
  redirects: {
    allowedRelayOrigins: [relayOrigin('nativebindings://auth'), relayOrigin('com.example.nativebindings://auth')],
  },
  onSignIn: async (user) => {
    lastOidcSignIn = { userId: user.userId, email: user.attributes.email ?? null, provider: user.signInProvider };
  },
});

// --- Realtime ----------------------------------------------------------------
const cursorSchema = z.object({
  userId: z.string(),
  x: z.number(),
  y: z.number(),
  color: z.string(),
});

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

// --- DistributedTable (Todos) ------------------------------------------------
// Per-user todos: the partition key is the owner's `userSub` (stable for the
// user's lifetime), and every todo method reads and writes only the caller's
// partition, so one user can never list, read or change another user's todos.
const todoSchema = z.object({
  userSub: z.string(),
  todoId: z.string(),
  title: z.string(),
  completed: z.boolean(),
  priority: z.number(),
  createdAt: z.number(),
});

export interface Todo {
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
    sortKey: 'todoId',
  },
  indexes: {
    byPriority: {
      partitionKey: 'userSub',
      sortKey: 'priority',
    },
    byCreatedAt: {
      partitionKey: 'userSub',
      sortKey: 'createdAt',
    },
  },
});

// --- FileBucket --------------------------------------------------------------
const bucket = new FileBucket(scope, 'files', { removalPolicy: 'destroy' });

// ============================================================================
// Shapes returned to native clients
// ============================================================================

/** The signed-in user, as the native suites read it. */
export interface NativeUser {
  userId: string;
  username: string;
  userSub: string;
}

/**
 * A flattened sign-in result. `status` is a string discriminator (the native
 * generators need one); `nextStep` names the challenge when sign-in needs
 * another step.
 */
export interface NativeSignInResult {
  status: 'signedIn' | 'continueSignIn';
  user: NativeUser | null;
  nextStep: string | null;
}

/** An OIDC user, as the native suites read it. */
export interface OidcUserInfo {
  userId: string;
  userSub: string;
  email: string | null;
  name: string | null;
  provider: string;
}

function nativeUser(user: AuthenticatedUser): NativeUser {
  return { userId: user.userId, username: user.username, userSub: user.userSub };
}

function nativeSignIn<O extends AuthOptions>(result: SignInResult<O>): NativeSignInResult {
  return result.status === 'signedIn'
    ? { status: 'signedIn', user: nativeUser(result.user), nextStep: null }
    : { status: 'continueSignIn', user: null, nextStep: result.nextStep.name };
}

function oidcUserInfo(user: AuthenticatedUser): OidcUserInfo {
  return {
    userId: user.userId,
    userSub: user.userSub,
    email: user.attributes.email ?? null,
    name: user.attributes.name ?? null,
    provider: user.signInProvider,
  };
}

// ============================================================================
// API
// ============================================================================

export const authBasicApi = authBasic.createApi();
export const authCognitoApi = authCognito.createApi();
export const oidcAuthApi = oidcAuth.createApi();

export const api = new ApiNamespace(scope, 'api', (context) => ({

  // --------------------------------------------------------------------------
  // KVStore
  // --------------------------------------------------------------------------

  async kvGet(key: string) {
    return await store.get(key);
  },

  async kvPut(key: string, value: string) {
    await store.put(key, value);
    return { success: true };
  },

  async kvDelete(key: string) {
    await store.delete(key);
    return { success: true };
  },

  async kvScan() {
    const entries: { key: string; value: string }[] = [];
    for await (const entry of store.scan()) entries.push(entry);
    return entries;
  },

  // --------------------------------------------------------------------------
  // Auth — email + password (`auth-basic`)
  // --------------------------------------------------------------------------

  /** Register a user. The emailed code (`basicGetLastCode` locally) confirms it. */
  async basicSignUp(username: string, password: string, email: string) {
    const r = await authBasic.signUp(username, password, { attributes: { email } }, context);
    return { isSignUpComplete: r.isSignUpComplete, userId: r.userId ?? null };
  },

  /** Confirm the sign-up with the emailed code; signs the user in (auto sign-in). */
  async basicConfirmSignUp(username: string, code: string): Promise<NativeSignInResult> {
    const confirmed = await authBasic.confirmSignUp(username, code, context);
    if (confirmed.nextStep.signUpStep !== 'COMPLETE_AUTO_SIGN_IN') {
      return { status: 'continueSignIn', user: null, nextStep: 'SIGN_IN' };
    }
    return nativeSignIn(await authBasic.autoSignIn(context));
  },

  async basicResendSignUpCode(username: string) {
    await authBasic.resendSignUpCode(username);
    return { success: true };
  },

  async basicSignIn(username: string, password: string): Promise<NativeSignInResult> {
    return nativeSignIn(await authBasic.signIn(username, password, context));
  },

  async basicSignOut() {
    await authBasic.signOut(context);
    return { success: true };
  },

  async basicGetCurrentUser(): Promise<NativeUser | null> {
    const user = await authBasic.getCurrentUser(context);
    return user ? nativeUser(user) : null;
  },

  async basicCheckAuth() {
    return await authBasic.checkAuth(context);
  },

  async basicRequireAuth(): Promise<NativeUser> {
    return nativeUser(await authBasic.requireAuth(context));
  },

  /** The last code sent to `username` (local dev server only; `null` on AWS). */
  async basicGetLastCode(username: string) {
    return basicCodes.last(username);
  },

  // --------------------------------------------------------------------------
  // Auth — Cognito-style configuration (`auth-cognito`)
  // --------------------------------------------------------------------------

  async cognitoSignUp(username: string, password: string, email: string) {
    const r = await authCognito.signUp(username, password, { attributes: { email } }, context);
    return { isSignUpComplete: r.isSignUpComplete, userId: r.userId ?? null, nextStep: r.nextStep ?? null };
  },

  async cognitoConfirmSignUp(username: string, code: string) {
    const r = await authCognito.confirmSignUp(username, code, context);
    return { success: true, signUpStep: r.nextStep.signUpStep };
  },

  async cognitoResendSignUpCode(username: string) {
    await authCognito.resendSignUpCode(username);
    return { success: true };
  },

  async cognitoSignIn(username: string, password: string) {
    return await authCognito.signIn(username, password, context);
  },

  async cognitoConfirmSignIn(session: string, challengeResponse: string) {
    return await authCognito.confirmSignIn(session, challengeResponse, context);
  },

  async cognitoSignOut(options?: { global?: boolean }) {
    await authCognito.signOut(context, options);
    return { success: true };
  },

  async cognitoGetCurrentUser() {
    return await authCognito.getCurrentUser(context);
  },

  async cognitoCheckAuth() {
    return await authCognito.checkAuth(context);
  },

  async cognitoRequireAuth() {
    return await authCognito.requireAuth(context);
  },

  async cognitoRequireRole(role: 'admins' | 'users') {
    return await authCognito.requireRole(context, role);
  },

  async cognitoGetUserAttributes() {
    return await authCognito.getUserAttributes(context);
  },

  async cognitoUpdatePassword(oldPassword: string, newPassword: string) {
    await authCognito.updatePassword(context, oldPassword, newPassword);
    return { success: true };
  },

  async cognitoUpdateUserAttributes(attributes: Record<string, string>) {
    return await authCognito.updateUserAttributes(context, attributes);
  },

  async cognitoDeleteUser() {
    await authCognito.deleteUser(context);
    return { success: true };
  },

  async cognitoResetPassword(username: string) {
    return await authCognito.resetPassword(username);
  },

  async cognitoConfirmResetPassword(username: string, code: string, newPassword: string) {
    await authCognito.confirmResetPassword(username, code, newPassword);
    return { success: true };
  },

  // The `status` string field is the discriminator native clients (Swift /
  // Kotlin / Dart) key off when generating the result union. The generators
  // detect a discriminated union only from a single-value *string* const/enum
  // per arm; without it they emit numeric `Result_Variant0/1` structs and
  // try-each-variant decoding that fails to compile. The explicit return type
  // also keeps the signed-out arm minimal — no phantom `null`-typed token
  // fields (which became invalid `Void?` in Swift).
  async cognitoGetAuthSession(): Promise<
    | { status: 'signedOut' }
    | {
        status: 'signedIn';
        userSub: string | null;
        idToken: string;
        accessToken: string;
      }
  > {
    const session = await authCognito.getAuthSession(context);
    if (!session.tokens) return { status: 'signedOut' };
    return {
      status: 'signedIn',
      userSub: session.userSub ?? null,
      idToken: session.tokens.idToken.toString(),
      accessToken: session.tokens.accessToken.toString(),
    };
  },

  /** The last code sent to `username` (local dev server only; `null` on AWS). */
  async cognitoGetLastCode(username: string) {
    return cognitoCodes.last(username);
  },

  // --------------------------------------------------------------------------
  // Auth — OIDC through the stub IdP (`auth-oidc`)
  // --------------------------------------------------------------------------

  async oidcGetSignInUrl(provider: 'google') {
    const url = await oidcAuth.getSignInUrl(context, provider);
    return { url };
  },

  async oidcRequireAuth(): Promise<OidcUserInfo> {
    return oidcUserInfo(await oidcAuth.requireAuth(context));
  },

  async oidcCheckAuth() {
    return await oidcAuth.checkAuth(context);
  },

  async oidcGetCurrentUser(): Promise<OidcUserInfo | null> {
    const user = await oidcAuth.getCurrentUser(context);
    return user ? oidcUserInfo(user) : null;
  },

  async oidcSignOut() {
    await oidcAuth.signOut(context);
    return { success: true };
  },

  async oidcGetLastSignIn() {
    return lastOidcSignIn;
  },

  // --------------------------------------------------------------------------
  // Realtime
  // --------------------------------------------------------------------------

  async realtimeGetChannel(channel?: string): Promise<RealtimeChannel<Cursor>> {
    return realtime.getChannel('cursors', channel ?? 'default');
  },

  async realtimePublish(cursor: Cursor, channel?: string) {
    await realtime.publish('cursors', channel ?? 'default', cursor);
    return { success: true };
  },

  // --------------------------------------------------------------------------
  // Todos (DistributedTable) — gated on the email + password block
  // --------------------------------------------------------------------------

  async createTodo(title: string, priority: number = 2): Promise<Todo> {
    const user = await authBasic.requireAuth(context);
    const ulid = Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
    const todo: Todo = {
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

  async listTodos(sortBy?: 'priority' | 'createdAt'): Promise<Todo[]> {
    const user = await authBasic.requireAuth(context);
    const where = { userSub: { equals: user.userSub } } as const;
    let iterator;
    if (sortBy === 'priority') {
      iterator = todos.query({ index: 'byPriority', where });
    } else if (sortBy === 'createdAt') {
      iterator = todos.query({ index: 'byCreatedAt', where });
    } else {
      iterator = todos.query({ where });
    }
    return await Array.fromAsync(iterator);
  },

  async getTodo(todoId: string): Promise<Todo | null> {
    const user = await authBasic.requireAuth(context);
    return await todos.get({ userSub: user.userSub, todoId }) ?? null;
  },

  async updateTodo(todoId: string, updates: { completed?: boolean; priority?: number; title?: string }) {
    const user = await authBasic.requireAuth(context);
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
    const user = await authBasic.requireAuth(context);
    await todos.delete({ userSub: user.userSub, todoId });
    return { success: true };
  },

  // --------------------------------------------------------------------------
  // FileBucket
  // --------------------------------------------------------------------------

  async fileCreateUploadHandle(path: string, contentType?: string) {
    return await bucket.createUploadHandle(path, contentType ? { contentType } : undefined);
  },

  async fileGetHandle(path: string) {
    return await bucket.getFileHandle(path);
  },

  async fileGetUrl(path: string) {
    return await bucket.getUrl(path);
  },

  async filePutUrl(path: string) {
    return await bucket.putUrl(path);
  },

  async filePut(path: string, content: string, contentType?: string) {
    await bucket.put(path, content, contentType ? { contentType } : undefined);
    return { success: true };
  },

  async fileGet(path: string) {
    const file = await bucket.get(path);
    if (!file) return null;
    return { body: file.body.toString(), contentType: file.contentType, size: file.size };
  },

  async fileDelete(path: string) {
    await bucket.delete(path);
    return { success: true };
  },

  async fileScan(prefix?: string) {
    const files: { path: string; size: number }[] = [];
    for await (const file of bucket.scan(prefix ? { prefix } : undefined)) {
      files.push({ path: file.path, size: file.size });
    }
    return files;
  },

  // --------------------------------------------------------------------------
  // Wire contract
  // --------------------------------------------------------------------------

  /**
   * Echoes its arguments as the server received them; one left out is `null`. JSON-RPC params
   * are positional here, so a native client that leaves out `middle` but sets `last` must send
   * `last` in the third slot (native e2e: Kotlin `RpcWireE2ETest`, Dart `rpc_wire_test.dart`).
   */
  async echoArgs(first: string, middle?: string, last?: string) {
    return { first, middle: middle ?? null, last: last ?? null };
  },
}));
