/**
 * Frontend — src/index.ts
 *
 * Real-time todo app. Uses lit-html for declarative rendering with @event binding.
 * Imports the typed backend API via `aws-blocks` (auto-generated proxy).
 */
import { api, authApi } from 'aws-blocks';
import { AccountMenuBar, AuthenticatedContent } from '@aws-blocks/blocks/ui';
import { html, render } from 'lit-html';

// ─── Auth ────────────────────────────────────────────────────────────────────
// Show Account Menu bar that pops open authenticator when Sign In is clicked.
const menuBarEl = document.getElementById('menu-bar')!;
menuBarEl.appendChild(AccountMenuBar(authApi));

// ─── App (shown when authenticated, fallback when not) ──────────────────────
const signInMessage = document.createElement('p');
signInMessage.textContent = 'Sign in to get started.';

document.getElementById('app')!.appendChild(
  AuthenticatedContent(authApi, (user) => {
    const container = document.createElement('div');
    type Todo = { todoId: string; title: string; completed: boolean; priority: number };
    let todos: Todo[] = [];
    let sortBy: 'priority' | 'title' | undefined;

    async function load() {
      todos = await api.listTodos(sortBy);
      redraw();
    }

    function redraw() {
      render(html`
        <h2>Todos</h2>
        <div style="margin-bottom:12px;display:flex;gap:4px;align-items:center;flex-wrap:wrap">
          <input id="new-todo" type="text" placeholder="What needs to be done?" style="flex:1;min-width:200px" @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') addTodo();
          }} />
          <select id="new-priority">
            <option value="1">🔴 High</option>
            <option value="2" selected>🟡 Medium</option>
            <option value="3">🟢 Low</option>
          </select>
          <button @click=${addTodo}>Add</button>
        </div>
        <div style="margin-bottom:12px;font-size:0.85em;color:#666">
          Sort:
          <button @click=${() => setSort(undefined)} style="font-weight:${!sortBy ? 'bold' : 'normal'}">Default</button>
          <button @click=${() => setSort('priority')} style="font-weight:${sortBy === 'priority' ? 'bold' : 'normal'}">Priority</button>
          <button @click=${() => setSort('title')} style="font-weight:${sortBy === 'title' ? 'bold' : 'normal'}">Title</button>
        </div>
        <ul>
          ${todos.map(t => html`
            <li style="margin:10px 0;display:flex;align-items:center;gap:8px;${t.completed ? 'text-decoration:line-through;opacity:0.5' : ''}">
              <input type="checkbox" .checked=${t.completed} @change=${() => toggle(t.todoId)} />
              <span style="flex:1">${t.title}</span>
              <select .value=${String(t.priority)} @change=${(e: Event) => setPriority(t.todoId, parseInt((e.target as HTMLSelectElement).value))}>
                <option value="1">🔴 High</option>
                <option value="2">🟡 Medium</option>
                <option value="3">🟢 Low</option>
              </select>
              <button @click=${() => remove(t.todoId)}>×</button>
            </li>
          `)}
        </ul>
        <p style="color:#888;font-size:0.85em">${todos.filter(t => !t.completed).length} remaining</p>
      `, container);
    }

    async function addTodo() {
      const input = container.querySelector('#new-todo') as HTMLInputElement;
      const select = container.querySelector('#new-priority') as HTMLSelectElement;
      const title = input.value.trim();
      if (!title) return;
      await api.createTodo(title, parseInt(select.value));
      input.value = '';
      await load();
    }

    function setSort(s: 'priority' | 'title' | undefined) {
      sortBy = s;
      load();
    }

    async function toggle(todoId: string) {
      try { await api.toggleTodo(todoId); } catch { /* conflict — just reload */ }
      await load();
    }

    async function setPriority(todoId: string, priority: number) {
      try { await api.updatePriority(todoId, priority); } catch { /* conflict */ }
      await load();
    }

    async function remove(todoId: string) {
      await api.deleteTodo(todoId);
      await load();
    }

    // Realtime: listen for changes from other tabs/users
    (async () => {
      try {
        const channel = await api.subscribeTodos();
        const sub = channel.subscribe(() => load());
        await sub.established;
      } catch { /* realtime not available in local dev */ }
    })();

    load();
    return container;
  }, signInMessage)
);
