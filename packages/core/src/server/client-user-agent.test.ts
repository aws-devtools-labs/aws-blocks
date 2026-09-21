// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CLIENT_USER_AGENT_HEADER,
  getClientUserAgentToken,
  installClientUserAgent,
  validateClientUserAgentToken,
} from './client-user-agent.js';

describe('validateClientUserAgentToken', () => {
  test('accepts the shipped languages and returns the client/<lang>/<version> token', () => {
    const cases: [string, string][] = [
      ['aws-blocks-swift/0.1.1', 'client/swift/0.1.1'],
      ['aws-blocks-kotlin/0.2.0', 'client/kotlin/0.2.0'],
      ['aws-blocks-dart/0.1.3', 'client/dart/0.1.3'],
      ['aws-blocks-swift/1.0.0-beta.1', 'client/swift/1.0.0-beta.1'],
      ['aws-blocks-swift/1.0.0-rc-1', 'client/swift/1.0.0-rc-1'],
      ['aws-blocks-js/0.5.0', 'client/js/0.5.0'],
    ];
    for (const [input, expected] of cases) {
      assert.strictEqual(validateClientUserAgentToken(input), expected);
    }
  });

  test('accepts a well-formed token for a language that does not exist yet (grammar, not vocabulary)', () => {
    // Validating shape, not an allowlist: a language added later still
    // attributes on backends deployed before it.
    assert.strictEqual(validateClientUserAgentToken('aws-blocks-rust/1.2.3'), 'client/rust/1.2.3');
    assert.strictEqual(validateClientUserAgentToken('aws-blocks-java/2.0.0'), 'client/java/2.0.0');
  });

  test('rejects missing / empty input', () => {
    assert.strictEqual(validateClientUserAgentToken(undefined), undefined);
    assert.strictEqual(validateClientUserAgentToken(null), undefined);
    assert.strictEqual(validateClientUserAgentToken(''), undefined);
  });

  test('rejects a trailing token rather than concatenating it', () => {
    assert.strictEqual(validateClientUserAgentToken('aws-blocks-swift/0.1.1 os/android#14'), undefined);
    assert.strictEqual(validateClientUserAgentToken('aws-blocks-swift/0.1.1 aws-blocks-kotlin/0.2.0'), undefined);
  });

  test('rejects injection attempts (space, slash, newline, control, non-ascii)', () => {
    for (const hostile of [
      'aws-blocks-swift/0.1.1 evil',
      'aws-blocks-swift/0.1.1\nInjected: header',
      'aws-blocks-swift/0.1.1\tx',
      'aws-blocks-swift/0.1.1/extra',
      'aws-blocks-swift/0.1.1\u0000',
      'aws-blocks-swïft/0.1.1',
      ' aws-blocks-swift/0.1.1',
      'aws-blocks-swift/0.1.1 ',
    ]) {
      assert.strictEqual(validateClientUserAgentToken(hostile), undefined);
    }
  });

  test('rejects malformed language segment or version', () => {
    for (const bad of [
      'aws-blocks-Swift/1.0.0', // uppercase language
      'aws-blocks-/1.0.0', // empty language
      'aws-blocks-1swift/1.0.0', // language must start with a letter
      'blocks-swift/1.0.0', // wrong prefix
      'aws-blocks-swift/1.0', // not full semver
      'aws-blocks-swift/1.0.0.0', // too many segments
      'aws-blocks-swift/v1.0.0', // leading v
      'aws-blocks-swift/1.0.0-', // empty prerelease
      'aws-blocks-swift/1.0.0-alpha..1', // empty prerelease identifier
    ]) {
      assert.strictEqual(validateClientUserAgentToken(bad), undefined);
    }
  });

  test('rejects an oversized header even if it would otherwise match', () => {
    const longPrerelease = 'a'.repeat(200);
    assert.strictEqual(validateClientUserAgentToken(`aws-blocks-swift/1.0.0-${longPrerelease}`), undefined);
  });
});

