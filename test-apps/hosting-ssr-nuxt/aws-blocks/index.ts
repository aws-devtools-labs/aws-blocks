// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiNamespace, AppSetting, Scope, KVStore, ApiError } from '@aws-blocks/blocks';
import { Auth } from '@aws-blocks/bb-auth';

const scope = new Scope('hosting-ssr-test');

// ── Sandbox e2e test support ────────────────────────────────────────────────
//
// The sandbox e2e (`npm run test:sandbox`) deploys this app with
// `BLOCKS_TEST_ENV=sandbox`. Only then does the app get the `testSupport`
// namespace at the bottom of this file, the secret that guards it, and the
// `auth.admin` grant it uses. `index.cdk.ts` forwards the flag to the deployed
// handler so the Lambda builds the same namespace that synth saw. A normal
// build, `npm run dev` or deploy has none of it.
const sandboxE2e = process.env.BLOCKS_TEST_ENV === 'sandbox';
const isDeployedLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

const posts = new KVStore(scope, 'posts', {});

// Delivered sign-up codes are persisted in the posts store keyed by username
// (a distinct key prefix keeps them out of the posts keyspace), with a short
// TTL so a stale code stops being returned. See the comprehensive test-app for
// the full rationale (per-user keying, expiry).
const codeKey = (username: string) => `__last-code:${username}`;

// A stored record that somehow fails to parse is treated as absent (the poller
// then times out on its own message) rather than throwing a SyntaxError out of
// the API method. Mirrors parseStoredRecord in the comprehensive test-app.
function parseStoredRecord<T>(key: string, raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(`[test-app] ignoring unparseable record at "${key}" (${raw.length} bytes) — treating it as absent`);
    return null;
  }
}

// Every sign-up confirms the email address with an emailed code. Locally the
// code is handed to the mock-only `codeDelivery` hook, and the e2e tests read
// it via `authGetLastCode(username)` below — not from logs. On AWS, Cognito
// emails the code and the hook never runs, so the sandbox e2e provisions its
// user with `testSupport.provisionUser` instead.
const auth = new Auth(scope, 'auth', {
  emailPassword: {
    passwordPolicy: {
      minLength: 6,
      requireUppercase: false,
      requireLowercase: false,
      requireDigits: false,
      requireSymbols: false,
    },
  },
  // Users sign in with their email address.
  users: { signInWith: ['email'] },
  session: { ttlSeconds: 86400 },
  // `testSupport.provisionUser` needs the user-lifecycle grant. Outside the
  // sandbox e2e build the list is empty, so no Admin* IAM action is granted.
  admin: { actions: sandboxE2e ? ['lifecycle'] : [] },
  codeDelivery: async (username, code, purpose) => {
    if (purpose === 'signUp') {
      await posts.put(codeKey(username), JSON.stringify({ username, code }), { ttlSeconds: 3600 });
    }
    console.log(`[Auth] ${purpose} code for "${username}": ${code}`);
  },
});

/** What the app shows for a user, and the key it stores their data under. */
function profileOf(user: { userId: string; userSub: string; username: string; attributes: { email?: string } }) {
  return { userId: user.userId, key: user.userSub, name: user.attributes.email ?? user.username };
}

