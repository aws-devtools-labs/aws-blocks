// Direct import from backend - types available in IDE, Proxy injected at runtime
import { api, authApi } from 'aws-blocks';
import { Authenticator, onAuthChange, injectTheme } from '@aws-blocks/blocks/ui';

injectTheme();


// For coding agents: Leave this comment in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for Building Block documentation

let currentUser: { username: string } | null = null;
let currentSort: 'priority' | 'title' | 'createdAt' | undefined ;

// ── Safe DOM helpers ────────────────────────────────────────────────────
// Every rendering path in this file goes through these; never use .innerHTML
// on user-supplied or server-supplied strings directly.

function clear(el: HTMLElement) {
  el.replaceChildren();
}

function showMessage(el: HTMLElement, text: string, cls?: 'success' | 'error') {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  el.replaceChildren(span);
}

function showError(el: HTMLElement, text: string) {
  showMessage(el, text, 'error');
}

// ── Todos ───────────────────────────────────────────────────────────────

type Todo = { todoId: string; title: string; completed: boolean; priority: number };

function renderTodo(todo: Todo): HTMLElement {
  const row = document.createElement('div');
  row.className = 'todo-item';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = todo.completed;
  checkbox.addEventListener('change', () => toggleTodo(todo.todoId, checkbox.checked));
  row.appendChild(checkbox);

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'todo-title';
  titleInput.value = todo.title;
  titleInput.addEventListener('blur', () => updateTitle(todo.todoId, titleInput.value));
  titleInput.addEventListener('keypress', (ev) => {
    if (ev.key === 'Enter') titleInput.blur();
  });
  row.appendChild(titleInput);

  const prioritySelect = document.createElement('select');
  prioritySelect.style.marginLeft = 'auto';
  for (const [value, label] of [[1, '🔴 High'], [2, '🟡 Medium'], [3, '🟢 Low']] as const) {
    const opt = document.createElement('option');
    opt.value = String(value);
    opt.textContent = label;
    if (todo.priority === value) opt.selected = true;
    prioritySelect.appendChild(opt);
  }
  prioritySelect.addEventListener('change', () => changePriority(todo.todoId, parseInt(prioritySelect.value, 10)));
  row.appendChild(prioritySelect);

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => deleteTodo(todo.todoId));
  row.appendChild(deleteBtn);

  return row;
}

async function refreshTodos() {
  const todoList = document.getElementById('todo-list');
  const errorDiv = document.getElementById('todo-error');
  if (!todoList) return;
  if (errorDiv) clear(errorDiv);

  // Rely on the server to decide "are you signed in?" — `listTodos` goes through
  // `auth.requireAuth` and throws 401 otherwise. The frontend `currentUser`
  // cache races with the state-machine transition, so checking it here can
  // swallow valid sign-in states.
  try {
    const todos: Todo[] = await api.listTodos(currentSort);
    if (todos.length === 0) {
      const p = document.createElement('p');
      p.textContent = 'No todos yet. Add one above!';
      todoList.replaceChildren(p);
      return;
    }
    todoList.replaceChildren(...todos.map(renderTodo));
  } catch (error: any) {
    if (error?.name === 'NotAuthenticatedException') {
      const p = document.createElement('p');
      p.textContent = 'Please sign in to view todos';
      todoList.replaceChildren(p);
      return;
    }
    if (errorDiv) showError(errorDiv, error.message);
  }
}

async function addTodo() {
  const input = document.getElementById('todo-input') as HTMLInputElement;
  const prioritySelect = document.getElementById('todo-priority') as HTMLSelectElement;
  const errorDiv = document.getElementById('todo-error');
  const title = input.value.trim();
  if (!title) return;
  if (errorDiv) clear(errorDiv);

  try {
    await api.createTodo(title, parseInt(prioritySelect.value, 10));
    input.value = '';
    await refreshTodos();
  } catch (error: any) {
    if (errorDiv) showError(errorDiv, error.message);
  }
}

async function changeSort(sortBy: string) {
  currentSort = sortBy === 'none' ? undefined : sortBy as 'priority' | 'title' | 'createdAt';
  await refreshTodos();
}

async function toggleTodo(todoId: string, completed: boolean) {
  await api.updateTodo(todoId, { completed });
  await refreshTodos();
}

async function changePriority(todoId: string, priority: number) {
  await api.updateTodo(todoId, { priority });
  await refreshTodos();
}

async function updateTitle(todoId: string, title: string) {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    await refreshTodos();
    return;
  }
  await api.updateTodo(todoId, { title: trimmedTitle });
  await refreshTodos();
}

