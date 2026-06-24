import { describe, it } from 'node:test';
import assert from 'node:assert';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import {
  Code,
  FunctionUrlAuthType,
  InvokeMode,
  Function as LambdaFunction,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { CdnConstruct } from './cdn_construct.js';
import { createSecurityHeadersPolicy } from './security_headers.js';
import { DeployManifest } from '../manifest/types.js';
import { HostingError } from '../hosting_error.js';
import {
  generateSkewProtectionViewerRequestCode,
  generateSkewProtectionViewerResponseCode,
} from './skew_protection.js';
import {
  buildKvsEntries,
  generateKvsRouterRequestCode,
} from './kvs_router.js';

// ---- Test helpers ----

const createStack = (): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack');
};

const spaManifest: DeployManifest = {
  version: 1,
  compute: {},
  staticAssets: { directory: '/tmp/assets' },
  routes: [{ pattern: '/*', target: 'static' }],
  buildId: 'test-spa-1',
};

const ssrManifest: DeployManifest = {
  version: 1,
  compute: {
    default: {
      type: 'handler',
      bundle: '/tmp/bundle',
      handler: 'index.handler',
      placement: 'regional',
    },
  },
  staticAssets: { directory: '/tmp/assets' },
  routes: [
    { pattern: '/_next/static/*', target: 'static' },
    { pattern: '/favicon.ico', target: 'static' },
    { pattern: '/*', target: 'default' },
  ],
  buildId: 'test-ssr-1',
};

const createSsrFunction = (stack: Stack) => {
  const fn = new LambdaFunction(stack, 'SsrFn', {
    runtime: Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: Code.fromInline('exports.handler = async () => {};'),
  });
  const fnUrl = fn.addFunctionUrl({
    authType: FunctionUrlAuthType.AWS_IAM,
    invokeMode: InvokeMode.RESPONSE_STREAM,
  });
  return { fn, fnUrl };
};

// ================================================================
// Skew Protection — CloudFront Function code generation tests
// ================================================================