const postIndex = new KVStore(scope, 'post-index', {});
const userPosts = new KVStore(scope, 'user-posts', {});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async listPosts() {
    const indexRaw = await postIndex.get('all');
    const ids: string[] = indexRaw ? JSON.parse(indexRaw) : [];
    const result = [];
    for (const id of ids) {
      const raw = await posts.get(id);
      if (raw) result.push(JSON.parse(raw));
    }
    return result.reverse();
  },

  async getPost(id: string) {
    const raw = await posts.get(id);
    return raw ? JSON.parse(raw) : null;
  },

  async authSignUp(username: string, password: string) {
    await auth.signUp(username, password);
    return { success: true };
  },

  async authConfirmSignUp(username: string, code: string) {
    await auth.confirmSignUp(username, code);
    return { success: true };
  },

  async authSignIn(username: string, password: string) {
    const result = await auth.signIn(username, password, context);
    if (result.status !== 'signedIn') {
      throw new ApiError(`Sign-in needs another step: ${result.nextStep.name}`, 400);
    }
    return { userId: result.user.userId, username: profileOf(result.user).name };
  },

  async authSignOut() {
    await auth.signOut(context);
    return { success: true };
  },

  async authCheckAuth() {
    return await auth.checkAuth(context);
  },

  /**
   * Local test shortcut: the last sign-up code the mock delivered to `username`,
   * so the UI can pre-fill it. Always `null` once deployed — Cognito emails the
   * code itself and the mock-only hook never runs there.
   */
  async authGetLastCode(username: string) {
    if (isDeployedLambda) return null;
    return parseStoredRecord<{ username: string; code: string }>(codeKey(username), await posts.get(codeKey(username)));
  },

  async getProfile() {
    const user = profileOf(await auth.requireAuth(context));
    const myPostsRaw = await userPosts.get(`user:${user.key}`);
    const myPostIds: string[] = myPostsRaw ? JSON.parse(myPostsRaw) : [];
    return { username: user.name, userId: user.userId, postCount: myPostIds.length };
  },

  async createPost(title: string, body: string) {
    const user = profileOf(await auth.requireAuth(context));
    const id = `post-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const post = { id, title, body, author: user.name, authorKey: user.key, createdAt: new Date().toISOString() };
    await posts.put(id, JSON.stringify(post));

    const indexRaw = await postIndex.get('all');
    const ids: string[] = indexRaw ? JSON.parse(indexRaw) : [];
    ids.push(id);
    await postIndex.put('all', JSON.stringify(ids));

    const myPostsRaw = await userPosts.get(`user:${user.key}`);
    const myPostIds: string[] = myPostsRaw ? JSON.parse(myPostsRaw) : [];
    myPostIds.push(id);
    await userPosts.put(`user:${user.key}`, JSON.stringify(myPostIds));

    return post;
  },

  async listMyPosts() {
    const user = profileOf(await auth.requireAuth(context));
    const myPostsRaw = await userPosts.get(`user:${user.key}`);
    const myPostIds: string[] = myPostsRaw ? JSON.parse(myPostsRaw) : [];
    const result = [];
    for (const id of myPostIds) {
      const raw = await posts.get(id);
      if (raw) result.push(JSON.parse(raw));
    }
    return result.reverse();
  },

  async deletePost(id: string) {
    const user = profileOf(await auth.requireAuth(context));
    const raw = await posts.get(id);
    if (!raw) return { success: false };
    const post = JSON.parse(raw);
    if (post.authorKey !== user.key) throw new Error('Not authorized to delete this post');

    await posts.delete(id);

    const indexRaw = await postIndex.get('all');
    const ids: string[] = indexRaw ? JSON.parse(indexRaw) : [];
    await postIndex.put('all', JSON.stringify(ids.filter(i => i !== id)));

    const myPostsRaw = await userPosts.get(`user:${user.key}`);
    const myPostIds: string[] = myPostsRaw ? JSON.parse(myPostsRaw) : [];
    await userPosts.put(`user:${user.key}`, JSON.stringify(myPostIds.filter(i => i !== id)));

    return { success: true };
  },
}));

export const authApi = auth.createApi();

// ── Sandbox e2e test support (only when `sandboxE2e`) ──────────────────────

// The secret guarding `testSupport`. The stack generates a random value at
// deploy (an SSM SecureString), and the e2e harness reads it from SSM; it is
// never in the repo and never logged. `index.cdk.ts` outputs the parameter
// name for the harness.
const testSupportSecret = sandboxE2e ? new AppSetting(scope, 'test-support-secret', { secret: true }) : null;

/** Constant-time comparison of a caller-supplied secret with the expected one. */
function secretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Sandbox e2e support. Absent (`undefined`, so no RPC route) unless the app was
 * built for the sandbox e2e, and every call must present the per-deploy secret.
 */
export const testSupport = testSupportSecret
  ? new ApiNamespace(scope, 'testSupport', () => ({
      /**
       * Create a confirmed user. Cognito emails the sign-up code to the
       * address, which the test cannot read, so it creates the user through
       * `auth.admin` instead. Never expose this in a real app: it lets the
       * caller create an account.
       */
      async provisionUser(secret: string, username: string, password: string) {
        if (!secretMatches(secret, await testSupportSecret.get())) throw new ApiError('Forbidden', 403);
        await auth.admin.createUser(username, { suppressInvite: true, attributes: { email: username } });
        await auth.admin.setUserPassword(username, password, { permanent: true });
        return { success: true };
      },
    }))
  : undefined;