async function deleteTodo(todoId: string) {
  await api.deleteTodo(todoId);
  await refreshTodos();
}

// ── Auth UI ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const authContainer = document.getElementById('auth-container');
  if (authContainer) {
    authContainer.appendChild(Authenticator(authApi));
  }

  onAuthChange(authApi, async (user) => {
    currentUser = user;
    const authStatus = document.getElementById('auth-status');
    if (authStatus) {
      authStatus.textContent = user ? `Logged in as: ${user.username}` : 'Not logged in';
    }
    document.body.classList.toggle('signed-in', !!user);
    await refreshTodos();
    if (user) {
      await refreshProfile();
    }
  });

  bindUi();
});

// ── Panels ──────────────────────────────────────────────────────────────

function bindUi() {
  document.getElementById('todo-add-btn')?.addEventListener('click', addTodo);
  document.getElementById('todo-input')?.addEventListener('keypress', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') addTodo();
  });
  document.getElementById('todo-sort')?.addEventListener('change', (e) =>
    changeSort((e.target as HTMLSelectElement).value),
  );
  document.getElementById('last-code-btn')?.addEventListener('click', refreshLastCode);
  document.getElementById('editors-only-btn')?.addEventListener('click', testEditorsOnly);
  document.getElementById('readers-only-btn')?.addEventListener('click', testReadersOnly);
  document.getElementById('kv-set-btn')?.addEventListener('click', testSetValue);
  document.getElementById('kv-get-btn')?.addEventListener('click', testGetValue);

  // Profile
  document.getElementById('profile-refresh-btn')?.addEventListener('click', refreshProfile);
  document.getElementById('profile-update-department-btn')?.addEventListener('click', updateDepartment);
  document.getElementById('profile-update-email-btn')?.addEventListener('click', updateEmail);
  document.getElementById('profile-confirm-email-btn')?.addEventListener('click', confirmEmailAttr);
  document.getElementById('profile-change-password-btn')?.addEventListener('click', changePassword);
  document.getElementById('profile-global-signout-btn')?.addEventListener('click', globalSignOut);

  // Devices
  document.getElementById('devices-refresh-btn')?.addEventListener('click', listDevices);
  document.getElementById('devices-forget-btn')?.addEventListener('click', forgetCurrentDevice);
}

async function refreshLastCode() {
  const out = document.getElementById('last-code-result')!;
  const last = await api.getLastCode();
  if (!last) {
    out.textContent = '(none)';
    return;
  }
  // Assemble safely: attacker-controlled `username`/`code` must not be
  // interpreted as markup.
  clear(out);
  const span = document.createElement('span');
  span.appendChild(document.createTextNode(`${last.purpose} `));
  const user = document.createElement('b');
  user.textContent = last.username;
  span.appendChild(user);
  span.appendChild(document.createTextNode(': '));
  const code = document.createElement('code');
  code.textContent = last.code;
  span.appendChild(code);
  out.replaceChildren(span);
}

async function testEditorsOnly() {
  const out = document.getElementById('role-result')!;
  try {
    const r = await api.editorsOnly();
    showMessage(out, r.message, 'success');
  } catch (e: any) {
    showError(out, e.message);
  }
}

async function testReadersOnly() {
  const out = document.getElementById('role-result')!;
  try {
    const r = await api.readersOnly();
    showMessage(out, r.message, 'success');
  } catch (e: any) {
    showError(out, e.message);
  }
}

async function testSetValue() {
  const key = (document.getElementById('key') as HTMLInputElement).value;
  const value = (document.getElementById('value') as HTMLInputElement).value;
  await api.setValue(key, value);
  showMessage(document.getElementById('kv-result')!, `✓ Set ${key} = ${value}`, 'success');
}

async function testGetValue() {
  const key = (document.getElementById('key') as HTMLInputElement).value;
  const value = await api.getValue(key);
  const out = document.getElementById('kv-result')!;
  if (value) showMessage(out, `✓ Got value: ${value}`, 'success');
  else showError(out, '✗ Key not found');
}

// ── Profile ────────────────────────────────────────────────────────────

function renderAttrs(target: HTMLElement, attrs: Record<string, string>) {
  clear(target);
  const entries = Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    target.textContent = '(no attributes)';
    return;
  }
  const list = document.createElement('ul');
  list.style.margin = '0';
  list.style.paddingLeft = '20px';
  for (const [k, v] of entries) {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = `${k}: ${v}`;
    li.appendChild(code);
    list.appendChild(li);
  }
  target.appendChild(list);
}

