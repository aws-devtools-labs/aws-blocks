import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MAX_REDIRECTS_IN_FUNCTION,
  generateAssetPrefixStripFunctionCode,
  generateBuildIdAndRedirectFunctionCode,
  generateForwardedHostAndRedirectFunctionCode,
} from './defaults.js';

void describe('generateBuildIdAndRedirectFunctionCode', () => {
  void it('emits build-id rewrite logic when no redirects', () => {
    const code = generateBuildIdAndRedirectFunctionCode('mybuild-1');
    assert.match(code, /\/builds\/mybuild-1/);
    assert.match(code, /index\.html/);
    // Should not include redirect table when empty.
    assert.doesNotMatch(code, /__redirects/);
  });

  void it('embeds redirect table when redirects provided', () => {
    const code = generateBuildIdAndRedirectFunctionCode('mybuild-1', [
      { source: '/old', destination: '/new', statusCode: 302 },
    ]);
    assert.match(code, /__redirects/);
    assert.match(code, /\/old/);
    assert.match(code, /\/new/);
    assert.match(code, /302/);
  });

  void it('throws on invalid build ID', () => {
    assert.throws(() => generateBuildIdAndRedirectFunctionCode('bad/id', []), {
      message: /Build ID must be alphanumeric/,
    });
  });

  void it('throws on >MAX redirects', () => {
    const many = Array.from(
      { length: MAX_REDIRECTS_IN_FUNCTION + 1 },
      (_, i) => ({
        source: `/x${i}`,
        destination: '/y',
        statusCode: 302 as const,
      }),
    );
    assert.throws(
      () => generateBuildIdAndRedirectFunctionCode('mybuild-1', many),
      { message: /CloudFront Functions are limited/ },
    );
  });

  void it('throws on invalid status code', () => {
    assert.throws(
      () =>
        generateBuildIdAndRedirectFunctionCode('mybuild-1', [
          // @ts-expect-error testing runtime validation
          { source: '/old', destination: '/new', statusCode: 200 },
        ]),
      { message: /not a redirect status/ },
    );
  });

  void describe('basePath canonical-redirect', () => {
    const evalFn = (
      code: string,
    ): ((event: {
      request: { uri: string; headers?: Record<string, { value: string }> };
    }) => unknown) =>
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      new Function(`${code}\nreturn handler;`)() as never;

    void it('bare / 308-redirects to <basePath>/', () => {
      const code = generateBuildIdAndRedirectFunctionCode(
        'mybuild-1',
        [],
        '/app',
      );
      const handler = evalFn(code);
      const result = handler({ request: { uri: '/', headers: {} } }) as {
        statusCode?: number;
        headers?: { location: { value: string } };
      };
      assert.equal(result.statusCode, 308);
      assert.equal(result.headers?.location.value, '/app/');
    });

    void it('bare /about 308-redirects to <basePath>/about', () => {
      const code = generateBuildIdAndRedirectFunctionCode(
        'mybuild-1',
        [],
        '/app',
      );
      const handler = evalFn(code);
      const result = handler({
        request: { uri: '/about', headers: {} },
      }) as {
        statusCode?: number;
        headers?: { location: { value: string } };
      };
      assert.equal(result.statusCode, 308);
      assert.equal(result.headers?.location.value, '/app/about');
    });

    void it('basePath-prefixed URI passes through to build-id rewrite', () => {
      const code = generateBuildIdAndRedirectFunctionCode(
        'mybuild-1',
        [],
        '/app',
      );
      const handler = evalFn(code);
      const result = handler({
        request: { uri: '/app/about', headers: {} },
      }) as { uri?: string; statusCode?: number };
      assert.equal(result.statusCode, undefined);
      assert.match(result.uri ?? '', /\/builds\/mybuild-1\/about/);
    });

    void it('exact basePath URI passes through (does not redirect to itself)', () => {
      const code = generateBuildIdAndRedirectFunctionCode(
        'mybuild-1',
        [],
        '/app',
      );
      const handler = evalFn(code);
      const result = handler({
        request: { uri: '/app', headers: {} },
      }) as { uri?: string; statusCode?: number };
      assert.equal(result.statusCode, undefined);
    });
  });

  void describe('spaFallback option', () => {
    const evalFn = (
      code: string,
    ): ((event: {
      request: { uri: string; headers?: Record<string, { value: string }> };
    }) => unknown) =>
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      new Function(`${code}\nreturn handler;`)() as never;

    void it('rewrites extensionless paths to /index.html when spaFallback=true', () => {
      const code = generateBuildIdAndRedirectFunctionCode(
        'mybuild-1',
        [],
        undefined,
        { spaFallback: true },
      );
      const handler = evalFn(code);
      const result = handler({
        request: { uri: '/about', headers: {} },
      }) as { uri: string };
      assert.equal(result.uri, '/builds/mybuild-1/index.html');
    });

    void it('preserves paths with file extensions when spaFallback=true', () => {
      const code = generateBuildIdAndRedirectFunctionCode(
        'mybuild-1',
        [],
        undefined,
        { spaFallback: true },
      );
      const handler = evalFn(code);
      const result = handler({
        request: { uri: '/static/app.js', headers: {} },
      }) as { uri: string };
      assert.equal(result.uri, '/builds/mybuild-1/static/app.js');
    });

    void it('maintains existing directory rewrite when spaFallback=false (default)', () => {
      const code = generateBuildIdAndRedirectFunctionCode('mybuild-1');
      const handler = evalFn(code);
      const result = handler({
        request: { uri: '/about', headers: {} },
      }) as { uri: string };
      assert.equal(result.uri, '/builds/mybuild-1/about/index.html');
    });

    void it('does NOT rewrite .well-known paths when spaFallback=true', () => {
      const code = generateBuildIdAndRedirectFunctionCode(
        'mybuild-1',
        [],
        undefined,
        { spaFallback: true },
      );
      const handler = evalFn(code);
      const result = handler({
        request: { uri: '/.well-known/acme-challenge', headers: {} },
      }) as { uri: string };
      assert.equal(result.uri, '/builds/mybuild-1/.well-known/acme-challenge');
    });
  });
});