void describe('Skew Protection — Code Generation', () => {
  void describe('generateSkewProtectionViewerRequestCode', () => {
    void it('produces valid function code with build ID baked in', () => {
      const code = generateSkewProtectionViewerRequestCode('abc-123');
      assert.ok(code.includes("var buildId = 'abc-123'"));
      assert.ok(code.includes('function handler(event)'));
      assert.ok(code.includes('__dpl'));
      assert.ok(code.includes('/builds/'));
    });

    void it('uses CloudFront Functions cookies API to read __dpl', () => {
      const code = generateSkewProtectionViewerRequestCode('current-build');
      assert.ok(code.includes("request.cookies['__dpl']"));
      assert.ok(code.includes('cookie.value'));
      assert.ok(code.includes("var buildId = 'current-build'"));
    });

    void it('appends index.html for directory-style paths', () => {
      const code = generateSkewProtectionViewerRequestCode('build-1');
      assert.ok(code.includes("uri = uri + 'index.html'"));
    });

    void it('appends /index.html for bare paths without file extension', () => {
      const code = generateSkewProtectionViewerRequestCode('build-1');
      assert.ok(
        code.includes(
          "var lastSegment = uri.substring(uri.lastIndexOf('/') + 1)",
        ),
      );
      assert.ok(code.includes("if (lastSegment.indexOf('.') === -1)"));
      assert.ok(code.includes("uri = uri + '/index.html'"));
    });

    void it('rewrites extensionless paths to /index.html when spaFallback is enabled', () => {
      const code = generateSkewProtectionViewerRequestCode('build-1', [], {
        spaFallback: true,
      });
      assert.ok(code.includes("uri = '/index.html'"));
      assert.ok(!code.includes("uri = uri + '/index.html'"));
    });

    void it('does not rewrite paths with extensions when spaFallback is enabled', () => {
      const code = generateSkewProtectionViewerRequestCode('build-1', [], {
        spaFallback: true,
      });
      assert.ok(
        code.includes("var hasExtension = lastSegment.indexOf('.') !== -1"),
      );
      assert.ok(code.includes('if (!hasExtension'));
    });

    void it('does not rewrite .well-known paths when spaFallback is enabled', () => {
      const code = generateSkewProtectionViewerRequestCode('build-1', [], {
        spaFallback: true,
      });
      assert.ok(
        code.includes("var isWellKnown = uri.startsWith('/.well-known/')"),
      );
      assert.ok(code.includes('!isWellKnown'));
      // Verify with actual execution
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const handler = new Function(`${code}\nreturn handler;`)() as (event: {
        request: { uri: string; cookies: Record<string, unknown> };
      }) => { uri: string };
      const result = handler({
        request: { uri: '/.well-known/acme-challenge', cookies: {} },
      });
      assert.ok(
        !result.uri.endsWith('/index.html'),
        '.well-known paths must NOT be rewritten to /index.html',
      );
    });

    void it('throws for invalid build ID', () => {
      assert.throws(
        () => generateSkewProtectionViewerRequestCode('invalid build!'),
        (err: unknown) =>
          err instanceof HostingError && err.name === 'InvalidBuildIdError',
      );
    });

    void it('throws for empty build ID', () => {
      assert.throws(
        () => generateSkewProtectionViewerRequestCode(''),
        (err: unknown) =>
          err instanceof HostingError && err.name === 'InvalidBuildIdError',
      );
    });

    void it('handles build ID with max length (64 chars)', () => {
      const longId = 'a'.repeat(64);
      const code = generateSkewProtectionViewerRequestCode(longId);
      assert.ok(code.includes(longId));
    });

    void it('includes redirect logic when redirects are provided', () => {
      const redirects = [
        {
          source: '/old-page',
          destination: '/new-page',
          statusCode: 301 as const,
        },
      ];
      const code = generateSkewProtectionViewerRequestCode(
        'build-1',
        redirects,
      );
      assert.ok(code.includes('__redirects'));
      assert.ok(code.includes('/old-page'));
      assert.ok(code.includes('/new-page'));
      assert.ok(code.includes('301'));
      assert.ok(code.includes('Redirect'));
    });

    void it('places redirect check before cookie/build-id logic', () => {
      const redirects = [
        {
          source: '/moved',
          destination: '/destination',
          statusCode: 302 as const,
        },
      ];
      const code = generateSkewProtectionViewerRequestCode(
        'build-1',
        redirects,
      );
      const redirectIdx = code.indexOf('__redirects');
      const cookieIdx = code.indexOf('__dpl');
      assert.ok(
        redirectIdx < cookieIdx,
        'Redirects must be checked before cookie logic',
      );
    });

    void it('generates no redirect logic when redirects array is empty', () => {
      const code = generateSkewProtectionViewerRequestCode('build-1', []);
      assert.ok(!code.includes('__redirects'));
    });

    void it('handles wildcard redirect sources', () => {
      const redirects = [
        {
          source: '/blog/*',
          destination: '/posts/*',
          statusCode: 308 as const,
        },
      ];
      const code = generateSkewProtectionViewerRequestCode(
        'build-1',
        redirects,
      );
      assert.ok(code.includes('/blog/*'));
      assert.ok(code.includes('/posts/*'));
    });

    void it('throws for too many redirects (over 100)', () => {
      const redirects = Array.from({ length: 101 }, (_, i) => ({
        source: `/src-${i}`,
        destination: `/dst-${i}`,
        statusCode: 301 as const,
      }));
      assert.throws(
        () => generateSkewProtectionViewerRequestCode('build-1', redirects),
        (err: unknown) =>
          err instanceof HostingError && err.name === 'TooManyRedirectsError',
      );
    });

    void it('strips basePath before build-id rewrite when basePath is set', () => {
      const code = generateSkewProtectionViewerRequestCode('build-1', [], {
        basePath: '/app',
      });
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const handler = new Function(`${code}\nreturn handler;`)() as (event: {
        request: { uri: string; cookies: Record<string, unknown> };
      }) => { uri: string } | { statusCode: number };
      const result = handler({
        request: { uri: '/app/about/', cookies: {} },
      });
      assert.strictEqual(
        (result as { uri: string }).uri,
        '/builds/build-1/about/index.html',
        'basePath /app must be stripped so /app/about/ resolves to /builds/build-1/about/index.html',
      );
    });

    void it('redirects requests without basePath prefix to basePath-prefixed URL', () => {
      const code = generateSkewProtectionViewerRequestCode('build-1', [], {
        basePath: '/app',
      });
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const handler = new Function(`${code}\nreturn handler;`)() as (event: {
        request: { uri: string; cookies: Record<string, unknown> };
      }) => { statusCode: number; headers: { location: { value: string } } };
      const result = handler({
        request: { uri: '/', cookies: {} },
      });
      assert.strictEqual(result.statusCode, 308);
      assert.strictEqual(result.headers.location.value, '/app/');
    });

    void it('does not include basePath logic when basePath is not set', () => {
      const code = generateSkewProtectionViewerRequestCode('build-1', []);
      assert.ok(!code.includes('__bp'));
    });
  });

  void describe('generateSkewProtectionViewerResponseCode', () => {
    void it('produces valid function code that sets cookie on HTML', () => {
      const code = generateSkewProtectionViewerResponseCode('abc-123');
      assert.ok(code.includes('function handler(event)'));
      assert.ok(code.includes('text/html'));
      assert.ok(code.includes("response.cookies['__dpl']"));
      assert.ok(code.includes("value: 'abc-123'"));
      assert.ok(code.includes('Path=/'));
      assert.ok(code.includes('SameSite=Lax'));
      assert.ok(code.includes('Max-Age=86400'));
    });

    void it('uses custom maxAge when provided', () => {
      const code = generateSkewProtectionViewerResponseCode('build-x', 3600);
      assert.ok(code.includes('Max-Age=3600'));
    });

    void it('checks content-type header for text/html', () => {
      const code = generateSkewProtectionViewerResponseCode('build-1');
      assert.ok(code.includes("contentType.indexOf('text/html') >= 0"));
    });

    void it('does not set cookie on non-HTML responses (logic check)', () => {
      const code = generateSkewProtectionViewerResponseCode('build-1');
      assert.ok(code.includes("if (contentType.indexOf('text/html') >= 0)"));
    });

    void it('throws for invalid build ID', () => {
      assert.throws(
        () => generateSkewProtectionViewerResponseCode('bad build!!'),
        (err: unknown) =>
          err instanceof HostingError && err.name === 'InvalidBuildIdError',
      );
    });

    void it('throws for negative maxAge', () => {
      assert.throws(
        () => generateSkewProtectionViewerResponseCode('build-1', -1),
        (err: unknown) =>
          err instanceof HostingError &&
          err.name === 'InvalidSkewProtectionMaxAgeError',
      );
    });

    void it('throws for maxAge exceeding 30 days', () => {
      assert.throws(
        () => generateSkewProtectionViewerResponseCode('build-1', 2592001),
        (err: unknown) =>
          err instanceof HostingError &&
          err.name === 'InvalidSkewProtectionMaxAgeError',
      );
    });

    void it('accepts maxAge of 0', () => {
      const code = generateSkewProtectionViewerResponseCode('build-1', 0);
      assert.ok(code.includes('Max-Age=0'));
    });
  });
});

