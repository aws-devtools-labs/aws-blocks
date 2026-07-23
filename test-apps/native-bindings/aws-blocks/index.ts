// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Native-bindings test backend — exercises the blocks that native clients
// (Swift, Kotlin, Dart) consume: auth (basic, cognito, OIDC), realtime,
// file storage, and key-value.

import {
  ApiNamespace,
  Scope,
  KVStore,
  AuthBasic,
  AuthCognito,
  AuthOIDC,
  stubIdp,
  relayOrigin,
  Realtime,
  RealtimeChannel,
  FileBucket,
  DistributedTable,
} from '@aws-blocks/blocks';
export type { RealtimeChannel, DisconnectReason, SubscribeOptions } from '@aws-blocks/blocks';
import crypto from 'node:crypto';
import { z } from 'zod';

const scope = new Scope('native-bindings');

// ============================================================================
// Building Block Instances
// ============================================================================

// --- KVStore -----------------------------------------------------------------
const store = new KVStore(scope, 'store', {});

// --- AuthBasic ---------------------------------------------------------------
const authBasic = new AuthBasic(scope, 'auth-basic', {});

// --- AuthCognito -------------------------------------------------------------
let lastCognitoCode: { username: string; code: string; purpose: string } | null = null;
const authCognito = new AuthCognito(scope, 'auth-cognito', {
  passwordPolicy: { minLength: 8, requireDigits: true },
  userAttributes: [{ name: 'email' }],
  groups: ['admins', 'users'],
  mfa: 'off',
  mfaTypes: ['TOTP'],
  selfSignUp: true,
  codeDelivery: async (username, code, purpose) => {
    lastCognitoCode = { username, code, purpose };
    console.log(`[AuthCognito] ${purpose} code for "${username}": ${code}`);
  },
});

// --- AuthOIDC ----------------------------------------------------------------
let lastOidcSignIn: { userId: string; email: string | null; provider: string } | null = null;

const oidcAuth = new AuthOIDC(scope, 'auth-oidc', {
  providers: [
    stubIdp({ name: 'google', onAuthorize: (req) => req.users[0] }),
  ],
  allowedRelayOrigins: [
    relayOrigin('nativebindings://auth'),
    relayOrigin('com.example.nativebindings://auth'),
  ],
  onSignIn: async (user) => {
    lastOidcSignIn = { userId: user.userId, email: user.email, provider: user.provider };
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
const todoSchema = z.object({
  userId: z.string(),
  todoId: z.string(),
  title: z.string(),
  completed: z.boolean(),
  priority: z.number(),
  createdAt: z.number(),
});

export interface Todo {
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
    sortKey: 'todoId',
  },
  indexes: {
    byPriority: {
      partitionKey: 'userId',
      sortKey: 'priority',
    },
    byCreatedAt: {
      partitionKey: 'userId',
      sortKey: 'createdAt',
    },
  },
});

// --- FileBucket --------------------------------------------------------------
const bucket = new FileBucket(scope, 'files', { removalPolicy: 'destroy' });

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
  // AuthBasic
  // --------------------------------------------------------------------------

  async basicSignUp(username: string, password: string) {
    await authBasic.signUp(username, password);
    return { success: true };
  },

  async basicSignIn(username: string, password: string) {
    const user = await authBasic.signIn(username, password, context);
    return { userId: user.userId, username: user.username };
  },

  async basicSignOut() {
    await authBasic.signOut(context);
    return { success: true };
  },

  async basicGetCurrentUser() {
    return await authBasic.getCurrentUser(context);
  },

  async basicCheckAuth() {
    return await authBasic.checkAuth(context);
  },

  async basicRequireAuth() {
    const user = await authBasic.requireAuth(context);
    return { userId: user.userId, username: user.username };
  },


  // --------------------------------------------------------------------------
  // AuthCognito
  // --------------------------------------------------------------------------

  async cognitoSignUp(username: string, password: string, email: string) {
    const r = await authCognito.signUp(username, password, { attributes: { email } });
    return { isSignUpComplete: r.isSignUpComplete, userId: r.userId, nextStep: r.nextStep };
  },

  async cognitoConfirmSignUp(username: string, code: string) {
    await authCognito.confirmSignUp(username, code);
    return { success: true };
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

  async cognitoRequireRole(role: string) {
    return await authCognito.requireRole(context, role);
  },

  async cognitoFetchUserAttributes() {
    return await authCognito.fetchUserAttributes(context);
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
  async cognitoFetchAuthSession(): Promise<
    | { status: 'signedOut' }
    | {
        status: 'signedIn';
        userSub: string | null;
        idToken: string;
        accessToken: string;
      }
  > {
    const session = await authCognito.fetchAuthSession(context);
    if (!session.tokens) return { status: 'signedOut' };
    return {
      status: 'signedIn',
      userSub: session.userSub ?? null,
      idToken: session.tokens.idToken.toString(),
      accessToken: session.tokens.accessToken.toString(),
    };
  },

  async cognitoGetLastCode() {
    return lastCognitoCode;
  },

  // --------------------------------------------------------------------------
  // AuthOIDC
  // --------------------------------------------------------------------------

  async oidcGetSignInUrl(provider: string) {
    const url = await oidcAuth.getSignInUrl(context, provider);
    return { url };
  },

  async oidcRequireAuth() {
    const user = await oidcAuth.requireAuth(context);
    return { userId: user.userId, email: user.email, name: user.name, provider: user.provider, sub: user.sub };
  },

  async oidcCheckAuth() {
    return await oidcAuth.checkAuth(context);
  },

  async oidcGetCurrentUser() {
    const user = await oidcAuth.getCurrentUser(context);
    if (!user) return null;
    return { userId: user.userId, email: user.email, name: user.name, provider: user.provider, sub: user.sub };
  },

  async oidcSignOut() {
    await oidcAuth.signOut(context);
    return { success: true };
  },

  async oidcGetLastSignIn() {
    return lastOidcSignIn;
  },

  async oidcGetProviders() {
    return [...oidcAuth.providers];
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
  // Todos (DistributedTable)
  // --------------------------------------------------------------------------

  async createTodo(title: string, priority: number = 2): Promise<Todo> {
    const user = await authBasic.requireAuth(context);
    const ulid = Date.now().toString(36) + crypto.randomBytes(8).toString('hex');
    const todo: Todo = {
      userId: user.username,
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
    const where = { userId: { equals: user.username } } as const;
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
    return await todos.get({ userId: user.username, todoId }) ?? null;
  },

  async updateTodo(todoId: string, updates: { completed?: boolean; priority?: number; title?: string }) {
    const user = await authBasic.requireAuth(context);
    const existing = await todos.get({ userId: user.username, todoId });
    if (!existing) throw new Error('Todo not found');
    await todos.put({ ...existing, ...updates });
    return { success: true };
  },

  async deleteTodo(todoId: string) {
    const user = await authBasic.requireAuth(context);
    await todos.delete({ userId: user.username, todoId });
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
}));
