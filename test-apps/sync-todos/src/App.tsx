// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, authApi } from 'sync-todos-aws-blocks';
import type { Todo } from 'sync-todos-aws-blocks';

/** The hydrated shape type, inferred from the backend method. No codegen. */
type TodosShape = Awaited<ReturnType<typeof api.todos>>;

const NO_ROWS: readonly Todo[] = [];
const noSubscribe = () => () => {};

/** Re-render on every change to the shape's local rows. */
function useRows(shape: TodosShape | null): readonly Todo[] {
  return useSyncExternalStore(shape ? shape.subscribe : noSubscribe, shape ? shape.getSnapshot : () => NO_ROWS);
}

/** Time `count` random local lookups. Returns microseconds per lookup. */
function benchmarkLookups(shape: TodosShape, count: number): number {
  const ids = shape.rows.map((row) => row.id);
  if (ids.length === 0) return 0;
  const picks = Array.from({ length: count }, () => ids[Math.floor(Math.random() * ids.length)]);
  let found = 0;
  const start = performance.now();
  for (const id of picks) if (shape.get(id)) found++;
  const elapsed = performance.now() - start;
  if (found !== count) throw new Error(`lookup missed ${count - found} rows`);
  return (elapsed * 1000) / count;
}

function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    let next = await authApi.setAuthState({ action: 'signIn', username, password });
    if (next.state !== 'signedIn') next = await authApi.setAuthState({ action: 'signUp', username, password });
    if (next.state !== 'signedIn') next = await authApi.setAuthState({ action: 'signIn', username, password });
    if (next.state === 'signedIn') onSignedIn();
    else setError(next.error ?? 'Sign-in failed');
  };

  return (
    <div>
      <p className="muted">Sign in, or pick a new username to create an account.</p>
      <div className="row">
        <input id="username" type="text" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input id="password" type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button id="signin" type="button" onClick={submit}>Continue</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Todos() {
  const [shape, setShape] = useState<TodosShape | null>(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [roundTripMs, setRoundTripMs] = useState<number | null>(null);
  const [lookupUs, setLookupUs] = useState<number | null>(null);
  const rows = useRows(shape);
  const [upToDate, setUpToDate] = useState(false);

  useEffect(() => {
    let current: TodosShape | null = null;
    api
      .todos()
      .then(async (todos) => {
        current = todos;
        setShape(todos);
        await todos.ready;
        setUpToDate(true);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => current?.close();
  }, []);

  /** Run a write, then wait until it has synced into the local copy. */
  const write = async (run: () => Promise<{ txid: string }>) => {
    if (!shape) return;
    const start = performance.now();
    const { txid } = await run();
    await shape.waitForTxid(txid);
    setRoundTripMs(Math.round(performance.now() - start));
  };

  const sorted = [...rows].sort((a, b) => b.position - a.position).slice(0, 100);

  return (
    <div>
      <div className="stats">
        <div className="stat">
          Status <b id="sync-status">{error ? 'Error' : upToDate ? 'Live' : 'Syncing…'}</b>
        </div>
        <div className="stat">
          Rows in browser <b id="row-count">{rows.length}</b>
        </div>
        <div className="stat">
          Write → synced <b id="round-trip">{roundTripMs === null ? '—' : `${roundTripMs} ms`}</b>
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="row">
        <input id="new-title" type="text" placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button
          id="add"
          type="button"
          onClick={async () => {
            const text = title.trim();
            if (!text) return;
            setTitle('');
            await write(() => api.addTodo(text));
          }}
        >
          Add
        </button>
        <button id="seed" type="button" onClick={() => write(() => api.seed(2000))}>
          Seed 2,000
        </button>
        <button id="clear" type="button" onClick={() => write(() => api.clearTodos())}>
          Clear
        </button>
      </div>

      <div className="row">
        <button id="bench" type="button" disabled={!shape} onClick={() => shape && setLookupUs(benchmarkLookups(shape, 100_000))}>
          Time 100,000 local lookups
        </button>
        <span id="bench-result" data-us={lookupUs ?? ''}>
          {lookupUs === null ? '' : `${lookupUs.toFixed(3)} µs per lookup over ${rows.length} rows`}
        </span>
      </div>

      <ul id="todos">
        {sorted.map((todo) => (
          <li key={todo.id} data-id={todo.id} className={todo.done ? 'done' : ''}>
            <input type="checkbox" checked={todo.done} onChange={() => write(() => api.setDone(todo.id, !todo.done))} />
            <span>{todo.title}</span>
            <button type="button" onClick={() => write(() => api.deleteTodo(todo.id))}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      {rows.length > sorted.length && <p className="muted">Showing the newest {sorted.length} of {rows.length}.</p>}
    </div>
  );
}

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    authApi
      .getAuthState()
      .then((state) => setSignedIn(state.state === 'signedIn'))
      .catch(() => setSignedIn(false));
  }, []);

  return (
    <main>
      <h1>Sync Todos</h1>
      <p className="muted">
        Rows live in the browser and update as they change. Reads are local; writes go through the API.
      </p>
      {signedIn === null ? <p id="app-status">Loading…</p> : signedIn ? <Todos /> : <SignIn onSignedIn={() => setSignedIn(true)} />}
    </main>
  );
}
