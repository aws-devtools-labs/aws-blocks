import { describe, it } from 'node:test';
import assert from 'node:assert';
import { deployManifestSchema } from './schema.js';
import { DeployManifest } from './types.js';

void describe('Deploy Manifest Schema', () => {
  void it('validates a valid SPA manifest', () => {
    const manifest: DeployManifest = {
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [
        {
          pattern: '/*',
          target: 'static',
        },
      ],
    };

    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(result.success, 'Valid SPA manifest should parse');
    assert.deepStrictEqual(result.data, manifest);
  });

  void it('validates a valid SSR manifest with compute resources', () => {
    const manifest: DeployManifest = {
      version: 1,
      compute: {
        default: {
          type: 'handler',
          bundle: '/tmp/bundle',
          handler: 'index.handler',
          placement: 'regional',
          streaming: true,
          runtime: 'nodejs24.x',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/*', target: 'default' },
      ],
      buildId: 'abc123',
    };

    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(result.success, 'Valid SSR manifest should parse');
  });

  void it('validates manifest with cache config', () => {
    const manifest: DeployManifest = {
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
      routes: [{ pattern: '/*', target: 'default' }],
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: true,
      },
    };

    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(result.success, 'Manifest with cache config should parse');
  });

  void it('validates manifest with cache config including revalidationFunction', () => {
    const manifest: DeployManifest = {
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
      routes: [{ pattern: '/*', target: 'default' }],
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: true,
        revalidationFunction: {
          bundle: '/tmp/revalidation-fn',
          handler: 'index.handler',
        },
      },
    };

    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(
      result.success,
      'Manifest with cache config including revalidationFunction should parse',
    );
  });

  void it('validates manifest with image optimization', () => {
    const manifest: DeployManifest = {
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'static' }],
      imageOptimization: {
        bundle: '/tmp/image-fn',
        handler: 'index.handler',
        formats: ['webp', 'avif'],
        sizes: [640, 1080, 1920],
      },
    };

    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(result.success, 'Manifest with image optimization should parse');
  });

  void it('validates manifest with image optimization domains allowlist', () => {
    const manifest: DeployManifest = {
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'static' }],
      imageOptimization: {
        bundle: '/tmp/image-fn',
        handler: 'index.handler',
        formats: ['webp'],
        sizes: [640],
        domains: ['cdn.example.com', 'images.example.org'],
      },
    };

    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(result.success, 'imageOptimization.domains should parse');
  });

  void it('validates manifest with image optimization safety knobs (Piece 4)', () => {
    const manifest: DeployManifest = {
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'static' }],
      imageOptimization: {
        bundle: '/tmp/image-fn',
        handler: 'index.handler',
        formats: ['webp'],
        sizes: [640],
        remotePatterns: [
          { hostname: 'images.example.org' },
          {
            protocol: 'https',
            hostname: 'cdn.example.com',
            pathname: '/img/*',
          },
        ],
        dangerouslyAllowSVG: true,
        minimumCacheTTL: 60,
      },
    };
    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(result.success, 'image safety knobs should parse');
  });

  void it('validates manifest with no image safety knobs (back-compat)', () => {
    const manifest: DeployManifest = {
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'static' }],
      imageOptimization: {
        bundle: '/tmp/image-fn',
        handler: 'index.handler',
        formats: ['webp'],
        sizes: [640],
      },
    };
    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(result.success, 'baseline image config still parses');
  });

  void it('rejects remotePattern missing hostname', () => {
    const manifest: DeployManifest = {
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'static' }],
      imageOptimization: {
        bundle: '/tmp/image-fn',
        handler: 'index.handler',
        formats: ['webp'],
        sizes: [640],
        // @ts-expect-error — exercising schema validation on a bad input
        remotePatterns: [{ protocol: 'https' }],
      },
    };
    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(!result.success, 'hostname is required on remotePattern');
  });

  void it('validates manifest with basePath (Piece 1)', () => {
    const manifest: DeployManifest = {
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'static' }],
      basePath: '/app',
    };
    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(result.success, 'basePath should parse');
  });

  void it('rejects basePath with trailing slash', () => {
    const manifest: DeployManifest = {
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'static' }],
      basePath: '/app/',
    };
    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(!result.success, 'basePath must not end with /');
  });

  void it('validates manifest with middleware', () => {
    const manifest: DeployManifest = {
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'static' }],
      middleware: {
        bundle: '/tmp/middleware',
        handler: 'handler.handler',
        matchers: ['/*'],
      },
    };

    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(result.success, 'Manifest with middleware should parse');
  });

  void it('rejects manifest with wrong version', () => {
    const result = deployManifestSchema.safeParse({
      version: 2,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'static' }],
    });
    assert.ok(!result.success, 'Should reject version != 1');
  });

  void it('rejects manifest with no routes', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [],
    });
    assert.ok(!result.success, 'Should reject empty routes');
  });

  void it('rejects route with empty pattern', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '', target: 'static' }],
    });
    assert.ok(!result.success, 'Should reject empty pattern');
  });

  void it('rejects route with empty target', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: '' }],
    });
    assert.ok(!result.success, 'Should reject empty target');
  });

  void it('rejects compute resource with invalid type', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        default: {
          type: 'invalid',
          bundle: '/tmp/bundle',
          placement: 'regional',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'default' }],
    });
    assert.ok(!result.success, 'Should reject invalid compute type');
  });

  void it('rejects compute resource with invalid placement', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        default: {
          type: 'handler',
          bundle: '/tmp/bundle',
          placement: 'somewhere',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'default' }],
    });
    assert.ok(!result.success, 'Should reject invalid placement');
  });

  void it('accepts manifest with all optional fields omitted', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'static' }],
    });
    assert.ok(
      result.success,
      'Should accept manifest with only required fields',
    );
    assert.strictEqual(result.data?.cache, undefined);
    assert.strictEqual(result.data?.imageOptimization, undefined);
    assert.strictEqual(result.data?.middleware, undefined);
    assert.strictEqual(result.data?.buildId, undefined);
  });

  void it('validates http-server compute type', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        default: {
          type: 'http-server',
          bundle: '/tmp/bundle',
          entrypoint: 'server.js',
          port: 3000,
          placement: 'regional',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'default' }],
    });
    assert.ok(result.success, 'Should accept http-server compute type');
  });

  void it('validates edge compute type', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        default: {
          type: 'edge',
          bundle: '/tmp/bundle',
          handler: 'index.handler',
          placement: 'global',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'default' }],
    });
    assert.ok(result.success, 'Should accept edge compute type');
  });

  void it('validates redirects', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'static' }],
      redirects: [
        { source: '/old', destination: '/new', statusCode: 301 },
        { source: '/temp', destination: '/other', statusCode: 302 },
      ],
    });
    assert.ok(result.success, 'Should accept valid redirects');
  });

  void it('validates rewrites', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'static' }],
      rewrites: [{ source: '/api/*', destination: '/api/handler' }],
    });
    assert.ok(result.success, 'Should accept valid rewrites');
  });

  void it('validates custom headers', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {},
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'static' }],
      headers: [{ source: '/*', headers: { 'X-Custom': 'value' } }],
    });
    assert.ok(result.success, 'Should accept valid custom headers');
  });

  // ---- Route target validation (refine) ----

  void it('rejects route target that does not match any compute resource', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        server: {
          type: 'handler',
          bundle: '/tmp/bundle',
          handler: 'index.handler',
          placement: 'regional',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/api/*', target: 'nonexistent-compute' },
        { pattern: '/*', target: 'server' },
      ],
      buildId: 'test-1',
    });
    assert.ok(!result.success, 'Should reject route targeting missing compute');
    const errorMessage = result.error?.issues[0]?.message ?? '';
    assert.ok(
      errorMessage.includes('Route target must reference'),
      `Expected refine error, got: ${errorMessage}`,
    );
  });

  void it('accepts route targets matching compute keys or reserved targets', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        server: {
          type: 'handler',
          bundle: '/tmp/bundle',
          handler: 'index.handler',
          placement: 'regional',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/assets/*', target: 's3' },
        { pattern: '/_next/image/*', target: 'image-optimization' },
        { pattern: '/*', target: 'server' },
      ],
      buildId: 'test-1',
    });
    assert.ok(
      result.success,
      'Should accept routes with valid compute keys and reserved targets',
    );
  });

  // ---- Handler field validation (superRefine) ----

  void it('rejects compute resource with type "handler" but no handler field', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        default: {
          type: 'handler',
          bundle: '/tmp/bundle',
          placement: 'regional',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'default' }],
    });
    assert.ok(
      !result.success,
      'Should reject handler type without handler field',
    );
    const handlerIssue = result.error?.issues.find(
      (i) => i.message === 'handler field is required when type is "handler"',
    );
    assert.ok(
      handlerIssue,
      `Expected handler validation issue, got: ${JSON.stringify(result.error?.issues)}`,
    );
  });

  void it('accepts compute resource with type "edge" without handler field', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        default: {
          type: 'edge',
          bundle: '/tmp/bundle',
          placement: 'global',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'default' }],
    });
    assert.ok(result.success, 'Edge type should not require handler field');
  });

  void it('accepts compute resource with type "http-server" without handler field', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        default: {
          type: 'http-server',
          bundle: '/tmp/bundle',
          entrypoint: 'server.js',
          port: 3000,
          placement: 'regional',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'default' }],
    });
    assert.ok(
      result.success,
      'http-server type should not require handler field',
    );
  });

  // ---- http-server entrypoint validation ----

  void it('rejects http-server type without handler or entrypoint', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        default: {
          type: 'http-server',
          bundle: '/tmp/bundle',
          port: 3000,
          placement: 'regional',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'default' }],
    });
    assert.ok(
      !result.success,
      'Should reject http-server without handler or entrypoint',
    );
    const issue = result.error?.issues.find((i) =>
      i.message.includes('http-server type requires'),
    );
    assert.ok(
      issue,
      `Expected http-server validation issue, got: ${JSON.stringify(result.error?.issues)}`,
    );
  });

  void it('accepts http-server type with handler instead of entrypoint', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        default: {
          type: 'http-server',
          bundle: '/tmp/bundle',
          handler: 'index.handler',
          port: 3000,
          placement: 'regional',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'default' }],
    });
    assert.ok(
      result.success,
      'http-server type should accept handler as alternative to entrypoint',
    );
  });

  // ---- Edge placement validation ----

  void it('rejects edge type with regional placement', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        default: {
          type: 'edge',
          bundle: '/tmp/bundle',
          handler: 'index.handler',
          placement: 'regional',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [{ pattern: '/*', target: 'default' }],
    });
    assert.ok(
      !result.success,
      'Should reject edge type with regional placement',
    );
    const issue = result.error?.issues.find((i) =>
      i.message.includes('edge type requires placement'),
    );
    assert.ok(
      issue,
      `Expected edge placement validation issue, got: ${JSON.stringify(result.error?.issues)}`,
    );
  });

  // ---- Duplicate route pattern validation ----

  void it('rejects manifest with duplicate route patterns', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        server: {
          type: 'handler',
          bundle: '/tmp/bundle',
          handler: 'index.handler',
          placement: 'regional',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [
        { pattern: '/api/*', target: 'server' },
        { pattern: '/api/*', target: 'server' },
        { pattern: '/*', target: 'static' },
      ],
    });
    assert.ok(!result.success, 'Should reject duplicate route patterns');
    const issue = result.error?.issues.find((i) =>
      i.message.includes('Duplicate route patterns'),
    );
    assert.ok(
      issue,
      `Expected duplicate routes issue, got: ${JSON.stringify(result.error?.issues)}`,
    );
    assert.ok(
      issue?.message.includes('/api/*'),
      `Should mention the duplicate pattern, got: ${issue?.message}`,
    );
  });

  void it('accepts manifest with unique route patterns', () => {
    const result = deployManifestSchema.safeParse({
      version: 1,
      compute: {
        server: {
          type: 'handler',
          bundle: '/tmp/bundle',
          handler: 'index.handler',
          placement: 'regional',
        },
      },
      staticAssets: { directory: '/tmp/assets' },
      routes: [
        { pattern: '/api/*', target: 'server' },
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/*', target: 'server' },
      ],
    });
    assert.ok(result.success, 'Should accept unique route patterns');
  });
});
