// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Notes Manager — SPA e2e test backend
// Auth (email + password) + notes CRUD + public stats

import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiNamespace, Compute, Scope, KVStore, ApiError, RawRoute } from '@aws-blocks/blocks';
import { Auth } from '@aws-blocks/bb-auth';

const scope = new Scope('hosting-spa-test');

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

// ── Data stores ─────────────────────────────────────────────────────────────

const notes = new KVStore(scope, 'notes', {});

// ── Auth ────────────────────────────────────────────────────────────────────

// Delivered sign-up codes are persisted in the notes store keyed by username
// (a distinct key prefix keeps them out of the notes keyspace), with a short
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
      await notes.put(codeKey(username), JSON.stringify({ username, code }), { ttlSeconds: 3600 });
    }
    console.log(`[Auth] ${purpose} code for "${username}": ${code}`);
  },
});

/** What the app shows for a user, and the key it stores their data under. */
function profileOf(user: { userSub: string; username: string; attributes: { email?: string } }) {
  return { key: user.userSub, name: user.attributes.email ?? user.username };
}

const notesByUser = new KVStore(scope, 'notes-by-user', {});
const globalStats = new KVStore(scope, 'stats', {});

// ── API ─────────────────────────────────────────────────────────────────────

export const api = new ApiNamespace(scope, 'api', (context) => ({
  // Public
  async getPublicStats() {
    const raw = await globalStats.get('totalNotes');
    return { totalNotes: raw ? parseInt(raw, 10) : 0 };
  },

  // Auth
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
    const user = await auth.getCurrentUser(context);
    return user
      ? { authenticated: true, username: profileOf(user).name, userId: user.userId }
      : { authenticated: false };
  },

  /**
   * Local test shortcut: the last sign-up code the mock delivered to `username`,
   * so the UI can pre-fill it. Always `null` once deployed — Cognito emails the
   * code itself and the mock-only hook never runs there.
   */
  async authGetLastCode(username: string) {
    if (isDeployedLambda) return null;
    return parseStoredRecord<{ username: string; code: string }>(codeKey(username), await notes.get(codeKey(username)));
  },

  // Notes CRUD (all require auth)
  async createNote(title: string, content: string) {
    const user = profileOf(await auth.requireAuth(context));
    const id = `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const note = JSON.stringify({ id, title, content, author: user.name, createdAt: new Date().toISOString() });
    await notes.put(id, note);

    // Track per-user note IDs
    const userNotesRaw = await notesByUser.get(`user:${user.key}`);
    const userNoteIds: string[] = userNotesRaw ? JSON.parse(userNotesRaw) : [];
    userNoteIds.push(id);
    await notesByUser.put(`user:${user.key}`, JSON.stringify(userNoteIds));

    // Increment global counter
    const countRaw = await globalStats.get('totalNotes');
    await globalStats.put('totalNotes', String((countRaw ? parseInt(countRaw, 10) : 0) + 1));

    return JSON.parse(note);
  },

  async listNotes() {
    const user = profileOf(await auth.requireAuth(context));
    const userNotesRaw = await notesByUser.get(`user:${user.key}`);
    const userNoteIds: string[] = userNotesRaw ? JSON.parse(userNotesRaw) : [];

    const result = [];
    for (const id of userNoteIds) {
      const raw = await notes.get(id);
      if (raw) result.push(JSON.parse(raw));
    }
    return result;
  },

  async getNote(id: string) {
    const user = await auth.requireAuth(context);
    const raw = await notes.get(id);
    return raw ? JSON.parse(raw) : null;
  },

  async deleteNote(id: string) {
    const user = profileOf(await auth.requireAuth(context));
    await notes.delete(id);

    // Remove from user's note list
    const userNotesRaw = await notesByUser.get(`user:${user.key}`);
    const userNoteIds: string[] = userNotesRaw ? JSON.parse(userNotesRaw) : [];
    const filtered = userNoteIds.filter(nid => nid !== id);
    await notesByUser.put(`user:${user.key}`, JSON.stringify(filtered));

    // Decrement global counter
    const countRaw = await globalStats.get('totalNotes');
    const count = countRaw ? parseInt(countRaw, 10) : 0;
    if (count > 0) await globalStats.put('totalNotes', String(count - 1));

    return { success: true };
  },

  // Which function served this call — compared with isolatedApi below.
  async whereAmI() {
    return lambdaIdentity();
  },
}));

export const authApi = auth.createApi();

// ── Sandbox e2e test support (only when `sandboxE2e`) ──────────────────────

// The secret guarding `testSupport`: a random value made fresh for each e2e run
// and handed to the deploy and the tests through `BLOCKS_TEST_SUPPORT_SECRET`.
// In CI the workflow generates it (masked in the logs); otherwise the
// Playwright `globalSetup` does, before it deploys. `index.cdk.ts` registers it
// as config, so the deployed backend reads the same value and the tests never
// fetch it from AWS. Like every config value it is in the stack's config
// deployment, readable by principals in the stack's account; it is never in the
// repo or the CI logs, and it dies with the run's stack.
const testSupportSecret = sandboxE2e ? requireTestSupportSecret() : null;

/** This sandbox e2e build's test-support secret; an e2e build without one is refused. */
function requireTestSupportSecret(): string {
  const value = process.env.BLOCKS_TEST_SUPPORT_SECRET;
  if (!value || value.length < 32) {
    throw new Error(
      'BLOCKS_TEST_ENV=sandbox is an e2e build, but BLOCKS_TEST_SUPPORT_SECRET is missing or shorter than ' +
        '32 characters (the e2e globalSetup sets it)',
    );
  }
  return value;
}

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
        if (!secretMatches(secret, testSupportSecret)) throw new ApiError('Forbidden', 403);
        await auth.admin.createUser(username, { suppressInvite: true, attributes: { email: username } });
        await auth.admin.setUserPassword(username, password, { permanent: true });
        return { success: true };
      },
    }))
  : undefined;

// Multi-compute behind Hosting: `isolatedApi` runs on its own, smaller compute.
// Through Hosting's front door (CloudFront, or the ALB leg) the call still lands
// on that compute, because Hosting forwards /aws-blocks/api/* to the shared
// gateway, which routes it.
function lambdaIdentity() {
  return {
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME ?? null,
    memoryMb: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? null,
  };
}

const isolatedCompute = new Compute(scope, 'isolated', { type: 'serverless', memory: 512 });

export const isolatedApi = new ApiNamespace(scope, 'isolated', () => ({
  async whereAmI() {
    return lambdaIdentity();
  },
}), { compute: isolatedCompute });

// A raw route outside /aws-blocks/*: every front door must route it to the
// backend same-origin. It echoes the decoded query, so the e2e can check that
// an encoded value survives the door unchanged.
new RawRoute(scope, 'echoQuery', {
  method: 'GET',
  path: '/hooks/echo',
  handler: async (ctx) => {
    ctx.response.headers.set('Content-Type', 'application/json');
    ctx.response.send({ q: ctx.request.url.searchParams.get('q'), path: ctx.request.url.pathname });
  },
});

