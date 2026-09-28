// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpRequest } from '@smithy/protocol-http';
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
      // Build metadata is accepted but not emitted, so metrics do not fragment
      // into one series per build (pub writes `version: 0.1.4+1`).
      ['aws-blocks-dart/0.1.4+1', 'client/dart/0.1.4'],
      ['aws-blocks-dart/1.0.0-beta.1+sha.abc123', 'client/dart/1.0.0-beta.1'],
      // Appended metadata is ignored, not fatal (design: values are space-separated).
      ['aws-blocks-swift/0.1.1 os/android#14', 'client/swift/0.1.1'],
      ['aws-blocks-swift/0.1.1 md/flutter#3.24.0', 'client/swift/0.1.1'],
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

  test('keeps the first token and ignores anything following it', () => {
    assert.strictEqual(
      validateClientUserAgentToken('aws-blocks-swift/0.1.1 aws-blocks-kotlin/0.2.0'),
      'client/swift/0.1.1',
    );
    assert.strictEqual(validateClientUserAgentToken('aws-blocks-swift/0.1.1 evil'), 'client/swift/0.1.1');
    assert.strictEqual(validateClientUserAgentToken('aws-blocks-swift/0.1.1 '), 'client/swift/0.1.1');
  });

  test('rejects injection attempts (space, slash, newline, control, non-ascii)', () => {
    for (const hostile of [
      'aws-blocks-swift/0.1.1\nInjected: header',
      'aws-blocks-swift/0.1.1\tx',
      'aws-blocks-swift/0.1.1/extra',
      'aws-blocks-swift/0.1.1\u0000',
      'aws-blocks-swïft/0.1.1',
      ' aws-blocks-swift/0.1.1',
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

  test('accepts a token whose emitted form is exactly at the cap', () => {
    assert.strictEqual(validateClientUserAgentToken(`aws-blocks-swift/1.0.0-${'a'.repeat(29)}`)?.length, 48);
  });

  test('drops a grammar-valid token whose emitted form exceeds the cap', () => {
    const raw = `aws-blocks-swift/1.0.0-${'a'.repeat(30)}`;
    assert.ok(Buffer.byteLength(raw, 'utf8') <= 128, 'within the header cap, so only the token cap rejects it');
    assert.strictEqual(validateClientUserAgentToken(raw), undefined);
  });

  test('rejects an oversized token even if it would otherwise match', () => {
    const raw = `aws-blocks-swift/1.0.0-${'a'.repeat(200)}`;
    assert.ok(Buffer.byteLength(raw, 'utf8') > 128, 'over the byte cap');
    assert.strictEqual(validateClientUserAgentToken(raw), undefined);
  });

  // Build metadata is stripped from the token, so only the byte cap bounds this.
  test('drops a token whose build metadata exceeds the byte cap', () => {
    const raw = `aws-blocks-dart/0.1.4+${'b'.repeat(107)}`;
    assert.strictEqual(Buffer.byteLength(raw, 'utf8'), 129, 'one byte over the cap');
    assert.strictEqual(validateClientUserAgentToken(raw), undefined);
  });

  // The cap applies to the token, not the header, so metadata length is not fatal.
  test('keeps the token when appended metadata pushes the header over the cap', () => {
    const raw = `aws-blocks-swift/0.1.1 ${'x'.repeat(200)}`;
    assert.ok(Buffer.byteLength(raw, 'utf8') > 128, 'header is over the cap');
    assert.strictEqual(validateClientUserAgentToken(raw), 'client/swift/0.1.1');
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
  function fakeClient(anchorPresent = true) {
    let middleware: any;
    let options: any;
    let method: 'add' | 'addRelativeTo' | undefined;
    const client = {
      middlewareStack: {
        identify: () =>
          anchorPresent ? ['getUserAgentMiddleware - build'] : ['retryMiddleware - retry'],
        add: (mw: any, opts: any) => {
          middleware = mw;
          options = opts;
          method = 'add';
        },
        addRelativeTo: (mw: any, opts: any) => {
          middleware = mw;
          options = opts;
          method = 'addRelativeTo';
        },
      },
    };
    return {
      client,
      options: () => options,
      middleware: () => middleware,
      method: () => method,
      // Drive the captured middleware with a request and return the mutated
      // headers.
      run: async (headers: Record<string, string>) => {
        const next = async (args: any) => ({ output: args });
        const request = new HttpRequest({ hostname: 'example.com', headers });
        await middleware(next)({ request });
        return request.headers;
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

  // Node sets both, and `x-amz-user-agent` is the signed header carrying the
  // `bb/` chain, so the token has to reach both.
  test('appends to both headers when both are present (SDK v3 node)', async () => {
    const fc = fakeClient();
    installClientUserAgent(fc.client);
    const headers = await als.run('client/swift/0.1.1', () =>
      fc.run({ 'user-agent': 'aws-sdk-js/3.700.0', 'x-amz-user-agent': 'aws-sdk-js/3.700.0' }),
    );
    assert.strictEqual(headers['user-agent'], 'aws-sdk-js/3.700.0 client/swift/0.1.1');
    assert.strictEqual(headers['x-amz-user-agent'], 'aws-sdk-js/3.700.0 client/swift/0.1.1');
  });

  // An empty `user-agent` must not swallow the token when the real UA is on
  // `x-amz-user-agent`.
  test('appends to x-amz-user-agent when user-agent is present but empty', async () => {
    const fc = fakeClient();
    installClientUserAgent(fc.client);
    const headers = await als.run('client/swift/0.1.1', () =>
      fc.run({ 'user-agent': '', 'x-amz-user-agent': 'aws-sdk-js/3.700.0 aws-blocks/0.5.0' }),
    );
    assert.strictEqual(headers['x-amz-user-agent'], 'aws-sdk-js/3.700.0 aws-blocks/0.5.0 client/swift/0.1.1');
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

  test('is a no-op when the request is not an HTTP request', async () => {
    let middleware: any;
    const fc = fakeClient();
    installClientUserAgent(fc.client);
    middleware = fc.middleware();
    let nextCalled = false;
    const next = async (args: any) => { nextCalled = true; return { output: args }; };
    // Not an HttpRequest, so the append is skipped but next() still runs.
    await als.run('client/swift/0.1.1', () => middleware(next)({ request: {} }));
    assert.strictEqual(nextCalled, true);
  });

  test('anchors after the SDK user-agent middleware when it is on the stack', () => {
    const fc = fakeClient();
    installClientUserAgent(fc.client);
    assert.strictEqual(fc.method(), 'addRelativeTo');
    assert.deepStrictEqual(fc.options(), {
      name: 'blocksClientUserAgent',
      relation: 'after',
      toMiddleware: 'getUserAgentMiddleware',
      override: true,
    });
  });

  // A relative anchor is resolved on every send, so anchoring to a name the
  // stack does not have would fail every request rather than this call.
  test('registers at the SDK step and priority when the anchor is absent', () => {
    const fc = fakeClient(false);
    installClientUserAgent(fc.client);
    assert.strictEqual(fc.method(), 'add');
    assert.deepStrictEqual(fc.options(), {
      name: 'blocksClientUserAgent',
      step: 'build',
      priority: 'low',
      override: true,
    });
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

describe('installClientUserAgent on a real SDK v3 client stack', () => {
  // `DynamoDBDocumentClient.from()` shares the base client's stack, so a repeat
  // install must replace the entry rather than throw at construction.
  test('can be installed twice on the same stack', async () => {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
    const base = new DynamoDBClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' },
    });
    installClientUserAgent(base);
    const doc = DynamoDBDocumentClient.from(base);
    assert.strictEqual(doc.middlewareStack, base.middlewareStack, 'from() shares the stack');
    assert.doesNotThrow(() => installClientUserAgent(doc));
  });
});

describe('CLIENT_USER_AGENT_HEADER', () => {
  test('is the lowercase custom header name', () => {
    assert.strictEqual(CLIENT_USER_AGENT_HEADER, 'x-blocks-user-agent');
  });
});
