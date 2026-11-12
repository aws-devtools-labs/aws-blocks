import { api, authBasicApi, authCognitoApi, oidcAuthApi } from 'aws-blocks';
import { Authenticator, onAuthChange } from '@aws-blocks/bb-auth/ui';

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let currentUser: { username: string } | null = null;
let currentSort: 'priority' | 'createdAt' | undefined = undefined;

// ============================================================================
// Auth — three `Auth` blocks; the email + password one drives the todo list
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  // Email + password (`auth-basic`)
  const basicContainer = document.getElementById('basic-auth-container');
  if (basicContainer) {
    basicContainer.appendChild(Authenticator(authBasicApi));
  }
  onAuthChange(authBasicApi, async (user) => {
    currentUser = user;
    await refreshTodos();
  });

  // Cognito-style configuration (`auth-cognito`)
  const cognitoContainer = document.getElementById('cognito-auth-container');
  if (cognitoContainer) {
    cognitoContainer.appendChild(Authenticator(authCognitoApi));
  }

  // OIDC through the stub IdP (`auth-oidc`). The block's `signIn:google`
  // action carries the sign-in URL, so the Authenticator renders a plain
  // "Sign in with google" button that starts the redirect flow.
  const oidcContainer = document.getElementById('oidc-auth-container');
  if (oidcContainer) {
    oidcContainer.appendChild(Authenticator(oidcAuthApi));
  }
});

// ============================================================================
// Todos
// ============================================================================

async function refreshTodos() {
  const todoList = document.getElementById('todo-list');
  const errorDiv = document.getElementById('todo-error');
  if (!todoList) return;
  if (errorDiv) { errorDiv.style.display = 'none'; errorDiv.textContent = ''; }

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

    todoList.innerHTML = todos.map(todo => `
      <div class="todo-item">
        <input type="checkbox" ${todo.completed ? 'checked' : ''}
               onchange="toggleTodo('${esc(todo.todoId)}', this.checked)">
        <input type="text" class="todo-title" value="${esc(todo.title)}"
               onblur="updateTitle('${esc(todo.todoId)}', this.value)"
               onkeypress="if(event.key==='Enter') this.blur()">
        <select onchange="changePriority('${esc(todo.todoId)}', parseInt(this.value))" style="margin-left: auto;">
          <option value="1" ${todo.priority === 1 ? 'selected' : ''}>High</option>
          <option value="2" ${todo.priority === 2 ? 'selected' : ''}>Medium</option>
          <option value="3" ${todo.priority === 3 ? 'selected' : ''}>Low</option>
        </select>
        <button onclick="deleteTodo('${esc(todo.todoId)}')">Delete</button>
      </div>
    `).join('');
  } catch (error: any) {
    if (errorDiv) { errorDiv.style.display = 'block'; errorDiv.className = 'result error'; errorDiv.textContent = error.message; }
  }
}

(window as any).addTodo = async () => {
  const input = document.getElementById('todo-input') as HTMLInputElement;
  const prioritySelect = document.getElementById('todo-priority') as HTMLSelectElement;
  const title = input.value.trim();
  if (!title) return;

  try {
    await api.createTodo(title, parseInt(prioritySelect.value));
    input.value = '';
    await refreshTodos();
  } catch (error: any) {
    const errorDiv = document.getElementById('todo-error');
    if (errorDiv) { errorDiv.style.display = 'block'; errorDiv.className = 'result error'; errorDiv.textContent = error.message; }
  }
};

(window as any).changeSort = async (sortBy: string) => {
  currentSort = sortBy === 'none' ? undefined : sortBy as 'priority' | 'createdAt';
  await refreshTodos();
};

(window as any).toggleTodo = async (todoId: string, completed: boolean) => {
  try {
    await api.updateTodo(todoId, { completed });
    await refreshTodos();
  } catch (error: any) {
    const errorDiv = document.getElementById('todo-error');
    if (errorDiv) { errorDiv.style.display = 'block'; errorDiv.className = 'result error'; errorDiv.textContent = error.message; }
  }
};