void describe('generateForwardedHostAndRedirectFunctionCode', () => {
  void it('emits forwarded-host logic by default', () => {
    const code = generateForwardedHostAndRedirectFunctionCode();
    assert.match(code, /x-forwarded-host/);
    assert.doesNotMatch(code, /__redirects/);
  });

  void it('embeds redirect table alongside forwarded-host', () => {
    const code = generateForwardedHostAndRedirectFunctionCode([
      { source: '/old/*', destination: '/new/*', statusCode: 308 },
    ]);
    assert.match(code, /x-forwarded-host/);
    assert.match(code, /__redirects/);
    assert.match(code, /308/);
  });

  void describe('basePath canonical-redirect on compute behaviors', () => {
    const evalFn = (
      code: string,
    ): ((event: {
      request: { uri: string; headers?: Record<string, { value: string }> };
    }) => unknown) =>
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      new Function(`${code}\nreturn handler;`)() as never;

    void it('bare / 308-redirects to <basePath>/', () => {
      const code = generateForwardedHostAndRedirectFunctionCode([], '/app');
      const handler = evalFn(code);
      const result = handler({
        request: { uri: '/', headers: { host: { value: 'x.cf.net' } } },
      }) as {
        statusCode?: number;
        headers?: { location: { value: string } };
      };
      assert.equal(result.statusCode, 308);
      assert.equal(result.headers?.location.value, '/app/');
    });

    void it('bare /about 308-redirects to <basePath>/about', () => {
      const code = generateForwardedHostAndRedirectFunctionCode([], '/app');
      const handler = evalFn(code);
      const result = handler({
        request: { uri: '/about', headers: { host: { value: 'x.cf.net' } } },
      }) as {
        statusCode?: number;
        headers?: { location: { value: string } };
      };
      assert.equal(result.statusCode, 308);
      assert.equal(result.headers?.location.value, '/app/about');
    });

    void it('basePath-prefixed URI passes through with x-forwarded-host', () => {
      const code = generateForwardedHostAndRedirectFunctionCode([], '/app');
      const handler = evalFn(code);
      const result = handler({
        request: {
          uri: '/app/about',
          headers: { host: { value: 'x.cf.net' } },
        },
      }) as {
        statusCode?: number;
        uri?: string;
        headers?: Record<string, { value: string }>;
      };
      assert.equal(result.statusCode, undefined);
      assert.equal(result.headers?.['x-forwarded-host']?.value, 'x.cf.net');
    });
  });
});