describe('installClientUserAgent middleware', () => {
  const STORE_KEY = '__BLOCKS_REQUEST_CLIENT_USER_AGENT_STORE__';
  let als: AsyncLocalStorage<string | undefined>;
  let originalStore: any;

  beforeEach(() => {
    originalStore = (globalThis as any)[STORE_KEY];
    als = new AsyncLocalStorage<string | undefined>();
    (globalThis as any)[STORE_KEY] = als;
  });

  afterEach(() => {
    if (originalStore === undefined) {
      delete (globalThis as any)[STORE_KEY];
    } else {
      (globalThis as any)[STORE_KEY] = originalStore;
    }
  });

  /**
   * A fake AWS SDK client that captures the installed middleware and lets us
   * drive it.
   */
  function fakeClient() {
    let middleware: any;
    const client = {
      middlewareStack: {
        add: (mw: any, _opts: any) => {
          middleware = mw;
        },
      },
    };
    return {
      client,
      // Drive the captured middleware with a request and return the mutated
      // headers.
      run: async (headers: Record<string, string>) => {
        const next = async (args: any) => ({ output: args });
        await middleware(next)({ request: { headers } });
        return headers;
      },
    };
  }

  test('appends the token to an existing user-agent header', async () => {
    const fc = fakeClient();
    installClientUserAgent(fc.client);
    const headers = await als.run('client/swift/0.1.1', () =>
      fc.run({ 'user-agent': 'aws-sdk-js/3.700.0 aws-blocks/0.5.0 bb/KVStore/0.1.1' }),
    );
    assert.strictEqual(
      headers['user-agent'],
      'aws-sdk-js/3.700.0 aws-blocks/0.5.0 bb/KVStore/0.1.1 client/swift/0.1.1',
    );
  });

  test('falls back to x-amz-user-agent when user-agent is absent', async () => {
    const fc = fakeClient();
    installClientUserAgent(fc.client);
    const headers = await als.run('client/kotlin/0.2.0', () =>
      fc.run({ 'x-amz-user-agent': 'aws-sdk-js/3.700.0' }),
    );
    assert.strictEqual(headers['x-amz-user-agent'], 'aws-sdk-js/3.700.0 client/kotlin/0.2.0');
  });

  test('is a no-op when no token is set for the request', async () => {
    const fc = fakeClient();
    installClientUserAgent(fc.client);
    // No als.run wrapper, so getStore() returns undefined.
    const headers = await fc.run({ 'user-agent': 'aws-sdk-js/3.700.0' });
    assert.strictEqual(headers['user-agent'], 'aws-sdk-js/3.700.0');
  });

  test('does not create a user-agent header when none exists', async () => {
    const fc = fakeClient();
    installClientUserAgent(fc.client);
    const headers = await als.run('client/swift/0.1.1', () => fc.run({}));
    assert.deepStrictEqual(headers, {});
  });

  test('is a no-op when the request carries no headers', async () => {
    let middleware: any;
    installClientUserAgent({ middlewareStack: { add: (mw: any) => { middleware = mw; } } });
    let nextCalled = false;
    const next = async (args: any) => { nextCalled = true; return { output: args }; };
    // hasHeaders() returns false, so it skips the append but still calls next().
    await als.run('client/swift/0.1.1', () => middleware(next)({ request: {} }));
    assert.strictEqual(nextCalled, true);
  });

  test('registers the middleware at the build step with low priority', () => {
    let options: any;
    installClientUserAgent({ middlewareStack: { add: (_mw: any, opts: any) => { options = opts; } } });
    assert.deepStrictEqual(options, { step: 'build', priority: 'low', name: 'blocksClientUserAgent' });
  });
});

describe('client user-agent request-scoped storage', () => {
  const STORE_KEY = '__BLOCKS_REQUEST_CLIENT_USER_AGENT_STORE__';
  let originalStore: any;

  beforeEach(() => {
    originalStore = (globalThis as any)[STORE_KEY];
  });

  afterEach(() => {
    if (originalStore === undefined) {
      delete (globalThis as any)[STORE_KEY];
    } else {
      (globalThis as any)[STORE_KEY] = originalStore;
    }
  });

  test('returns undefined when no store is registered', () => {
    assert.strictEqual(getClientUserAgentToken(), undefined);
  });

  test('does not leak the token across (sequential) requests', async () => {
    const als = new AsyncLocalStorage<string | undefined>();
    (globalThis as any)[STORE_KEY] = als;

    const seen: Array<string | undefined> = [];
    await als.run('client/swift/0.1.1', async () => {
      seen.push(getClientUserAgentToken());
    });
    // Outside any run, getClientUserAgentToken() returns undefined.
    seen.push(getClientUserAgentToken());
    await als.run('client/dart/0.1.3', async () => {
      seen.push(getClientUserAgentToken());
    });

    assert.deepStrictEqual(seen, ['client/swift/0.1.1', undefined, 'client/dart/0.1.3']);
  });
});

describe('CLIENT_USER_AGENT_HEADER', () => {
  test('is the lowercase custom header name', () => {
    assert.strictEqual(CLIENT_USER_AGENT_HEADER, 'x-blocks-user-agent');
  });
});