// ================================================================
// Skew Protection — CDN Construct integration tests
// ================================================================

void describe('Skew Protection — CdnConstruct Integration', () => {
  void describe('SPA mode with skew protection enabled', () => {
    void it('creates skew protection request function instead of simple rewrite', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        skewProtection: { enabled: true },
      });

      const template = Template.fromStack(stack);
      // Should have skew protection function with cookie logic
      template.hasResourceProperties('AWS::CloudFront::Function', {
        FunctionCode: Match.stringLikeRegexp('__dpl'),
      });
    });

    void it('creates viewer-response function for cookie setting', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        skewProtection: { enabled: true },
      });

      const template = Template.fromStack(stack);
      // Should have response function that sets the cookie via cookies API
      template.hasResourceProperties('AWS::CloudFront::Function', {
        FunctionCode: Match.stringLikeRegexp('response\\.cookies'),
      });
    });

    void it('attaches both functions to the default behavior', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        skewProtection: { enabled: true },
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            FunctionAssociations: Match.arrayWith([
              Match.objectLike({ EventType: 'viewer-request' }),
              Match.objectLike({ EventType: 'viewer-response' }),
            ]),
          }),
        }),
      });
    });

    void it('uses custom maxAge in cookie', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        skewProtection: { enabled: true, maxAge: 7200 },
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Function', {
        FunctionCode: Match.stringLikeRegexp('Max-Age=7200'),
      });
    });
  });

  void describe('SPA mode without skew protection', () => {
    void it('does not SET the skew cookie when skew protection is off', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        skewProtection: { enabled: false },
      });

      const template = Template.fromStack(stack);
      // The KVS edge router always ships both router functions. The request
      // function always READS the __dpl cookie (to honor a pinned build), but
      // when skew is off the response function must NOT SET it.
      const functions = template.findResources('AWS::CloudFront::Function');
      /* eslint-disable @typescript-eslint/naming-convention */
      const functionCodes = Object.values(functions).map(
        (f: Record<string, unknown>) =>
          (f as { Properties: { FunctionCode: string } }).Properties
            .FunctionCode,
      );
      /* eslint-enable @typescript-eslint/naming-convention */
      const setsCookie = functionCodes.some((code) =>
        code.includes("response.cookies['__dpl']"),
      );
      assert.strictEqual(
        setsCookie,
        false,
        'response function must not set the __dpl cookie when skew is disabled',
      );
    });

    void it('still associates both router functions (request + response) to the default behavior', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        skewProtection: { enabled: false },
      });

      const template = Template.fromStack(stack);
      // The single-behavior KVS router ALWAYS wires viewer-request (origin
      // selection + build-id rewrite) and viewer-response (per-pattern
      // headers). The response function exists regardless of skew; only the
      // cookie-set logic inside it is gated.
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            FunctionAssociations: Match.arrayWith([
              Match.objectLike({ EventType: 'viewer-request' }),
              Match.objectLike({ EventType: 'viewer-response' }),
            ]),
          }),
        }),
      });
    });
  });

  void describe('SSR mode with skew protection enabled', () => {
    void it('attaches viewer-response function to compute behavior', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: ssrManifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
        skewProtection: { enabled: true },
      });

      const template = Template.fromStack(stack);
      // Default behavior (SSR) should have viewer-response for cookie
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            FunctionAssociations: Match.arrayWith([
              Match.objectLike({ EventType: 'viewer-response' }),
            ]),
          }),
        }),
      });
    });

    void it('attaches skew protection viewer-request to static behaviors', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: ssrManifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
        skewProtection: { enabled: true },
      });

      const template = Template.fromStack(stack);
      // Static behavior should have the skew protection function
      template.hasResourceProperties('AWS::CloudFront::Function', {
        FunctionCode: Match.stringLikeRegexp('__dpl'),
      });
    });

    void it('creates exactly 2 KVS-associated router functions (KvsRouterRequest + KvsRouterResponse)', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});
      const { fn, fnUrl } = createSsrFunction(stack);

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: ssrManifest,
        securityHeadersPolicy: policy,
        computeFunctionUrls: new Map([['default', fnUrl]]),
        computeFunctions: new Map([['default', fn]]),
        skewProtection: { enabled: true },
      });

      const template = Template.fromStack(stack);
      // The single KVS edge router replaces the per-event functions
      // (request/response/forwarded-host) with two build-independent
      // functions: KvsRouterRequest and KvsRouterResponse. Forwarded-host and
      // build-id rewrite are folded into the request function. Both use the
      // cloudfront-js-2.0 runtime with a KeyValueStore association. A third
      // function (SentinelGuard) exists ONLY on compute deploys to 403 direct
      // hits to the origin-binding sentinel behaviors — it has NO KVS
      // association, which is exactly how we discriminate it here.
      const functions = template.findResources('AWS::CloudFront::Function');
      const kvsRouterFns = Object.values(functions).filter((fnRes) => {
        const config = (fnRes as { Properties: { FunctionConfig: Record<string, unknown> } })
          .Properties.FunctionConfig;
        return (
          Array.isArray(config.KeyValueStoreAssociations) &&
          (config.KeyValueStoreAssociations as unknown[]).length === 1
        );
      });
      assert.strictEqual(kvsRouterFns.length, 2);
      for (const fnRes of kvsRouterFns) {
        const config = (fnRes as { Properties: { FunctionConfig: Record<string, unknown> } })
          .Properties.FunctionConfig;
        assert.strictEqual(config.Runtime, 'cloudfront-js-2.0');
      }
    });
  });

  void describe('skewProtection: { enabled: false }', () => {
    void it('does not set the skew cookie (same as omitting the prop)', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: spaManifest,
        securityHeadersPolicy: policy,
        skewProtection: { enabled: false },
      });

      const template = Template.fromStack(stack);
      const functions = template.findResources('AWS::CloudFront::Function');
      /* eslint-disable @typescript-eslint/naming-convention */
      const functionCodes = Object.values(functions).map(
        (f: Record<string, unknown>) =>
          (f as { Properties: { FunctionCode: string } }).Properties
            .FunctionCode,
      );
      /* eslint-enable @typescript-eslint/naming-convention */
      // The router functions always exist; the discriminator for "skew off" is
      // that the response function does not SET the __dpl cookie.
      const setsCookie = functionCodes.some((code) =>
        code.includes("response.cookies['__dpl']"),
      );
      assert.strictEqual(setsCookie, false);
    });
  });

  void describe('Skew protection with manifest redirects', () => {
    void it('stores redirects in the KVS route table (d-keys), not baked into the function', () => {
      const stack = createStack();
      const bucket = new Bucket(stack, 'Bucket');
      const policy = createSecurityHeadersPolicy(stack, 'SH', {});

      const manifestWithRedirects: DeployManifest = {
        ...spaManifest,
        redirects: [{ source: '/old', destination: '/new', statusCode: 301 }],
      };

      new CdnConstruct(stack, 'Cdn', {
        bucket,
        manifest: manifestWithRedirects,
        securityHeadersPolicy: policy,
        skewProtection: { enabled: true },
      });

      const template = Template.fromStack(stack);
      // Redirects are now KVS data (d0..dN chunks) evaluated by the router's
      // viewer-request function — carried by the RouteStoreKeys custom
      // resource, not baked into the function source.
      template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
        Entries: Match.stringLikeRegexp('/old'),
      });

      const entries = buildKvsEntries({
        manifest: manifestWithRedirects,
        buildId: 'test-spa-1',
        hasServer: false,
        hasImage: false,
      });
      const redirectJson = Object.entries(entries)
        .filter(([k]) => /^d\d+$/.test(k))
        .map(([, v]) => v)
        .join('');
      assert.match(redirectJson, /\/old/);
      assert.match(redirectJson, /\/new/);
      assert.match(redirectJson, /301/);
    });

    void it('the router request function evaluates redirects before the build-id cookie read', () => {
      // Ordering is now a property of the (build-independent) router function:
      // it scans redirect chunks before resolving the build-id from the __dpl
      // cookie. Assert on the generated source ordering directly.
      const code = generateKvsRouterRequestCode();
      const redirectIdx = code.indexOf("getJson('d'");
      const cookieIdx = code.indexOf("request.cookies['__dpl']");
      assert.ok(redirectIdx >= 0, 'request function must read redirect chunks');
      assert.ok(cookieIdx >= 0, 'request function must read the __dpl cookie');
      assert.ok(
        redirectIdx < cookieIdx,
        'redirect evaluation must precede the build-id cookie read',
      );
    });
  });
});