void describe('redirect runtime semantics (executed against the generated code)', () => {
  // Helper: extract the function body and run it with a stubbed event.
  const evalFn = (
    code: string,
  ): ((event: {
    request: { uri: string; headers?: Record<string, { value: string }> };
  }) => unknown) => {
    // The generated code defines `function handler(event) { ... }`.
    // Wrap in IIFE that returns the handler.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    return new Function(`${code}\nreturn handler;`)() as never;
  };

  void it('exact match returns 30x', () => {
    const code = generateForwardedHostAndRedirectFunctionCode([
      { source: '/old', destination: '/new', statusCode: 301 },
    ]);
    const handler = evalFn(code);
    const result = handler({ request: { uri: '/old', headers: {} } }) as {
      statusCode?: number;
      headers?: { location: { value: string } };
    };
    assert.equal(result.statusCode, 301);
    assert.equal(result.headers?.location.value, '/new');
  });

  void it('non-matching URI passes through (no redirect)', () => {
    const code = generateForwardedHostAndRedirectFunctionCode([
      { source: '/old', destination: '/new', statusCode: 301 },
    ]);
    const handler = evalFn(code);
    const result = handler({
      request: {
        uri: '/something-else',
        headers: { host: { value: 'x.example.com' } },
      },
    }) as {
      uri?: string;
      statusCode?: number;
      headers?: Record<string, { value: string }>;
    };
    // The handler should return the request (with x-forwarded-host attached).
    // No statusCode means it fell through.
    assert.equal(result.statusCode, undefined);
    assert.equal(result.headers?.['x-forwarded-host']?.value, 'x.example.com');
  });

  void it('suffix wildcard matches and tail is forwarded', () => {
    const code = generateForwardedHostAndRedirectFunctionCode([
      { source: '/old/*', destination: '/new/*', statusCode: 308 },
    ]);
    const handler = evalFn(code);
    const result = handler({
      request: { uri: '/old/foo/bar', headers: {} },
    }) as {
      statusCode?: number;
      headers?: { location: { value: string } };
    };
    assert.equal(result.statusCode, 308);
    assert.equal(result.headers?.location.value, '/new/foo/bar');
  });

  void it('suffix wildcard with non-wildcard destination drops the tail', () => {
    const code = generateForwardedHostAndRedirectFunctionCode([
      { source: '/old/*', destination: '/about', statusCode: 302 },
    ]);
    const handler = evalFn(code);
    const result = handler({
      request: { uri: '/old/anything', headers: {} },
    }) as {
      headers?: { location: { value: string } };
    };
    assert.equal(result.headers?.location.value, '/about');
  });

  // Regression (Finding 3): an exact hit on the wildcard prefix (empty tail)
  // must not leak the literal '*' into the destination.
  void it('empty tail does NOT leak a literal * into the destination', () => {
    const code = generateForwardedHostAndRedirectFunctionCode([
      { source: '/old/*', destination: '/new/*', statusCode: 308 },
    ]);
    const handler = evalFn(code);
    const result = handler({
      request: { uri: '/old/', headers: {} },
    }) as { headers?: { location: { value: string } } };
    assert.equal(result.headers?.location.value, '/new/');
    assert.ok(!result.headers?.location.value.includes('*'));
  });
});

void describe('generateAssetPrefixStripFunctionCode (B17)', () => {
  // Helper: extract the function body and run it.
  const evalFn = (
    code: string,
  ): ((event: { request: { uri: string } }) => unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    return new Function(`${code}\nreturn handler;`)() as never;
  };

  void it('strips a leading prefix and prepends build ID', () => {
    const code = generateAssetPrefixStripFunctionCode('build1', '/shop-static');
    const handler = evalFn(code);
    const result = handler({
      request: { uri: '/shop-static/_next/static/chunks/abc.js' },
    }) as { uri: string };
    assert.equal(result.uri, '/builds/build1/_next/static/chunks/abc.js');
  });

  void it('handles bare prefix → /builds/<id>/index.html', () => {
    const code = generateAssetPrefixStripFunctionCode('build1', '/shop-static');
    const handler = evalFn(code);
    const result = handler({
      request: { uri: '/shop-static' },
    }) as { uri: string };
    assert.equal(result.uri, '/builds/build1/index.html');
  });

  void it('passes through non-matching URI unchanged (only prepends build ID)', () => {
    const code = generateAssetPrefixStripFunctionCode('build1', '/shop-static');
    const handler = evalFn(code);
    const result = handler({
      request: { uri: '/_next/static/chunks/abc.js' },
    }) as { uri: string };
    assert.equal(result.uri, '/builds/build1/_next/static/chunks/abc.js');
  });

  void it('throws on invalid build ID', () => {
    assert.throws(
      () => generateAssetPrefixStripFunctionCode('bad/id', '/foo'),
      { message: /Build ID must be alphanumeric/ },
    );
  });

  void it('throws on prefix without leading slash', () => {
    assert.throws(
      () => generateAssetPrefixStripFunctionCode('build1', 'shop-static'),
      { message: /assetPrefix must start with/ },
    );
  });

  void it('throws on prefix with trailing slash', () => {
    assert.throws(
      () => generateAssetPrefixStripFunctionCode('build1', '/shop/'),
      { message: /not end with/ },
    );
  });
});
