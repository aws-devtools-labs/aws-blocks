// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getContext } from 'unctx';
import { withAuth, registerCookieProvider, clearCookieProviders } from './index.js';
import { _getProviders } from './withAuth.js';
import { ApiError } from '../errors.js';

// Seed the `nitro-app` unctx context with `asyncContext: true` at module load,
// mirroring Nitro's `experimental.asyncContext: true`. unctx caches the context
// instance on first `getContext()` call (first-write-wins), so this MUST run
// before any test triggers the provider — otherwise a non-async instance gets
// cached and `.use()` cannot survive the provider's internal `await import`.
getContext('nitro-app', { asyncContext: true, AsyncLocalStorage });

describe('withAuth', () => {
  let originalStore: any;

  beforeEach(() => {
    originalStore = (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__;
  });

  afterEach(() => {
    if (originalStore === undefined) {
      delete (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__;
    } else {
      (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = originalStore;
    }
  });

  test('forwards explicit cookies via AsyncLocalStorage', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    let captured: string | undefined;
    await withAuth(async () => {
      captured = store.getStore();
      return 'result';
    }, 'session=abc123; token=xyz');

    assert.strictEqual(captured, 'session=abc123; token=xyz');
  });

  test('returns the value from fn when explicit cookies provided', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    const result = await withAuth(async () => {
      return { data: 42 };
    }, 'session=abc');

    assert.deepStrictEqual(result, { data: 42 });
  });

  test('uses existing AsyncLocalStorage context when already set', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    let innerCookies: string | undefined;

    await store.run('existing-cookies', async () => {
      const result = await withAuth(async () => {
        innerCookies = store.getStore();
        return 'ok';
      });
      assert.strictEqual(result, 'ok');
    });

    assert.strictEqual(innerCookies, 'existing-cookies');
  });

  test('throws when no cookies found and no framework detected', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    const saved = _getProviders().slice();
    clearCookieProviders();

    try {
      await assert.rejects(
        () => withAuth(async () => 'should not reach'),
        (err: ApiError) => {
          assert.ok(err instanceof ApiError);
          assert.ok(err.message.includes('withAuth: No authentication cookies found'));
          assert.strictEqual(err.status, 401);
          return true;
        },
      );
    } finally {
      for (const p of saved) registerCookieProvider(p.name, p.detect);
    }
  });

  test('creates AsyncLocalStorage lazily if globalThis store is missing', async () => {
    delete (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__;

    let storeExistedDuringCall = false;
    const result = await withAuth(async () => {
      storeExistedDuringCall = !!(globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__;
      return 'created';
    }, 'lazy-cookies');

    assert.strictEqual(result, 'created');
    assert.ok(storeExistedDuringCall, 'Store should be created lazily');
    assert.ok((globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__, 'Store should persist on globalThis');
  });

  test('propagates errors from fn', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    await assert.rejects(
      () => withAuth(async () => {
        throw new Error('inner error');
      }, 'some-cookies'),
      { message: 'inner error' },
    );
  });

  test('multiple nested API calls share the same cookie context', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    const captured: string[] = [];

    await withAuth(async () => {
      captured.push(store.getStore() ?? 'none');
      await Promise.resolve();
      captured.push(store.getStore() ?? 'none');
      return captured;
    }, 'shared-session=1');

    assert.deepStrictEqual(captured, ['shared-session=1', 'shared-session=1']);
  });

  for (const [label, noCookies] of [['null', null], ['an empty string', ''], ['a blank string', '  ']] as const) {
    test(`explicit ${label} runs fn without cookies when no provider detects any`, async () => {
      const store = new AsyncLocalStorage<string>();
      (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

      const saved = _getProviders().slice();
      clearCookieProviders();

      try {
        let called = false;
        let captured: string | undefined;
        const result = await withAuth(async () => {
          called = true;
          captured = store.getStore();
          return 'public';
        }, noCookies);

        assert.strictEqual(result, 'public');
        assert.ok(called, 'fn should run');
        assert.ok(!captured, 'fn should see no cookies');
      } finally {
        for (const p of saved) registerCookieProvider(p.name, p.detect);
      }
    });
  }

  test('explicit null still uses cookies detected by a provider', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    const saved = _getProviders().slice();
    clearCookieProviders();
    registerCookieProvider('custom', async () => 'provider-cookie=value');

    try {
      let captured: string | undefined;
      await withAuth(async () => {
        captured = store.getStore();
        return 'ok';
      }, null);

      assert.strictEqual(captured, 'provider-cookie=value');
    } finally {
      clearCookieProviders();
      for (const p of saved) registerCookieProvider(p.name, p.detect);
    }
  });

  test('explicit null still uses the cookies of an existing context', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    let inner: string | undefined;
    await store.run('existing-cookies', async () => {
      await withAuth(async () => {
        inner = store.getStore();
      }, null);
    });

    assert.strictEqual(inner, 'existing-cookies');
  });

  test('concurrent calls with and without cookies stay isolated', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    const saved = _getProviders().slice();
    clearCookieProviders();

    try {
      // Both calls are suspended at the same time before either reads the store.
      let open = () => {};
      const gate = new Promise<void>(resolve => { open = resolve; });
      let entered = 0;
      const read = async () => {
        if (++entered === 2) open();
        await gate;
        return store.getStore();
      };
      const [signedIn, anonymous] = await Promise.all([
        withAuth(read, 'session=user'),
        withAuth(read, null),
      ]);

      assert.strictEqual(signedIn, 'session=user');
      assert.ok(!anonymous, 'the anonymous call should see no cookies');
    } finally {
      for (const p of saved) registerCookieProvider(p.name, p.detect);
    }
  });

  test('undefined cookies still auto-detect and throw 401 when nothing is found', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    const saved = _getProviders().slice();
    clearCookieProviders();

    try {
      let called = false;
      await assert.rejects(
        () => withAuth(async () => { called = true; }, undefined),
        (err: ApiError) => err instanceof ApiError && err.status === 401,
      );
      assert.strictEqual(called, false);
    } finally {
      for (const p of saved) registerCookieProvider(p.name, p.detect);
    }
  });
});

