// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from 'node:async_hooks';
import { CLIENT_FETCH_STORE } from '@aws-blocks/core/bb-utils';

/**
 * Installs a cookie jar on `global.fetch` so that `Set-Cookie` response
 * headers persist across requests. Node's native fetch doesn't do this.
 *
 * Call once before importing the API client. Required for any Node.js script
 * that uses authenticated APIs (tests, CLI tools, migration scripts).
 *
 * @returns A cleanup function that restores the original fetch.
 *
 * @example
 * ```typescript
 * import { installCookieJar } from '@aws-blocks/blocks/utils';
 * installCookieJar();
 *
 * const { api, authApi } = await import('aws-blocks');
 * await authApi.setAuthState({ action: 'signIn', username: '...', password: '...' });
 * // Subsequent calls now carry the auth cookie automatically
 * const data = await api.listTodos();
 * ```
 */
let installed = false;

export function installCookieJar(): () => void {
  if (installed) throw new Error('Cookie jar is already installed.');
  installed = true;

  const jar = new Map<string, string>();
  const nativeFetch = global.fetch;

  global.fetch = withCookieJar(jar, nativeFetch);

  return () => { global.fetch = nativeFetch; installed = false; };
}

/**
 * Each cookie-jar `fetch` this module made, mapped to the `fetch` it wraps, so a
 * test client can step past `installCookieJar()`'s jar on the global `fetch`.
 */
const jarWrapped = new WeakMap<typeof fetch, typeof fetch>();

/** `send`, keeping cookies in `jar`: sends them, and applies each response's `Set-Cookie`. */
function withCookieJar(jar: Map<string, string>, send: typeof fetch): typeof fetch {
  const wrapper = (async (input: any, init?: any) => {
    if (jar.size > 0) {
      const cookieHeader = Array.from(jar.values()).join('; ');
      init = init ?? {};
      init.headers = { ...init.headers, cookie: cookieHeader };
    }

    const response = await send(input, init);

    for (const sc of response.headers.getSetCookie?.() ?? []) {
      const [pair] = sc.split(';');
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      if (value && !sc.includes('Max-Age=0')) {
        jar.set(name.trim(), `${name.trim()}=${value}`);
      } else {
        jar.delete(name.trim());
      }
    }

    return response;
  }) as typeof fetch;
  jarWrapped.set(wrapper, send);
  return wrapper;
}

/** The key an `ApiNamespaceClient` (`@aws-blocks/core/client`) answers with its namespace. */
const API_NAMESPACE_ID = Symbol.for('aws-blocks.apiNamespace');

/**
 * The `fetch` a test client sends with: the global one at the time of the call
 * (so a polyfill or a `fetch` mock installed before or after this module loads
 * is the one used), minus any cookie jar `installCookieJar()` wrapped around
 * it, so a test client's cookies never reach the shared jar and the shared
 * jar's never reach a test client.
 */
function baseFetch(): typeof fetch {
  let send = globalThis.fetch;
  for (let inner = jarWrapped.get(send); inner; inner = jarWrapped.get(send)) send = inner;
  return send;
}

let fetchStore: AsyncLocalStorage<typeof fetch> | undefined;

/** The store the client reads each call's `fetch` from, set on `globalThis` once. */
function clientFetchStore(): AsyncLocalStorage<typeof fetch> {
  if (!fetchStore) {
    const existing: unknown = Reflect.get(globalThis, CLIENT_FETCH_STORE);
    fetchStore = existing instanceof AsyncLocalStorage ? existing : new AsyncLocalStorage<typeof fetch>();
    Reflect.set(globalThis, CLIENT_FETCH_STORE, fetchStore);
  }
  return fetchStore;
}

/** Whether `value` is a generated API client (an `ApiNamespaceClient`). */
function isApiClient(value: unknown): value is object {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof Reflect.get(value, API_NAMESPACE_ID) === 'string'
  );
}

/** `client`, with every method call sent through `send`. */
function bindClient<C extends object>(client: C, send: typeof fetch): C {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof prop === 'symbol' || typeof value !== 'function') return value;
      return (...args: unknown[]) => clientFetchStore().run(send, () => Reflect.apply(value, target, args));
    },
  });
}

/**
 * A test user: the app's typed API clients with their own cookie jar. Each
 * call returns a new user, so one test can hold several sessions at once (an
 * owner and an intruder, say) without signing out in between.
 *
 * Pass the clients one user calls — the `aws-blocks` module itself, or an
 * object of clients — and use what it returns exactly like them. The session
 * a client's call starts (its `Set-Cookie`) is sent by every client of the
 * same test user, and by no other: neither another test user nor the shared
 * jar of {@link installCookieJar} sees it. Pass one client on its own
 * (`createTestClient(api)`) and it gets a jar of its own too, so pass every
 * client one user needs in a single call.
 *
 * **Node only** (`node:async_hooks`), for tests and scripts. Requests go
 * through the global `fetch` as it is at the time of each call, so a `fetch`
 * mock or spy sees a test user's calls; the jar `installCookieJar()` puts on
 * `fetch` is stepped past.
 *
 * @param clients - The `aws-blocks` module (`await import('aws-blocks')`), an object of its clients, or one client.
 * @returns The same clients, typed as passed, bound to a new cookie jar. Other values pass through unchanged.
 *
 * @example
 * ```typescript
 * import { createTestClient, getLastAuthCode } from '@aws-blocks/blocks/utils';
 *
 * const app = await import('aws-blocks');
 * const owner = createTestClient(app);
 * const intruder = createTestClient(app);
 *
 * for (const [user, email] of [[owner, 'owner@example.com'], [intruder, 'intruder@example.com']] as const) {
 *   await user.authApi.setAuthState({ action: 'signUp', username: email, password: 'Passw0rd!' });
 *   const code = await getLastAuthCode(email);
 *   await user.authApi.setAuthState({ action: 'confirmSignUp', username: email, code });
 *   await user.authApi.setAuthState({ action: 'autoSignIn', username: email });
 * }
 * const todo = await owner.api.createTodo('mine');
 * await intruder.api.deleteTodo(todo.todoId); // signed in as the intruder, at the same time
 * ```
 */
export function createTestClient<const T extends object>(clients: T): T {
  const send = withCookieJar(new Map<string, string>(), (input, init) => baseFetch()(input, init));
  if (isApiClient(clients)) return bindClient(clients, send);
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(clients, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (!isApiClient(value)) return value;
      if (!bound.has(prop)) bound.set(prop, bindClient(value, send));
      return bound.get(prop);
    },
  });
}

export { type GetLastAuthCodeOptions, getLastAuthCode, totpCodeFor } from '@aws-blocks/bb-auth/testing';

/**
 * Returns true if a server is already listening on the given port.
 * Useful in test setup to skip spawning a dev server when one is already running.
 *
 * @param port - Port to check (default: 3000)
 *
 * @example
 * ```typescript
 * import { isServerRunning } from '@aws-blocks/blocks/utils';
 *
 * if (!await isServerRunning()) {
 *   server = spawn('npm', ['run', 'dev:server'], { ... });
 * }
 * ```
 */
export async function isServerRunning(port = 3000): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}`);
    return true;
  } catch (e: any) {
    if (e.cause?.code === 'ECONNREFUSED' || e.cause === 'ECONNREFUSED') {
      return false;
    }
    throw e;
  }
}
