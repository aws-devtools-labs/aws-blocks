// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { api } from 'hosting-spa-aws-blocks';

declare global {
  interface Window {
    doLogin: () => void;
    doSignUp: () => void;
    doConfirm: () => void;
    doLogout: () => void;
    doCreateNote: () => void;
    doDeleteNote: (id: string) => void;
  }
}

const $ = (id: string) => document.getElementById(id)!;
function show(id: string) { $(id).classList.remove('hidden'); }
function hide(id: string) { $(id).classList.add('hidden'); }
function setText(id: string, text: string) { $(id).textContent = text; }

let currentUsername = '';
let pendingSignUpUsername = '';

// ── View switching ──────────────────────────────────────────────────────────

function showLanding() {
  show('view-landing');
  hide('view-dashboard');
  setText('auth-error', '');
  setText('auth-info', '');
  loadPublicStats();
}

function showDashboard(username: string) {
  currentUsername = username;
  hide('view-landing');
  show('view-dashboard');
  setText('display-username', username);
  setText('create-error', '');
  loadNotes();
}

// ── Public stats ────────────────────────────────────────────────────────────

async function loadPublicStats() {
  try {
    const stats = await api.getPublicStats();
    setText('stat-total', String(stats.totalNotes));
  } catch {
    setText('stat-total', '0');
  }
}

// ── Auth flow ───────────────────────────────────────────────────────────────

window.doSignUp = async () => {
  const username = ($('login-username') as HTMLInputElement).value.trim();
  const password = ($('login-password') as HTMLInputElement).value;
  setText('auth-error', '');
  if (!username || !password) { setText('auth-error', 'Please enter email and password'); return; }
  try {
    await api.authSignUp(username, password);
    pendingSignUpUsername = username;
    // Auto-retrieve code (test shortcut)
    const codeInfo = await api.authGetLastCode();
    if (codeInfo) ($('confirm-code') as HTMLInputElement).value = codeInfo.code;
    show('confirm-section');
    setText('auth-info', 'Account created! Confirm with the verification code.');
  } catch (e: any) {
    setText('auth-error', e.message);
  }
};

window.doConfirm = async () => {
  const code = ($('confirm-code') as HTMLInputElement).value.trim();
  setText('auth-error', '');
  try {
    await api.authConfirmSignUp(pendingSignUpUsername, code);
    hide('confirm-section');
    setText('auth-info', 'Confirmed! You can now log in.');
  } catch (e: any) {
    setText('auth-error', e.message);
  }
};

window.doLogin = async () => {
  const username = ($('login-username') as HTMLInputElement).value.trim();
  const password = ($('login-password') as HTMLInputElement).value;
  setText('auth-error', '');
  if (!username || !password) { setText('auth-error', 'Please enter email and password'); return; }
  try {
    const user = await api.authSignIn(username, password);
    showDashboard(user.username);
  } catch (e: any) {
    setText('auth-error', e.message);
  }
};

window.doLogout = async () => {
  try { await api.authSignOut(); } catch {}
  currentUsername = '';
  showLanding();
};

// ── Notes CRUD ──────────────────────────────────────────────────────────────

window.doCreateNote = async () => {
  const title = ($('note-title') as HTMLInputElement).value.trim();
  const content = ($('note-content') as HTMLTextAreaElement).value.trim();
  setText('create-error', '');
  if (!title) { setText('create-error', 'Title is required'); return; }
  try {
    await api.createNote(title, content);
    ($('note-title') as HTMLInputElement).value = '';
    ($('note-content') as HTMLTextAreaElement).value = '';
    await loadNotes();
  } catch (e: any) {
    setText('create-error', e.message);
  }
};

window.doDeleteNote = async (id: string) => {
  try {
    await api.deleteNote(id);
    await loadNotes();
  } catch (e: any) {
    alert(`Delete failed: ${e.message}`);
  }
};

async function loadNotes() {
  const list = $('notes-list');
  try {
    const notesList = await api.listNotes();
    if (notesList.length === 0) {
      list.innerHTML = '';
      show('notes-empty');
      return;
    }
    hide('notes-empty');
    list.innerHTML = notesList.map((note: any) => `
      <div class="card note-item" data-testid="note-item" data-note-id="${escapeAttr(note.id)}">
        <div class="note-body">
          <strong>${escapeHtml(note.title)}</strong>
          <p class="muted">${escapeHtml(note.content)}</p>
        </div>
        <button class="danger btn-delete" data-testid="btn-delete" data-delete-id="${escapeAttr(note.id)}">Delete</button>
      </div>
    `).join('');
  } catch (e: any) {
    list.innerHTML = `<p class="error">Failed to load notes: ${escapeHtml(e.message)}</p>`;
  }
}

// Event delegation for delete buttons — prevents XSS via note IDs
$('notes-list').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-delete-id]') as HTMLElement | null;
  if (btn) {
    const id = btn.dataset.deleteId;
    if (id) window.doDeleteNote(id);
  }
});

function escapeHtml(str: string) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str: string) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Init ────────────────────────────────────────────────────────────────────

async function init() {
  setText('app-status', 'Ready');
  try {
    const auth = await api.authCheckAuth();
    if (auth.authenticated) {
      showDashboard(auth.username!);
      return;
    }
  } catch {}
  showLanding();
}

init();
