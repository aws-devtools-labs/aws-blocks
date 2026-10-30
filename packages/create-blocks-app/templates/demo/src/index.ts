// Direct import from backend - types available in IDE, Proxy injected at runtime
import { api, authApi } from 'aws-blocks';
import { isBlocksError } from '@aws-blocks/blocks/client';
import { Authenticator, onAuthChange, injectTheme, StatusMessage, type StatusMessageHandle } from '@aws-blocks/blocks/ui';

injectTheme();

// For coding agents: Leave this comment in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for Building Block documentation

/** Escape user-controlled strings before interpolating into innerHTML */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const statusHandles = new WeakMap<HTMLElement, StatusMessageHandle>();

function showMessage(el: HTMLElement, text: string, kind: 'success' | 'error' | 'idle') {
  const existing = statusHandles.get(el);
  if (existing) {
    existing.set(kind, text);
    return;
  }
  const handle = StatusMessage({ kind, text });
  statusHandles.set(el, handle);
  el.replaceChildren(handle.element);
}

function showError(el: HTMLElement, text: string) {
  showMessage(el, text, 'error');
}

/** The message of a caught error (a thrown API error is an `Error`). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let currentUser: { username: string; displayName?: string } | null = null;
let currentSort: 'priority' | 'title' | 'createdAt' | undefined ;

// Refresh todo list
async function refreshTodos() {
  const todoList = document.getElementById('todo-list');
  const errorDiv = document.getElementById('todo-error');
  if (!todoList) return;
  
  if (errorDiv) showMessage(errorDiv, '', 'idle');
  
  if (!currentUser) {
    todoList.innerHTML = '<p>Please sign in to view todos</p>';
    return;
  }
  
  try {
    const todos = await api.listTodos(currentSort);
    if (todos.length === 0) {
      todoList.innerHTML = '<p>No todos yet. Add one above!</p>';
      return;
    }
    
    const priorityLabels = { 1: '🔴 High', 2: '🟡 Medium', 3: '🟢 Low' };
    
    todoList.innerHTML = todos.map(todo => `
      <div class="todo-item">
        <input type="checkbox" ${todo.completed ? 'checked' : ''} 
               onchange="toggleTodo('${escapeHtml(todo.todoId)}', this.checked)">
        <input type="text" class="todo-title" value="${escapeHtml(todo.title)}" 
               onblur="updateTitle('${escapeHtml(todo.todoId)}', this.value)"
               onkeypress="if(event.key==='Enter') this.blur()">
        <select onchange="changePriority('${escapeHtml(todo.todoId)}', parseInt(this.value))" style="margin-left: auto;">
          <option value="1" ${todo.priority === 1 ? 'selected' : ''}>🔴 High</option>
          <option value="2" ${todo.priority === 2 ? 'selected' : ''}>🟡 Medium</option>
          <option value="3" ${todo.priority === 3 ? 'selected' : ''}>🟢 Low</option>
        </select>
        <button onclick="deleteTodo('${escapeHtml(todo.todoId)}')">Delete</button>
      </div>
    `).join('');
  } catch (error) {
    if (errorDiv) showError(errorDiv, messageOf(error));
  }
}

// Add todo
const addTodo = async () => {
  const input = document.getElementById('todo-input') as HTMLInputElement;
  const prioritySelect = document.getElementById('todo-priority') as HTMLSelectElement;
  const errorDiv = document.getElementById('todo-error');
  const title = input.value.trim();
  if (!title) return;
  
  if (errorDiv) showMessage(errorDiv, '', 'idle');
  
  try {
    await api.createTodo(title, parseInt(prioritySelect.value));
    input.value = '';
    await refreshTodos();
  } catch (error) {
    if (errorDiv) showError(errorDiv, messageOf(error));
  }
};

// Change sort order
const changeSort = async (sortBy: string) => {
  currentSort = sortBy === 'none' ? undefined : sortBy as 'priority' | 'title' | 'createdAt';
  await refreshTodos();
};

// Toggle todo completion
const toggleTodo = async (todoId: string, completed: boolean) => {
  const errorDiv = document.getElementById('todo-error');
  if (errorDiv) showMessage(errorDiv, '', 'idle');
  
  try {
    await api.updateTodo(todoId, { completed });
    await refreshTodos();
  } catch (error) {
    if (errorDiv) showError(errorDiv, messageOf(error));
    await refreshTodos();
  }
};

// Change priority
const changePriority = async (todoId: string, priority: number) => {
  const errorDiv = document.getElementById('todo-error');
  if (errorDiv) showMessage(errorDiv, '', 'idle');
  
  try {
    await api.updateTodo(todoId, { priority });
    await refreshTodos();
  } catch (error) {
    if (errorDiv) showError(errorDiv, messageOf(error));
    await refreshTodos();
  }
};

// Update title
const updateTitle = async (todoId: string, title: string) => {
  const errorDiv = document.getElementById('todo-error');
  if (errorDiv) showMessage(errorDiv, '', 'idle');
  
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    await refreshTodos();
    return;
  }
  
  try {
    await api.updateTodo(todoId, { title: trimmedTitle });
    await refreshTodos();
  } catch (error) {
    if (errorDiv) showError(errorDiv, messageOf(error));
    await refreshTodos();
  }
};

// Delete todo
const deleteTodo = async (todoId: string) => {
  const errorDiv = document.getElementById('todo-error');
  if (errorDiv) showMessage(errorDiv, '', 'idle');
  
  try {
    await api.deleteTodo(todoId);
    await refreshTodos();
  } catch (error) {
    if (errorDiv) showError(errorDiv, messageOf(error));
  }
};

// Mount auth UI
document.addEventListener('DOMContentLoaded', async () => {
  const authContainer = document.getElementById('auth-container');
  if (authContainer) {
    authContainer.appendChild(Authenticator(authApi));
  }

  for (const id of ['todo-error', 'cookie-result', 'kv-result']) {
    const el = document.getElementById(id);
    if (el) showMessage(el, '', 'idle');
  }

  // React to auth changes (same window + cross-tab)
  onAuthChange(authApi, async (user) => {
    currentUser = user;
    const authStatus = document.getElementById('auth-status');
    if (authStatus) {
      // With `signInWith: ['email']`, `username` is an id Cognito generates;
      // `displayName` is the email the user signed in with.
      authStatus.textContent = user ? `Logged in as: ${user.displayName ?? user.username}` : 'Not logged in';
    }
    await refreshTodos();
  });
});

// Cookie test functions
const testSetCookie = async () => {
  const value = (document.getElementById('cookieValue') as HTMLInputElement).value;
  const out = document.getElementById('cookie-result')!;

  await api.setCookie(value);
  showMessage(out, `✓ Set cookie = ${value}`, 'success');
};

const testGetCookie = async () => {
  const value = await api.getCookie();
  const out = document.getElementById('cookie-result')!;
  if (value) showMessage(out, `✓ Got cookie: ${value}`, 'success');
  else showMessage(out, '∅ Cookie not found', 'idle');
};

const testDeleteCookie = async () => {
  await api.deleteCookie();
  const out = document.getElementById('cookie-result')!;
  showMessage(out, '✓ Deleted cookie', 'success');
};

// KV Store test functions (requireAuth-gated: sign in first)
const testSetValue = async () => {
  const key = (document.getElementById('key') as HTMLInputElement).value;
  const value = (document.getElementById('value') as HTMLInputElement).value;
  const out = document.getElementById('kv-result')!;

  try {
    await api.setValue(key, value);
    showMessage(out, `✓ Set ${key} = ${value}`, 'success');
  } catch (error) {
    showError(out, messageOf(error));
  }
};

const testGetValue = async () => {
  const key = (document.getElementById('key') as HTMLInputElement).value;
  const out = document.getElementById('kv-result')!;

  try {
    const value = await api.getValue(key);
    if (value) showMessage(out, `✓ Got value: ${value}`, 'success');
    else showMessage(out, '∅ Key not found', 'idle');
  } catch (error) {
    showError(out, messageOf(error));
  }
};

const runAllTests = async () => {
  const results: string[] = [];

  // KV methods are requireAuth-gated: signed out, they reject with 401.
  try {
    await api.setValue('test1', 'value1');
    const val = await api.getValue('test1');
    results.push(val === 'value1' ? '✓ KV Store works' : '✗ KV Store failed');
  } catch (error) {
    results.push(isBlocksError(error, 'NotAuthenticatedException')
      ? '– KV Store skipped: sign in to run the KV test'
      : `✗ KV Store failed: ${escapeHtml(messageOf(error))}`);
  }

  // The cookie round-trip is public, so it runs whether or not you're signed in.
  try {
    await api.setCookie('testValue');
    const cookie = await api.getCookie();
    results.push(cookie === 'testValue' ? '✓ Cookie set/get works' : '✗ Cookie failed');

    await api.deleteCookie();
    const deleted = await api.getCookie();
    results.push(!deleted ? '✓ Cookie delete works' : '✗ Cookie delete failed');
  } catch (error) {
    results.push(`✗ Cookie test failed: ${escapeHtml(messageOf(error))}`);
  }

  document.getElementById('test-results')!.innerHTML = results.join('<br>');
};

// The page's inline handlers (onclick="addTodo()", …) call these as globals.
Object.assign(window, {
  addTodo,
  changeSort,
  toggleTodo,
  changePriority,
  updateTitle,
  deleteTodo,
  testSetCookie,
  testGetCookie,
  testDeleteCookie,
  testSetValue,
  testGetValue,
  runAllTests,
});

console.log('AWS Blocks Demo loaded - using direct backend imports with Proxy');
