import { useEffect, useState, useCallback, useRef } from 'react';
import { api, authApi } from 'aws-blocks';
import { AccountMenuBar, onAuthChange } from '@aws-blocks/blocks/ui';

// Backend APIs are fully typed — hover over api.* for signatures.
// Full docs: node_modules/@aws-blocks/blocks/README.md

type Todo = { todoId: string; title: string; completed: boolean; priority: number; version: number };
type User = { username: string; userId: string };
type SortBy = 'priority' | 'title' | undefined;

function TodoApp() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState(2);
  const [sortBy, setSortBy] = useState<SortBy>(undefined);

  const load = useCallback(async () => {
    setTodos(await api.listTodos(sortBy));
  }, [sortBy]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let sub: any;
    (async () => {
      try {
        const channel = await api.subscribeTodos();
        sub = channel.subscribe(() => load());
        await sub.established;
      } catch { /* realtime not available in local dev */ }
    })();
    return () => sub?.unsubscribe();
  }, [load]);

  const addTodo = async () => {
    if (!newTitle.trim()) return;
    await api.createTodo(newTitle.trim(), newPriority);
    setNewTitle('');
    await load();
  };

  const toggle = async (todoId: string) => {
    try { await api.toggleTodo(todoId); } catch {}
    await load();
  };

  const changePriority = async (todoId: string, priority: number) => {
    try { await api.updatePriority(todoId, priority); } catch {}
    await load();
  };

  const remove = async (todoId: string) => {
    await api.deleteTodo(todoId);
    await load();
  };

  return (
    <div>
      <h2>Todos</h2>
      <div style={{ marginBottom: 12, display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={newTitle}
          onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addTodo()}
          placeholder="What needs to be done?"
          style={{ flex: 1, minWidth: 200, padding: 8 }}
        />
        <select value={newPriority} onChange={e => setNewPriority(Number(e.target.value))}>
          <option value={1}>🔴 High</option>
          <option value={2}>🟡 Medium</option>
          <option value={3}>🟢 Low</option>
        </select>
        <button className="bb-button bb-button-primary" onClick={addTodo}>Add</button>
      </div>
      <div style={{ marginBottom: 12, fontSize: '0.85em', color: 'var(--bb-color-text-muted, #666)' }}>
        Sort:{' '}
        <button onClick={() => setSortBy(undefined)} style={{ fontWeight: !sortBy ? 'bold' : 'normal' }}>Default</button>{' '}
        <button onClick={() => setSortBy('priority')} style={{ fontWeight: sortBy === 'priority' ? 'bold' : 'normal' }}>Priority</button>{' '}
        <button onClick={() => setSortBy('title')} style={{ fontWeight: sortBy === 'title' ? 'bold' : 'normal' }}>Title</button>
      </div>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {todos.map(t => (
          <li key={t.todoId} style={{ margin: '10px 0', display: 'flex', alignItems: 'center', gap: 8, textDecoration: t.completed ? 'line-through' : 'none', opacity: t.completed ? 0.5 : 1 }}>
            <input type="checkbox" checked={t.completed} onChange={() => toggle(t.todoId)} />
            <span style={{ flex: 1 }}>{t.title}</span>
            <select value={t.priority} onChange={e => changePriority(t.todoId, Number(e.target.value))}>
              <option value={1}>🔴 High</option>
              <option value={2}>🟡 Medium</option>
              <option value={3}>🟢 Low</option>
            </select>
            <button onClick={() => remove(t.todoId)}>×</button>
          </li>
        ))}
      </ul>
      <p style={{ color: 'var(--bb-color-text-muted, #888)', fontSize: '0.85em' }}>{todos.filter(t => !t.completed).length} remaining</p>
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (menuRef.current && !menuRef.current.hasChildNodes()) {
      menuRef.current.appendChild(AccountMenuBar(authApi));
    }
  }, []);

  useEffect(() => {
    return onAuthChange(authApi, (u) => setUser(u));
  }, []);

  return (
    <div>
      <div ref={menuRef} />
      <h1>Blocks App</h1>
      <p style={{ color: 'var(--bb-color-text-muted, #666)', fontSize: '0.9em', lineHeight: 1.5, marginBottom: 24 }}>
        This starter app demonstrates:
        {' '}<strong>authentication</strong> with cross-tab coordination,
        {' '}<strong>real-time sync</strong> across browser tabs,
        and <strong>todos stored in a distributed table</strong> with per-user isolation.
      </p>
      {!user && <p>Sign in to get started.</p>}
      {user && <TodoApp />}
    </div>
  );
}
