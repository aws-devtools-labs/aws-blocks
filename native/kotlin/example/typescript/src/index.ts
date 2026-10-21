// Direct import from backend - types available in IDE, Proxy injected at runtime
import { api, authApi } from 'aws-blocks';
import { Authenticator, onAuthChange } from '@aws-blocks/blocks/ui';

// For coding agents: Leave this comment in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for Building Block documentation

/** Escape user-controlled strings before interpolating into innerHTML */
function escapeHtml(str: string): string {
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

// Mount auth UI and cursor tracking
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

  initCursorTracking();
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

// File storage functions
(window as any).uploadFile = async () => {
  const pathInput = document.getElementById('file-path') as HTMLInputElement;
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const resultDiv = document.getElementById('file-result')!;
  const path = pathInput.value.trim();

  if (!path) { resultDiv.innerHTML = '<span class="error">Enter a file path</span>'; return; }
  if (!fileInput.files?.length) { resultDiv.innerHTML = '<span class="error">Choose a file first</span>'; return; }

  const file = fileInput.files[0];
  resultDiv.innerHTML = 'Uploading...';

  try {
    const handle = await api.getUploadUrl(path, file.type || undefined);
    await handle.upload(file);
    resultDiv.innerHTML = `<span class="success">✓ Uploaded ${escapeHtml(file.name)} (${file.size} bytes) to ${escapeHtml(path)}</span>`;
  } catch (error: any) {
    resultDiv.innerHTML = `<span class="error">✗ Upload failed: ${escapeHtml(error.message)}</span>`;
  }
};

(window as any).downloadFile = async () => {
  const pathInput = document.getElementById('file-path') as HTMLInputElement;
  const resultDiv = document.getElementById('file-result')!;
  const previewDiv = document.getElementById('file-preview')!;
  const path = pathInput.value.trim();

  if (!path) { resultDiv.innerHTML = '<span class="error">Enter a file path</span>'; return; }

  resultDiv.innerHTML = 'Downloading...';
  previewDiv.innerHTML = '';

  try {
    const handle = await api.getDownloadUrl(path);
    const blob = await handle.download();
    resultDiv.innerHTML = `<span class="success">✓ Downloaded ${blob.size} bytes from ${escapeHtml(path)}</span>`;

    const lower = path.toLowerCase();
    if (lower.match(/\.(png|jpg|jpeg|gif|webp)$/)) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(blob);
      img.style.maxWidth = '100%';
      img.style.maxHeight = '200px';
      previewDiv.appendChild(img);
    } else if (lower.match(/\.(txt|json|md|csv)$/)) {
      const text = await blob.text();
      const pre = document.createElement('pre');
      pre.textContent = text;
      pre.style.maxHeight = '200px';
      pre.style.overflow = 'auto';
      previewDiv.appendChild(pre);
    }
  } catch (error: any) {
    resultDiv.innerHTML = `<span class="error">✗ Download failed: ${escapeHtml(error.message)}</span>`;
  }
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

// ── Realtime Cursor Tracking ─────────────────────────────────────

const COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#F9CA24', '#6C5CE7', '#A29BFE', '#FD79A8', '#00B894'];
const userId = Math.random().toString(36).substring(2, 8);
const myColor = COLORS[Math.floor(Math.random() * COLORS.length)];

function cursorSvg(color: string): string {
  return `<svg viewBox="0 0 24 24" fill="${color}" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 3l14 8-6.5 1.5L11 19z" stroke="#000" stroke-width="1"/>
  </svg>`;
}

function initCursorTracking() {
  const cursorArea = document.getElementById('cursor-area')!;
  const cursorStatus = document.getElementById('cursor-status')!;
  const remoteCursors = new Map<string, HTMLElement>();
  const lastSeen = new Map<string, number>();

  function getOrCreateCursor(id: string, color: string): HTMLElement {
    let el = remoteCursors.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'cursor-dot';
      el.innerHTML = `${cursorSvg(escapeHtml(color))}<span class="label" style="background:${escapeHtml(color)};color:#fff">${escapeHtml(id)}</span>`;
      cursorArea.appendChild(el);
      remoteCursors.set(id, el);
    }
    return el;
  }

  // Remove stale cursors every 1s
  setInterval(() => {
    const now = Date.now();
    for (const [id, time] of lastSeen) {
      if (now - time > 3000) {
        remoteCursors.get(id)?.remove();
        remoteCursors.delete(id);
        lastSeen.delete(id);
      }
    }
  }, 1000);

  // Connect to cursor channel
  api.getCursorChannel().then((channel) => {
    channel.subscribe((msg: { userId: string; x: number; y: number; color: string }) => {
      if (msg.userId === userId) return;
      const el = getOrCreateCursor(msg.userId, msg.color);
      el.style.left = `${msg.x}px`;
      el.style.top = `${msg.y}px`;
      lastSeen.set(msg.userId, Date.now());
    });

    cursorStatus.textContent = `Connected as ${userId}`;

    let lastPublish = 0;
    cursorArea.addEventListener('mousemove', (e) => {
      const now = Date.now();
      if (now - lastPublish < 50) return;
      lastPublish = now;
      const rect = cursorArea.getBoundingClientRect();
      api.publishCursor({
        userId,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        color: myColor,
      });
    });
  }).catch((err: any) => {
    cursorStatus.textContent = `Cursor channel error: ${err.message}`;
  });
}

console.log('Blocks Demo loaded - using direct backend imports with Proxy');
