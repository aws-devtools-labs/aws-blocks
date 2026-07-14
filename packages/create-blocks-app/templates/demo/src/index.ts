// Direct import from backend - types available in IDE, Proxy injected at runtime
import { api, authApi } from 'aws-blocks';
import { Authenticator, onAuthChange } from '@aws-blocks/blocks/ui';

// For coding agents: Leave this comment in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for Building Block documentation

/** Escape user-controlled strings before interpolating into innerHTML */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let currentUser: { username: string } | null = null;
let currentSort: 'priority' | 'title' | 'createdAt' | undefined ;

// Refresh todo list
async function refreshTodos() {
  const todoList = document.getElementById('todo-list');
  const errorDiv = document.getElementById('todo-error');
  if (!todoList) return;
  
  if (errorDiv) errorDiv.innerHTML = '';
  
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
    if (errorDiv) errorDiv.innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`;
  }
}

// Add todo
(window as any).addTodo = async () => {
  const input = document.getElementById('todo-input') as HTMLInputElement;
  const prioritySelect = document.getElementById('todo-priority') as HTMLSelectElement;
  const errorDiv = document.getElementById('todo-error');
  const title = input.value.trim();
  if (!title) return;
  
  if (errorDiv) errorDiv.innerHTML = '';
  
  try {
    await api.createTodo(title, parseInt(prioritySelect.value));
    input.value = '';
    await refreshTodos();
  } catch (error: any) {
    if (errorDiv) errorDiv.innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`;
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
  if (errorDiv) errorDiv.innerHTML = '';
  
  try {
    await api.updateTodo(todoId, { completed });
    await refreshTodos();
  } catch (error: any) {
    if (errorDiv) errorDiv.innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`;
    await refreshTodos();
  }
};

// Change priority
(window as any).changePriority = async (todoId: string, priority: number) => {
  const errorDiv = document.getElementById('todo-error');
  if (errorDiv) errorDiv.innerHTML = '';
  
  try {
    await api.updateTodo(todoId, { priority });
    await refreshTodos();
  } catch (error: any) {
    if (errorDiv) errorDiv.innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`;
    await refreshTodos();
  }
};

// Update title
(window as any).updateTitle = async (todoId: string, title: string) => {
  const errorDiv = document.getElementById('todo-error');
  if (errorDiv) errorDiv.innerHTML = '';
  
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    await refreshTodos();
    return;
  }
  
  try {
    await api.updateTodo(todoId, { title: trimmedTitle });
    await refreshTodos();
  } catch (error: any) {
    if (errorDiv) errorDiv.innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`;
    await refreshTodos();
  }
};

// Delete todo
(window as any).deleteTodo = async (todoId: string) => {
  const errorDiv = document.getElementById('todo-error');
  if (errorDiv) errorDiv.innerHTML = '';
  
  try {
    await api.deleteTodo(todoId);
    await refreshTodos();
  } catch (error: any) {
    if (errorDiv) errorDiv.innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`;
  }
};

// Mount auth UI
document.addEventListener('DOMContentLoaded', async () => {
  const authContainer = document.getElementById('auth-container');
  if (authContainer) {
    authContainer.appendChild(Authenticator(authApi));
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
  const name = (document.getElementById('cookieName') as HTMLInputElement).value;
  const value = (document.getElementById('cookieValue') as HTMLInputElement).value;
  
  await api.setCookie(name, value);
  document.getElementById('cookie-result')!.innerHTML = 
    `<span class="success">✓ Set cookie ${escapeHtml(name)} = ${escapeHtml(value)}</span>`;
};

(window as any).testGetCookie = async () => {
  const name = (document.getElementById('cookieName') as HTMLInputElement).value;
  
  const value = await api.getCookie(name);
  document.getElementById('cookie-result')!.innerHTML = 
    value ? `<span class="success">✓ Got cookie: ${escapeHtml(value)}</span>` 
          : `<span class="error">✗ Cookie not found</span>`;
};

(window as any).testDeleteCookie = async () => {
  const name = (document.getElementById('cookieName') as HTMLInputElement).value;
  
  await api.deleteCookie(name);
  document.getElementById('cookie-result')!.innerHTML = 
    `<span class="success">✓ Deleted cookie ${escapeHtml(name)}</span>`;
};

// KV Store test functions
(window as any).testSetValue = async () => {
  const key = (document.getElementById('key') as HTMLInputElement).value;
  const value = (document.getElementById('value') as HTMLInputElement).value;
  
  const result = await api.setValue(key, value);
  
  document.getElementById('kv-result')!.innerHTML = 
    `<span class="success">✓ Set ${escapeHtml(key)} = ${escapeHtml(value)}</span>`;
};

(window as any).testGetValue = async () => {
  const key = (document.getElementById('key') as HTMLInputElement).value;
  
  const value = await api.getValue(key);
  
  document.getElementById('kv-result')!.innerHTML = 
    value ? `<span class="success">✓ Got value: ${escapeHtml(value)}</span>` 
          : `<span class="error">✗ Key not found</span>`;
};

(window as any).runAllTests = async () => {
  const results: string[] = [];
  
  try {
    await api.setValue('test1', 'value1');
    const val = await api.getValue('test1');
    results.push(val === 'value1' ? '✓ KV Store works' : '✗ KV Store failed');
    
    await api.setCookie('testCookie', 'testValue');
    const cookie = await api.getCookie('testCookie');
    results.push(cookie === 'testValue' ? '✓ Cookie set/get works' : '✗ Cookie failed');
    
    await api.deleteCookie('testCookie');
    const deleted = await api.getCookie('testCookie');
    results.push(!deleted ? '✓ Cookie delete works' : '✗ Cookie delete failed');

    document.getElementById('test-results')!.innerHTML = results.join('<br>');
  } catch (error: any) {
    document.getElementById('test-results')!.innerHTML = 
      `<span class="error">✗ Tests failed: ${escapeHtml(error.message)}</span>`;
  }
};

console.log('AWS Blocks Demo loaded - using direct backend imports with Proxy');