async function refreshProfile() {
  const out = document.getElementById('profile-attrs');
  if (!out) return;
  try {
    const attrs = await api.fetchUserAttributes();
    renderAttrs(out, attrs);
    // Prefill the inputs with current values so the user sees what they're editing.
    // Cognito always reads custom attrs back with the `custom:` prefix, so
    // that's the only key `fetchUserAttributes` returns — the typed API
    // reflects this and we stick to the prefixed form.
    const deptInput = document.getElementById('profile-department') as HTMLInputElement | null;
    if (deptInput) deptInput.value = attrs['custom:department'] ?? '';
    const emailInput = document.getElementById('profile-email') as HTMLInputElement | null;
    if (emailInput) emailInput.value = attrs.email ?? '';
  } catch (e: any) {
    showError(out, e.message);
  }
}

async function updateDepartment() {
  const out = document.getElementById('profile-result')!;
  const dept = (document.getElementById('profile-department') as HTMLInputElement).value;
  try {
    const r = await api.updateDepartment(dept);
    showMessage(out, `department update: ${JSON.stringify(r)}`, 'success');
    await refreshProfile();
  } catch (e: any) {
    showError(out, e.message);
  }
}

async function updateEmail() {
  const out = document.getElementById('profile-result')!;
  const email = (document.getElementById('profile-email') as HTMLInputElement).value;
  try {
    const r = await api.updateEmail(email);
    const emailOutcome = r?.email;
    if (emailOutcome && !emailOutcome.isUpdated && emailOutcome.nextStep?.name === 'CONFIRM_ATTRIBUTE_WITH_CODE') {
      const row = document.getElementById('profile-confirm-email-row');
      if (row) row.style.display = 'flex';
      showMessage(out, 'Verification code sent to the new email. Check the one-liner at the top, then confirm below.', 'success');
    } else {
      showMessage(out, `email update: ${JSON.stringify(r)}`, 'success');
    }
    await refreshProfile();
  } catch (e: any) {
    showError(out, e.message);
  }
}

async function confirmEmailAttr() {
  const out = document.getElementById('profile-result')!;
  const code = (document.getElementById('profile-email-code') as HTMLInputElement).value;
  try {
    await api.confirmAttribute('email', code);
    showMessage(out, 'Email confirmed.', 'success');
    const row = document.getElementById('profile-confirm-email-row');
    if (row) row.style.display = 'none';
    await refreshProfile();
  } catch (e: any) {
    showError(out, e.message);
  }
}

async function changePassword() {
  const out = document.getElementById('profile-result')!;
  const oldP = (document.getElementById('profile-old-password') as HTMLInputElement).value;
  const newP = (document.getElementById('profile-new-password') as HTMLInputElement).value;
  try {
    await api.changePassword(oldP, newP);
    (document.getElementById('profile-old-password') as HTMLInputElement).value = '';
    (document.getElementById('profile-new-password') as HTMLInputElement).value = '';
    showMessage(out, 'Password changed.', 'success');
  } catch (e: any) {
    showError(out, e.message);
  }
}

async function globalSignOut() {
  const out = document.getElementById('profile-result')!;
  try {
    await api.signOutEverywhere();
    showMessage(out, 'Global sign-out: refresh tokens invalidated. Reloading…', 'success');
    // `signOutEverywhere` invalidates the session cookie out-of-band —
    // it doesn't flow through the Authenticator's state machine, so
    // the component's cached render stays on the signed-in view. A
    // full reload is the simplest correct UX for a destructive action
    // and also wipes any in-memory session state the app may have.
    window.location.reload();
  } catch (e: any) {
    showError(out, e.message);
  }
}

// ── Devices ────────────────────────────────────────────────────────────

async function listDevices() {
  const out = document.getElementById('devices-result')!;
  try {
    const devices = await api.listDevices();
    clear(out);
    if (devices.length === 0) {
      out.textContent = '(no devices tracked)';
      return;
    }
    const ul = document.createElement('ul');
    ul.style.margin = '0';
    ul.style.paddingLeft = '20px';
    for (const d of devices) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = JSON.stringify(d);
      li.appendChild(code);
      ul.appendChild(li);
    }
    out.appendChild(ul);
  } catch (e: any) {
    showError(out, e.message);
  }
}

async function forgetCurrentDevice() {
  const out = document.getElementById('devices-result')!;
  try {
    await api.forgetCurrentDevice();
    showMessage(out, 'Device forgotten.', 'success');
  } catch (e: any) {
    showError(out, e.message);
  }
}

console.log('AWS Blocks Auth-Cognito loaded');
