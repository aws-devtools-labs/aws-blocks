// Direct import from backend - types available in IDE, Proxy injected at runtime
import { api, authApi } from 'aws-blocks';
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

let currentUser: { username: string } | null = null;
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
  } catch (error: any) {
    if (errorDiv) showError(errorDiv, error.message);
  }
}

// Add todo
(window as any).addTodo = async () => {
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
  } catch (error: any) {
    if (errorDiv) showError(errorDiv, error.message);
  }
};

// Change sort order
(window as any).changeSort = async (sortBy: string) => {
  currentSort = sortBy === 'none' ? undefined : sortBy as 'priority' | 'title' | 'createdAt';
  await refreshTodos();
};

// Toggle todo completion
(window as any).toggleTodo = async (todoId: string, completed: boolean) => {
  const errorDiv = document.getElementById('todo-error');
  if (errorDiv) showMessage(errorDiv, '', 'idle');
  
  try {
    await api.updateTodo(todoId, { completed });
    await refreshTodos();
  } catch (error: any) {
    if (errorDiv) showError(errorDiv, error.message);
    await refreshTodos();
  }
};

// Change priority
(window as any).changePriority = async (todoId: string, priority: number) => {
  const errorDiv = document.getElementById('todo-error');
  if (errorDiv) showMessage(errorDiv, '', 'idle');
  
  try {
    await api.updateTodo(todoId, { priority });
    await refreshTodos();
  } catch (error: any) {
    if (errorDiv) showError(errorDiv, error.message);
    await refreshTodos();
  }
};

// Update title
(window as any).updateTitle = async (todoId: string, title: string) => {
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
  } catch (error: any) {
    if (errorDiv) showError(errorDiv, error.message);
    await refreshTodos();
  }
};

// Delete todo
(window as any).deleteTodo = async (todoId: string) => {
  const errorDiv = document.getElementById('todo-error');
  if (errorDiv) showMessage(errorDiv, '', 'idle');
  
  try {
    await api.deleteTodo(todoId);
    await refreshTodos();
  } catch (error: any) {
    if (errorDiv) showError(errorDiv, error.message);
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
      authStatus.textContent = user ? `Logged in as: ${user.username}` : 'Not logged in';
    }
    await refreshTodos();
  });
});

// Cookie test functions
(window as any).testSetCookie = async () => {
  const value = (document.getElementById('cookieValue') as HTMLInputElement).value;
  const out = document.getElementById('cookie-result')!;

  await api.setCookie(value);
  showMessage(out, `✓ Set cookie = ${value}`, 'success');
};

(window as any).testGetCookie = async () => {
  const value = await api.getCookie();
  const out = document.getElementById('cookie-result')!;
  if (value) showMessage(out, `✓ Got cookie: ${value}`, 'success');
  else showMessage(out, '∅ Cookie not found', 'idle');
};

(window as any).testDeleteCookie = async () => {
  await api.deleteCookie();
  const out = document.getElementById('cookie-result')!;
  showMessage(out, '✓ Deleted cookie', 'success');
};

// KV Store test functions (requireAuth-gated: sign in first)
(window as any).testSetValue = async () => {
  const key = (document.getElementById('key') as HTMLInputElement).value;
  const value = (document.getElementById('value') as HTMLInputElement).value;
  const out = document.getElementById('kv-result')!;

  try {
    await api.setValue(key, value);
    showMessage(out, `✓ Set ${key} = ${value}`, 'success');
  } catch (error: any) {
    showError(out, error.message);
  }
};

(window as any).testGetValue = async () => {
  const key = (document.getElementById('key') as HTMLInputElement).value;
  const out = document.getElementById('kv-result')!;

  try {
    const value = await api.getValue(key);
    if (value) showMessage(out, `✓ Got value: ${value}`, 'success');
    else showMessage(out, '∅ Key not found', 'idle');
  } catch (error: any) {
    showError(out, error.message);
  }
};

(window as any).runAllTests = async () => {
  const results: string[] = [];

  // KV methods are requireAuth-gated: signed out, they reject with 401.
  try {
    await api.setValue('test1', 'value1');
    const val = await api.getValue('test1');
    results.push(val === 'value1' ? '✓ KV Store works' : '✗ KV Store failed');
  } catch (error: any) {
    results.push(error.status === 401
      ? '– KV Store skipped: sign in to run the KV test'
      : `✗ KV Store failed: ${escapeHtml(error.message)}`);
  }

  // The cookie round-trip is public, so it runs whether or not you're signed in.
  try {
    await api.setCookie('testValue');
    const cookie = await api.getCookie();
    results.push(cookie === 'testValue' ? '✓ Cookie set/get works' : '✗ Cookie failed');

    await api.deleteCookie();
    const deleted = await api.getCookie();
    results.push(!deleted ? '✓ Cookie delete works' : '✗ Cookie delete failed');
  } catch (error: any) {
    results.push(`✗ Cookie test failed: ${escapeHtml(error.message)}`);
  }

  document.getElementById('test-results')!.innerHTML = results.join('<br>');
};

console.log('AWS Blocks Demo loaded - using direct backend imports with Proxy');
