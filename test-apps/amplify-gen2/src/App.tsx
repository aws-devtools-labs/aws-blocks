import React, { useState, useEffect } from 'react';
import { signUp, confirmSignUp, signIn, signOut, getCurrentUser } from 'aws-amplify/auth';
import { api } from 'cdk-blocks';

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [greeting, setGreeting] = useState('');
  const [noteKey, setNoteKey] = useState('');
  const [noteValue, setNoteValue] = useState('');
  const [fetchedNote, setFetchedNote] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);

  // Database (todos) state
  const [todoTitle, setTodoTitle] = useState('');
  const [todos, setTodos] = useState<{ id: string; title: string; completed: boolean; created_at: string }[]>([]);
  const [dbStatus, setDbStatus] = useState('');

  useEffect(() => {
    getCurrentUser().then(u => setUser(u)).catch(() => {});
  }, []);

  async function handleGreet() {
    setStatus('');
    const result = await api.greet('World');
    setGreeting(`${result.message} (${new Date(result.timestamp).toLocaleTimeString()})`);
  }

  async function handleSignUp() {
    setStatus('');
    try {
      const { nextStep } = await signUp({ username: email, password, options: { userAttributes: { email } } });
      if (nextStep.signUpStep === 'CONFIRM_SIGN_UP') {
        setShowConfirm(true);
        setStatus('Check email for code');
      }
    } catch (e: any) { setStatus(e.message); }
  }

  async function handleConfirm() {
    try {
      await confirmSignUp({ username: email, confirmationCode: confirmCode });
      setStatus('Confirmed');
      setShowConfirm(false);
    } catch (e: any) { setStatus(e.message); }
  }

  async function handleSignIn() {
    setStatus('');
    try {
      await signIn({ username: email, password });
      setUser(await getCurrentUser());
      setStatus('Signed in');
    } catch (e: any) { setStatus(e.message); }
  }

  async function handleSignOut() {
    await signOut();
    setUser(null);
    setFetchedNote(null);
    setTodos([]);
    setStatus('Signed out');
  }

  async function handlePutNote() {
    setStatus('');
    try {
      await api.putNote(noteKey, noteValue);
      setStatus('Saved');
    } catch (e: any) { setStatus(e.message); }
  }

  async function handleGetNote() {
    setStatus('');
    try {
      const result = await api.getNote(noteKey);
      setFetchedNote(result.value);
    } catch (e: any) { setStatus(e.message); }
  }

  // ── Database (Todos) handlers ───────────────────────────────────────────

  async function handleCreateTodo() {
    setDbStatus('');
    try {
      const result = await api.createTodo(todoTitle);
      setTodoTitle('');
      const rows = await api.listTodos();
      setTodos(rows);
      setDbStatus(`Created: ${result.id}`);
    } catch (e: any) { setDbStatus(e.message); }
  }

  async function handleListTodos() {
    setDbStatus('');
    try {
      const rows = await api.listTodos();
      setTodos(rows);
    } catch (e: any) { setDbStatus(e.message); }
  }

  async function handleCompleteTodo(id: string) {
    setDbStatus('');
    try {
      await api.completeTodo(id);
      await handleListTodos();
    } catch (e: any) { setDbStatus(e.message); }
  }

  async function handleDeleteTodo(id: string) {
    setDbStatus('');
    try {
      await api.deleteTodo(id);
      await handleListTodos();
    } catch (e: any) { setDbStatus(e.message); }
  }

  return (
    <div style={{ maxWidth: 500, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>Amplify + CDK Blocks</h1>

      <section>
        <h2>Public</h2>
        <button id="btn-greet" onClick={handleGreet}>Greet</button>
        <p id="greeting">{greeting}</p>
      </section>

      <section>
        <h2>Auth</h2>
        {user ? (
          <div>
            <p id="user-info">Signed in: {user.username}</p>
            <button id="btn-signout" onClick={handleSignOut}>Sign Out</button>
          </div>
        ) : (
          <div>
            <input id="input-email" placeholder="email" value={email} onChange={e => setEmail(e.target.value)} />
            <input id="input-password" placeholder="password" type="password" value={password} onChange={e => setPassword(e.target.value)} />
            <button id="btn-signup" onClick={handleSignUp}>Sign Up</button>
            <button id="btn-signin" onClick={handleSignIn}>Sign In</button>
            {showConfirm && (
              <div>
                <input id="input-code" placeholder="code" value={confirmCode} onChange={e => setConfirmCode(e.target.value)} />
                <button id="btn-confirm" onClick={handleConfirm}>Confirm</button>
              </div>
            )}
          </div>
        )}
      </section>

      <section>
        <h2>Notes (KV Store)</h2>
        <input id="input-note-key" placeholder="key" value={noteKey} onChange={e => setNoteKey(e.target.value)} />
        <input id="input-note-value" placeholder="value" value={noteValue} onChange={e => setNoteValue(e.target.value)} />
        <button id="btn-put" onClick={handlePutNote}>Put</button>
        <button id="btn-get" onClick={handleGetNote}>Get</button>
        <p id="note-result">{fetchedNote ?? ''}</p>
      </section>

      <section>
        <h2>Todos (Database)</h2>
        <input id="input-todo-title" placeholder="todo title" value={todoTitle} onChange={e => setTodoTitle(e.target.value)} />
        <button id="btn-create-todo" onClick={handleCreateTodo}>Create</button>
        <button id="btn-list-todos" onClick={handleListTodos}>Refresh</button>
        <ul id="todo-list">
          {todos.map(t => (
            <li key={t.id} data-todo-id={t.id}>
              <span className={t.completed ? 'completed' : ''}>{t.title}</span>
              {!t.completed && <button className="btn-complete" onClick={() => handleCompleteTodo(t.id)}>✓</button>}
              <button className="btn-delete" onClick={() => handleDeleteTodo(t.id)}>✕</button>
            </li>
          ))}
        </ul>
        <p id="db-status">{dbStatus}</p>
      </section>

      <p id="status">{status}</p>
    </div>
  );
}
