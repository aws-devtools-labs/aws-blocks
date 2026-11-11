// Direct import from backend - types available in IDE, Proxy injected at runtime
import { api, authApi } from 'aws-blocks';
import { Authenticator, onAuthChange } from '@aws-blocks/blocks/ui';

// For coding agents: Leave this comment in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for Building Block documentation

/** Escapes HTML metacharacters to prevent XSS when interpolating into innerHTML. */
function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let currentUser: { username: string } | null = null;
let currentSort: 'priority' | 'title' | 'createdAt' | undefined = undefined;

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
               onchange="toggleTodo('${esc(todo.todoId)}', this.checked)">
        <input type="text" class="todo-title" value="${esc(todo.title)}"
               onblur="updateTitle('${esc(todo.todoId)}', this.value)"
               onkeypress="if(event.key==='Enter') this.blur()">
        <select onchange="changePriority('${esc(todo.todoId)}', parseInt(this.value))" style="margin-left: auto;">
          <option value="1" ${todo.priority === 1 ? 'selected' : ''}>🔴 High</option>
          <option value="2" ${todo.priority === 2 ? 'selected' : ''}>🟡 Medium</option>
          <option value="3" ${todo.priority === 3 ? 'selected' : ''}>🟢 Low</option>
        </select>
        <button onclick="deleteTodo('${esc(todo.todoId)}')">Delete</button>
      </div>
    `).join('');
  } catch (error: any) {
    if (errorDiv) errorDiv.innerHTML = `<span class="error">${esc(error.message)}</span>`;
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
    if (errorDiv) errorDiv.innerHTML = `<span class="error">${esc(error.message)}</span>`;
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
    if (errorDiv) errorDiv.innerHTML = `<span class="error">${esc(error.message)}</span>`;
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
    if (errorDiv) errorDiv.innerHTML = `<span class="error">${esc(error.message)}</span>`;
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
    if (errorDiv) errorDiv.innerHTML = `<span class="error">${esc(error.message)}</span>`;
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
    if (errorDiv) errorDiv.innerHTML = `<span class="error">${esc(error.message)}</span>`;
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
    `<span class="success">✓ Set cookie ${esc(name)} = ${esc(value)}</span>`;
};

(window as any).testGetCookie = async () => {
  const name = (document.getElementById('cookieName') as HTMLInputElement).value;

  const value = await api.getCookie(name);
  document.getElementById('cookie-result')!.innerHTML =
    value ? `<span class="success">✓ Got cookie: ${esc(value)}</span>`
          : `<span class="error">✗ Cookie not found</span>`;
};

(window as any).testDeleteCookie = async () => {
  const name = (document.getElementById('cookieName') as HTMLInputElement).value;

  await api.deleteCookie(name);
  document.getElementById('cookie-result')!.innerHTML =
    `<span class="success">✓ Deleted cookie ${esc(name)}</span>`;
};

// KV Store test functions
(window as any).testSetValue = async () => {
  const key = (document.getElementById('key') as HTMLInputElement).value;
  const value = (document.getElementById('value') as HTMLInputElement).value;
  
  const result = await api.setValue(key, value);
  
  document.getElementById('kv-result')!.innerHTML =
    `<span class="success">✓ Set ${esc(key)} = ${esc(value)}</span>`;
};

(window as any).testGetValue = async () => {
  const key = (document.getElementById('key') as HTMLInputElement).value;

  const value = await api.getValue(key);

  document.getElementById('kv-result')!.innerHTML =
    value ? `<span class="success">✓ Got value: ${esc(value)}</span>`
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
      `<span class="error">✗ Tests failed: ${esc(error.message)}</span>`;
  }
};

console.log('Blocks Demo loaded - using direct backend imports with Proxy');

// ============================================================================
// File Storage
// ============================================================================

function setFileResult(text: string, type: 'success' | 'error' | 'info') {
  const el = document.getElementById('file-result')!;
  if (type === 'info') {
    el.textContent = text;
  } else {
    el.innerHTML = `<span class="${esc(type)}">${esc(text)}</span>`;
  }
}

(window as any).uploadFile = async () => {
  const pathInput = document.getElementById('filePath') as HTMLInputElement;
  const fileInput = document.getElementById('fileInput') as HTMLInputElement;
  const file = fileInput.files?.[0];

  if (!pathInput.value) { setFileResult('Please enter a file path', 'error'); return; }
  if (!file) { setFileResult('Please choose a file', 'error'); return; }

  try {
    setFileResult('Uploading...', 'info');
    const handle = await api.getUploadHandle(pathInput.value, file.type || undefined);
    await handle.upload(file);
    setFileResult(`✓ Uploaded ${file.name} (${file.size} bytes) to ${pathInput.value}`, 'success');
  } catch (error: any) {
    setFileResult(`✗ Upload failed: ${error.message}`, 'error');
  }
};

(window as any).downloadFile = async () => {
  const pathInput = document.getElementById('filePath') as HTMLInputElement;
  const previewDiv = document.getElementById('file-preview')!;

  if (!pathInput.value) { setFileResult('Please enter a file path', 'error'); return; }

  try {
    setFileResult('Downloading...', 'info');
    previewDiv.textContent = '';
    const handle = await api.getDownloadHandle(pathInput.value);
    const blob = await handle.download();

    const path = pathInput.value.toLowerCase();
    if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.gif') || path.endsWith('.webp')) {
      const url = URL.createObjectURL(blob);
      const img = document.createElement('img');
      img.onload = () => URL.revokeObjectURL(url);
      img.style.cssText = 'max-width: 100%; max-height: 300px;';
      img.alt = 'Downloaded image';
      img.src = url;
      previewDiv.appendChild(img);
      setFileResult(`✓ Downloaded image (${blob.size} bytes)`, 'success');
    } else if (path.endsWith('.txt') || path.endsWith('.json') || path.endsWith('.md') || path.endsWith('.csv')) {
      const text = await blob.text();
      const pre = document.createElement('pre');
      pre.style.cssText = 'background: #f9f9f9; padding: 10px; border-radius: 4px; overflow: auto; max-height: 200px;';
      pre.textContent = text;
      previewDiv.appendChild(pre);
      setFileResult(`✓ Downloaded text file (${blob.size} bytes)`, 'success');
    } else {
      setFileResult(`✓ Downloaded ${blob.size} bytes`, 'success');
    }
  } catch (error: any) {
    setFileResult(`✗ Download failed: ${error.message}`, 'error');
    previewDiv.textContent = '';
  }
};

// ============================================================================
// Realtime Cursors
// ============================================================================

const userId = crypto.randomUUID().slice(0, 8);
const COLORS = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7', '#a29bfe', '#fd79a8', '#00b894'];

function secureRandomIndex(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 256) {
    throw new Error('maxExclusive must be an integer between 1 and 256');
  }
  const limit = 256 - (256 % maxExclusive);
  const bytes = new Uint8Array(1);
  while (true) {
    crypto.getRandomValues(bytes);
    const value = bytes[0];
    if (value < limit) {
      return value % maxExclusive;
    }
  }
}

const myColor = COLORS[secureRandomIndex(COLORS.length)];

const realtimeArea = document.getElementById('realtime-area')!;
const cursors = new Map<string, HTMLElement>();
const statusEl = document.getElementById('realtime-status')!;

// A peer's colour must be a #rrggbb hex value: it lands in a `style` attribute,
// where escaping alone wouldn't stop it adding CSS declarations.
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const FALLBACK_COLOR = '#888888';

function cursorSvg(color: string): string {
  return `<svg viewBox="0 0 24 24" fill="${esc(color)}" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 3l14 8-6.5 1.5L11 19z" stroke="#000" stroke-width="1"/>
  </svg>`;
}

function getOrCreateCursor(id: string, peerColor: string): HTMLElement {
  const color = HEX_COLOR.test(peerColor) ? peerColor : FALLBACK_COLOR;
  let el = cursors.get(id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'cursor-dot';
    el.innerHTML = `${cursorSvg(color)}<span class="label" style="background:${esc(color)};color:#000">${esc(id)}</span>`;
    realtimeArea.appendChild(el);
    cursors.set(id, el);
  }
  return el;
}

const lastSeen = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [id, time] of lastSeen) {
    if (now - time > 3000) {
      cursors.get(id)?.remove();
      cursors.delete(id);
      lastSeen.delete(id);
    }
  }
}, 1000);

try {
  const channel = await api.getCursorChannel();

  channel.subscribe((msg: { userId: string; x: number; y: number; color: string }) => {
    if (msg.userId === userId) return;
    const el = getOrCreateCursor(msg.userId, msg.color);
    el.style.left = `${msg.x}px`;
    el.style.top = `${msg.y}px`;
    lastSeen.set(msg.userId, Date.now());
  });

  statusEl.textContent = `Connected as ${userId}`;

  let lastPublish = 0;
  realtimeArea.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastPublish < 50) return;
    lastPublish = now;
    const rect = realtimeArea.getBoundingClientRect();
    api.publishCursor({
      userId,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      color: myColor,
    });
  });
} catch (e: any) {
  statusEl.textContent = `Realtime error: ${e.message}`;
  statusEl.style.color = 'red';
}