(window as any).changePriority = async (todoId: string, priority: number) => {
  try {
    await api.updateTodo(todoId, { priority });
    await refreshTodos();
  } catch (error: any) {
    const errorDiv = document.getElementById('todo-error');
    if (errorDiv) { errorDiv.style.display = 'block'; errorDiv.className = 'result error'; errorDiv.textContent = error.message; }
  }
};

(window as any).updateTitle = async (todoId: string, title: string) => {
  const trimmed = title.trim();
  if (!trimmed) { await refreshTodos(); return; }
  try {
    await api.updateTodo(todoId, { title: trimmed });
    await refreshTodos();
  } catch (error: any) {
    const errorDiv = document.getElementById('todo-error');
    if (errorDiv) { errorDiv.style.display = 'block'; errorDiv.className = 'result error'; errorDiv.textContent = error.message; }
  }
};

(window as any).deleteTodo = async (todoId: string) => {
  try {
    await api.deleteTodo(todoId);
    await refreshTodos();
  } catch (error: any) {
    const errorDiv = document.getElementById('todo-error');
    if (errorDiv) { errorDiv.style.display = 'block'; errorDiv.className = 'result error'; errorDiv.textContent = error.message; }
  }
};

// ============================================================================
// Realtime Cursors
// ============================================================================

const myUserId = crypto.randomUUID().slice(0, 8);
const COLORS = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7', '#a29bfe', '#fd79a8', '#00b894'];
const myColor = COLORS[Math.floor(Math.random() * COLORS.length)];

const cursorArea = document.getElementById('cursor-area')!;
const cursorStatus = document.getElementById('cursor-status')!;
const cursorElements = new Map<string, HTMLElement>();
const lastSeen = new Map<string, number>();

function cursorSvg(color: string): string {
  return `<svg viewBox="0 0 24 24" fill="${esc(color)}" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 3l14 8-6.5 1.5L11 19z" stroke="#000" stroke-width="1"/>
  </svg>`;
}

function getOrCreateCursor(id: string, color: string): HTMLElement {
  let el = cursorElements.get(id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'cursor-dot';
    el.innerHTML = `${cursorSvg(color)}<span class="label" style="background:${esc(color)};color:#000">${esc(id)}</span>`;
    cursorArea.appendChild(el);
    cursorElements.set(id, el);
  }
  return el;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, time] of lastSeen) {
    if (now - time > 3000) {
      cursorElements.get(id)?.remove();
      cursorElements.delete(id);
      lastSeen.delete(id);
    }
  }
}, 1000);

(async () => {
  try {
    const channel = await api.realtimeGetChannel();

    channel.subscribe((msg: { userId: string; x: number; y: number; color: string }) => {
      if (msg.userId === myUserId) return;
      const el = getOrCreateCursor(msg.userId, msg.color);
      el.style.left = `${msg.x}px`;
      el.style.top = `${msg.y}px`;
      lastSeen.set(msg.userId, Date.now());
    });

    cursorStatus.textContent = `Connected as ${myUserId}`;

    let lastPublish = 0;
    cursorArea.addEventListener('mousemove', (e) => {
      const now = Date.now();
      if (now - lastPublish < 50) return;
      lastPublish = now;
      const rect = cursorArea.getBoundingClientRect();
      api.realtimePublish({
        userId: myUserId,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        color: myColor,
      });
    });
  } catch (e: any) {
    cursorStatus.textContent = `Realtime error: ${e.message}`;
    cursorStatus.style.color = 'red';
  }
})();

// ============================================================================
// File Storage
// ============================================================================

function setFileResult(text: string, type: 'success' | 'error' | 'info') {
  const el = document.getElementById('file-result')!;
  el.className = `result ${type === 'info' ? '' : type}`;
  el.textContent = text;
}