describe('Cookie Provider Registry', () => {
  let originalStore: any;
  let savedProviders: Array<{ name: string; detect: () => Promise<string | undefined> }>;

  beforeEach(() => {
    originalStore = (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__;
    savedProviders = _getProviders().slice();
    clearCookieProviders();
  });

  afterEach(() => {
    clearCookieProviders();
    for (const p of savedProviders) registerCookieProvider(p.name, p.detect);

    if (originalStore === undefined) {
      delete (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__;
    } else {
      (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = originalStore;
    }
  });

  test('default Next.js provider is registered on module load', () => {
    const providers = savedProviders;
    const nextProvider = providers.find(p => p.name === 'nextjs');
    assert.ok(nextProvider, 'Next.js provider should be registered by default');
  });

  test('Next.js provider returns undefined when next/headers is not available', async () => {
    const nextProvider = savedProviders.find(p => p.name === 'nextjs');
    assert.ok(nextProvider);

    const result = await nextProvider.detect();
    assert.strictEqual(result, undefined);
  });

  test('default Nuxt provider is registered on module load', () => {
    const providers = savedProviders;
    const nuxtProvider = providers.find(p => p.name === 'nuxt');
    assert.ok(nuxtProvider, 'Nuxt provider should be registered by default');
  });

  test('Nuxt provider returns undefined cleanly when no Nitro context is bound', async () => {
    // When the test runs in a plain node env (no Nitro), either `unctx`
    // isn't installed (import fails) or it is, but `getContext('nitro-app').use()`
    // throws because no async context is bound. Both paths must return
    // undefined, and neither should leak the underlying error to the caller.
    const nuxtProvider = savedProviders.find(p => p.name === 'nuxt');
    assert.ok(nuxtProvider);

    // Suppress the one-time console.warn on the asyncContext-disabled path so
    // it doesn't contaminate test output.
    process.env.BLOCKS_SUPPRESS_NUXT_ASYNC_CONTEXT_WARN = '1';
    try {
      const result = await nuxtProvider.detect();
      assert.strictEqual(result, undefined);
    } finally {
      delete process.env.BLOCKS_SUPPRESS_NUXT_ASYNC_CONTEXT_WARN;
    }
  });

  test('Nuxt provider reads cookie from the h3 `{ event }` shape (Nitro v2)', async () => {
    const nuxtProvider = savedProviders.find(p => p.name === 'nuxt');
    assert.ok(nuxtProvider);

    // The `nitro-app` context is seeded with asyncContext at module load, so
    // the binding survives the provider's internal `await import('unctx')`.
    // Nitro v2 (h3): `{ event }` carrying the cookie on the Node request headers.
    const bound = { event: { node: { req: { headers: { cookie: 'session=h3' } } } } };
    const result = await getContext('nitro-app').callAsync(bound, () => nuxtProvider.detect());
    assert.strictEqual(result, 'session=h3');
  });

  test('Nuxt provider reads cookie from the srvx `{ request }` shape (Nitro v3 / Nuxt 5)', async () => {
    const nuxtProvider = savedProviders.find(p => p.name === 'nuxt');
    assert.ok(nuxtProvider);

    // Nitro v3 (srvx): `{ request }` carrying the cookie on a standard Web
    // `Request`. This is the forward-compat path guarded by the TODO in
    // withAuth.ts.
    const bound = { request: new Request('https://example.com', { headers: { cookie: 'session=srvx' } }) };
    const result = await getContext('nitro-app').callAsync(bound, () => nuxtProvider.detect());
    assert.strictEqual(result, 'session=srvx');
  });

  test('custom provider registration works', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    registerCookieProvider('custom', async () => 'custom-cookie=hello');

    let captured: string | undefined;
    await withAuth(async () => {
      captured = store.getStore();
      return 'ok';
    });

    assert.strictEqual(captured, 'custom-cookie=hello');
  });

  test('multiple providers tried in registration order — first match wins', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    const callOrder: string[] = [];

    registerCookieProvider('first', async () => {
      callOrder.push('first');
      return undefined;
    });

    registerCookieProvider('second', async () => {
      callOrder.push('second');
      return 'winner=second';
    });

    registerCookieProvider('third', async () => {
      callOrder.push('third');
      return 'should-not-reach=true';
    });

    let captured: string | undefined;
    await withAuth(async () => {
      captured = store.getStore();
      return 'ok';
    });

    assert.strictEqual(captured, 'winner=second');
    assert.deepStrictEqual(callOrder, ['first', 'second']);
  });

  test('explicit cookies take priority over providers', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    let providerCalled = false;
    registerCookieProvider('should-not-run', async () => {
      providerCalled = true;
      return 'provider-cookie=value';
    });

    let captured: string | undefined;
    await withAuth(async () => {
      captured = store.getStore();
      return 'ok';
    }, 'explicit-cookie=priority');

    assert.strictEqual(captured, 'explicit-cookie=priority');
    assert.strictEqual(providerCalled, false, 'Provider should not be called when explicit cookies given');
  });

  test('existing ALS context takes priority over providers', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    let providerCalled = false;
    registerCookieProvider('should-not-run', async () => {
      providerCalled = true;
      return 'provider-cookie=value';
    });

    let captured: string | undefined;
    await store.run('als-cookies', async () => {
      await withAuth(async () => {
        captured = store.getStore();
        return 'ok';
      });
    });

    assert.strictEqual(captured, 'als-cookies');
    assert.strictEqual(providerCalled, false, 'Provider should not be called when ALS context exists');
  });

  test('throws when all providers return undefined', async () => {
    const store = new AsyncLocalStorage<string>();
    (globalThis as any).__BLOCKS_REQUEST_COOKIES_STORE__ = store;

    registerCookieProvider('nope1', async () => undefined);
    registerCookieProvider('nope2', async () => undefined);

    await assert.rejects(
      () => withAuth(async () => 'should not reach'),
      (err: ApiError) => {
        assert.ok(err instanceof ApiError);
        assert.ok(err.message.includes('withAuth: No authentication cookies found'));
        assert.strictEqual(err.status, 401);
        return true;
      },
    );
  });

  test('registerCookieProvider appends to existing providers', () => {
    registerCookieProvider('a', async () => undefined);
    registerCookieProvider('b', async () => undefined);

    const providers = _getProviders();
    assert.strictEqual(providers.length, 2);
    assert.strictEqual(providers[0].name, 'a');
    assert.strictEqual(providers[1].name, 'b');
  });

  test('clearCookieProviders removes all registered providers', () => {
    registerCookieProvider('a', async () => undefined);
    registerCookieProvider('b', async () => undefined);
    assert.strictEqual(_getProviders().length, 2);

    clearCookieProviders();
    assert.strictEqual(_getProviders().length, 0);
  });
});
