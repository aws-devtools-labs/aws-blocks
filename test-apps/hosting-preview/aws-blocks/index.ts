// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Notes Manager — SPA e2e test backend
// AuthBasic + notes CRUD + public stats

import { ApiNamespace, Scope, KVStore, AuthBasic } from '@aws-blocks/blocks';

const scope = new Scope('hosting-spa-test');

// Verification codes are sensitive. e2e tests read them via the API getter
// below, not from logs — so only echo to the console in local/mock dev. In the
// deployed Lambda this is a no-op so codes never reach CloudWatch.
const isDeployedLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME;

// ── Auth ────────────────────────────────────────────────────────────────────

let lastDeliveredCode: { username: string; code: string } | null = null;
const auth = new AuthBasic(scope, 'auth', {
  sessionDuration: 86400,
  passwordPolicy: { minLength: 6 },
  codeDelivery: async (username, code) => {
    lastDeliveredCode = { username, code };
    if (!isDeployedLambda) console.log(`[AuthBasic] Code for "${username}": ${code}`);
  },
});

// ── Data stores ─────────────────────────────────────────────────────────────

const notes = new KVStore(scope, 'notes', {});
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
    const user = await auth.signIn(username, password, context);
    return { userId: user.userId, username: user.username };
  },

  async authSignOut() {
    await auth.signOut(context);
    return { success: true };
  },

  async authCheckAuth() {
    const user = await auth.getCurrentUser(context);
    return user
      ? { authenticated: true, username: user.username, userId: user.userId }
      : { authenticated: false };
  },

  async authGetLastCode() {
    return lastDeliveredCode;
  },

  // Notes CRUD (all require auth)
  async createNote(title: string, content: string) {
    const user = await auth.requireAuth(context);
    const id = `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const note = JSON.stringify({ id, title, content, author: user.username, createdAt: new Date().toISOString() });
    await notes.put(id, note);

    // Track per-user note IDs
    const userNotesRaw = await notesByUser.get(`user:${user.username}`);
    const userNoteIds: string[] = userNotesRaw ? JSON.parse(userNotesRaw) : [];
    userNoteIds.push(id);
    await notesByUser.put(`user:${user.username}`, JSON.stringify(userNoteIds));

    // Increment global counter
    const countRaw = await globalStats.get('totalNotes');
    await globalStats.put('totalNotes', String((countRaw ? parseInt(countRaw, 10) : 0) + 1));

    return JSON.parse(note);
  },

  async listNotes() {
    const user = await auth.requireAuth(context);
    const userNotesRaw = await notesByUser.get(`user:${user.username}`);
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
    const user = await auth.requireAuth(context);
    await notes.delete(id);

    // Remove from user's note list
    const userNotesRaw = await notesByUser.get(`user:${user.username}`);
    const userNoteIds: string[] = userNotesRaw ? JSON.parse(userNotesRaw) : [];
    const filtered = userNoteIds.filter(nid => nid !== id);
    await notesByUser.put(`user:${user.username}`, JSON.stringify(filtered));

    // Decrement global counter
    const countRaw = await globalStats.get('totalNotes');
    const count = countRaw ? parseInt(countRaw, 10) : 0;
    if (count > 0) await globalStats.put('totalNotes', String(count - 1));

    return { success: true };
  },
}));

export const authApi = auth.createApi();