(window as any).uploadFile = async () => {
  const pathInput = document.getElementById('file-path') as HTMLInputElement;
  const fileInput = document.getElementById('file-input') as HTMLInputElement;
  const file = fileInput.files?.[0];

  if (!pathInput.value) { setFileResult('Please enter a file path', 'error'); return; }
  if (!file) { setFileResult('Please choose a file', 'error'); return; }

  try {
    setFileResult('Uploading...', 'info');
    const handle = await api.fileCreateUploadHandle(pathInput.value, file.type || undefined);
    await handle.upload(file);
    setFileResult(`Uploaded ${file.name} (${file.size} bytes) to ${pathInput.value}`, 'success');
  } catch (error: any) {
    setFileResult(`Upload failed: ${error.message}`, 'error');
  }
};

(window as any).downloadFile = async () => {
  const pathInput = document.getElementById('file-path') as HTMLInputElement;
  const previewDiv = document.getElementById('file-preview')!;

  if (!pathInput.value) { setFileResult('Please enter a file path', 'error'); return; }

  try {
    setFileResult('Downloading...', 'info');
    previewDiv.textContent = '';
    const handle = await api.fileGetHandle(pathInput.value);
    const blob = await handle.download();

    const path = pathInput.value.toLowerCase();
    if (/\.(png|jpe?g|gif|webp)$/.test(path)) {
      const url = URL.createObjectURL(blob);
      const img = document.createElement('img');
      img.onload = () => URL.revokeObjectURL(url);
      img.style.cssText = 'max-width: 100%; max-height: 300px;';
      img.alt = 'Downloaded image';
      img.src = url;
      previewDiv.appendChild(img);
      setFileResult(`Downloaded image (${blob.size} bytes)`, 'success');
    } else if (/\.(txt|json|md|csv)$/.test(path)) {
      const text = await blob.text();
      const pre = document.createElement('pre');
      pre.style.cssText = 'background: #f9f9f9; padding: 10px; border-radius: 4px; overflow: auto; max-height: 200px;';
      pre.textContent = text;
      previewDiv.appendChild(pre);
      setFileResult(`Downloaded text file (${blob.size} bytes)`, 'success');
    } else {
      setFileResult(`Downloaded ${blob.size} bytes`, 'success');
    }
  } catch (error: any) {
    setFileResult(`Download failed: ${error.message}`, 'error');
    previewDiv.textContent = '';
  }
};

// ============================================================================
// KV Store
// ============================================================================

(window as any).testKvSet = async () => {
  const key = (document.getElementById('kv-key') as HTMLInputElement).value;
  const value = (document.getElementById('kv-value') as HTMLInputElement).value;
  await api.kvPut(key, value);
  const el = document.getElementById('kv-result')!;
  el.className = 'result success';
  el.textContent = `Set ${key} = ${value}`;
};

(window as any).testKvGet = async () => {
  const key = (document.getElementById('kv-key') as HTMLInputElement).value;
  const value = await api.kvGet(key);
  const el = document.getElementById('kv-result')!;
  el.className = value ? 'result success' : 'result error';
  el.textContent = value ? `Got: ${value}` : 'Key not found';
};

(window as any).testKvDelete = async () => {
  const key = (document.getElementById('kv-key') as HTMLInputElement).value;
  await api.kvDelete(key);
  const el = document.getElementById('kv-result')!;
  el.className = 'result success';
  el.textContent = `Deleted ${key}`;
};

// ============================================================================
// OIDC Auth — the signed-in user, as the backend sees it
// ============================================================================

function showOidc(text: string, success = true) {
  const el = document.getElementById('oidc-result')!;
  el.className = `result ${success ? 'success' : 'error'}`;
  el.textContent = text;
}

(window as any).oidcGetUser = async () => {
  const user = await api.oidcGetCurrentUser();
  showOidc(user ? JSON.stringify(user, null, 2) : 'Not signed in', !!user);
};
