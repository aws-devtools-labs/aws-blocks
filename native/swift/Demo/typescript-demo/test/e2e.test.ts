import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import type { api as apiType, hello as helloType } from 'aws-blocks';

let server: ChildProcess | null = null;
let api: typeof apiType;
let hello: typeof helloType;

test.before(async () => {

  // Start dev server
  console.log('🚀 Starting dev server...');
  server = spawn('npm', ['run', 'dev:server'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
    env: { ...process.env, NODE_OPTIONS: '' }
  });
  server.unref();

  // Wait for the server to answer. It also writes `aws-blocks/client.js`, the
  // generated client the import below resolves to, so import only after this.
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await setTimeout(1000);
    try {
      const res = await fetch('http://localhost:3001/aws-blocks/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello.greet', params: ['ping'] }),
      });
      ready = res.ok;
    } catch (e) {
      if (i % 10 === 9) console.log(`  Still waiting... (${i+1}s) ${(e as Error).message}`);
    }
  }
  if (!ready) throw new Error('Server not ready');

  // Import API via browser conditional export (client proxy)
  const mod = await import('aws-blocks');
  api = mod.api;
  hello = mod.hello;
});

test.after(() => {
  if (server?.pid) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch {}
  }
});

test('greet returns message and timestamp', async () => {
  const result = await hello.greet('World');
  assert.strictEqual(result.message, 'Hello, World!');
  assert.ok(typeof result.timestamp === 'number');
});

test('KV Store - set and get', async () => {
  const setResult = await api.setValue('test-key', 'test-value');
  assert.strictEqual(setResult.success, true);

  const value = await api.getValue('test-key');
  assert.strictEqual(value, 'test-value');
});

// ── Per-user todos ───────────────────────────────────────────────────────────
// Two users, each with their own cookie jar, talk to the dev server over raw
// JSON-RPC (the shared client proxy has a single cookie session). Sign-up is
// confirmed with the code the local runtime writes to `.bb-data/<fullId>/last-code.json`.

const RPC_URL = 'http://localhost:3001/aws-blocks/api';

class Session {
  private cookies = new Map<string, string>();

  async call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cookies.size ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    for (const header of res.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const body = (await res.json()) as { result?: T; error?: { message: string; data?: { name?: string } } };
    if (body.error) throw Object.assign(new Error(body.error.message), { name: body.error.data?.name ?? 'Error' });
    return body.result as T;
  }
}

async function signedInUser(label: string): Promise<{ session: Session; username: string }> {
  const session = new Session();
  const username = `${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await session.call('authApi.setAuthState', {
    action: 'signUp',
    username,
    password: 'Passw0rd!',
    // Sign-up attributes are top-level members of the action (`dispatch`
    // rest-spreads them). Nested under `attributes` they are one unknown,
    // non-string attribute, which the local pool rejects as Cognito does.
    email: `${username}@example.com`,
  });
  const { readFile } = await import('node:fs/promises');
  const delivered = JSON.parse(await readFile('.bb-data/my-app-auth/last-code.json', 'utf8')) as { username: string; code: string };
  assert.strictEqual(delivered.username, username);
  await session.call('authApi.setAuthState', { action: 'confirmSignUp', username, code: delivered.code });
  const state = await session.call<{ state: string }>('authApi.setAuthState', { action: 'autoSignIn', username });
  assert.strictEqual(state.state, 'signedIn');
  return { session, username };
}

type TodoItem = { todoId: string; title: string; completed: boolean; priority: number };

test('todos are private to the user who created them', async () => {
  const { session: alice, username: aliceName } = await signedInUser('alice');
  const { session: bob } = await signedInUser('bob');

  const aliceTodo = await alice.call<TodoItem>('api.createTodo', 'alice secret', 1);
  const bobTodo = await bob.call<TodoItem>('api.createTodo', 'bob todo', 2);

  // Every list mode returns only the caller's todos.
  for (const sortBy of [undefined, 'priority', 'title', 'createdAt']) {
    const bobs = await bob.call<TodoItem[]>('api.listTodos', ...(sortBy ? [sortBy] : []));
    assert.ok(!bobs.some((t) => t.todoId === aliceTodo.todoId), `bob listed alice's todo (sortBy=${sortBy})`);
  }

  // Bob can't update or delete Alice's todo by id.
  await assert.rejects(bob.call('api.updateTodo', aliceTodo.todoId, { title: 'pwned' }), /not found/i);
  await bob.call('api.deleteTodo', aliceTodo.todoId);

  // Nor overwrite it by smuggling key fields into `updates` (the RPC layer
  // doesn't strip properties the TypeScript signature doesn't declare).
  await bob.call('api.updateTodo', bobTodo.todoId, {
    title: 'smuggled',
    userSub: 'someone-else',
    userId: aliceName,
    todoId: aliceTodo.todoId,
  });
  const bobs = await bob.call<TodoItem[]>('api.listTodos');
  assert.deepStrictEqual(
    bobs.map((t) => [t.todoId, t.title]),
    [[bobTodo.todoId, 'smuggled']],
    'the update stayed on bob\'s own todo',
  );

  const alices = await alice.call<TodoItem[]>('api.listTodos');
  const mine = alices.find((t) => t.todoId === aliceTodo.todoId);
  assert.ok(mine, "alice's todo survived bob's delete");
  assert.strictEqual(mine.title, 'alice secret');
  assert.deepStrictEqual(
    alices.map((t) => t.todoId),
    [aliceTodo.todoId],
    'alice sees exactly her own todo',
  );

  // Signed out, the todo methods refuse.
  await assert.rejects(new Session().call('api.listTodos'), { name: 'NotAuthenticatedException' });
});
