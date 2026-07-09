import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from './spawn.js';
import {
  hasExistingMiddlewareManifest,
  nextjsAdapter,
  patchEdgeBundlesForLambdaEdge,
  patchImageOptimizerForNext16,
  patchStreamingWrapperForApiGateway,
  projectHasEdgeRuntimeRoutes,
  stripNextInternalLocale,
  stripBasePathPrefix,
  stripBakedBasePath,
  nextPatternToCloudFront,
} from './nextjs.js';
import { deployManifestSchema } from '../manifest/schema.js';
import type { DeployManifest } from '../manifest/types.js';

void describe('nextjsAdapter', () => {
  let tmpDir: string;
  let lenientBackup: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nextjs-test-'));
    // Mock the spawn wrapper so OpenNext build doesn't actually run
    mock.method(spawn, 'sync', () => undefined);
    // The fixture stubs don't include OpenNext's streaming-wrapper or
    // edge-banner signatures, so the brittleness-throw path would fire
    // under the synthesized inputs. The patches are not under test here;
    // run them in lenient mode so the manifest-translation assertions
    // get to run.
    lenientBackup = process.env.HOSTING_LENIENT_PATCHES;
    process.env.HOSTING_LENIENT_PATCHES = '1';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
    if (lenientBackup === undefined) {
      delete process.env.HOSTING_LENIENT_PATCHES;
    } else {
      process.env.HOSTING_LENIENT_PATCHES = lenientBackup;
    }
  });

  void it('translates OpenNext output to DeployManifest', () => {
    // Set up a mock .open-next/ directory with output manifest
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(openNextDir, { recursive: true });

    // Create server-functions/default directory
    const defaultFnDir = path.join(openNextDir, 'server-functions', 'default');
    fs.mkdirSync(defaultFnDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultFnDir, 'index.mjs'),
      'export const handler = async () => {};',
    );

    // Create assets directory
    const assetsDir = path.join(openNextDir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'index.html'), '<html></html>');

    // Create open-next.output.json
    const outputManifest = {
      origins: {
        default: {
          type: 'function',
          handler: 'index.handler',
          streaming: true,
        },
      },
      behaviors: [
        { pattern: '/_next/static/*', origin: 's3' },
        { pattern: '/*', origin: 'default' },
      ],
      additionalProps: {},
    };
    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify(outputManifest),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    assert.strictEqual(manifest.version, 1);

    // Should have a default compute resource
    assert.ok(manifest.compute['default']);
    assert.strictEqual(manifest.compute['default'].type, 'handler');
    assert.strictEqual(manifest.compute['default'].handler, 'index.handler');
    assert.strictEqual(manifest.compute['default'].streaming, true);
    assert.strictEqual(manifest.compute['default'].placement, 'regional');

    // Should have routes
    assert.ok(manifest.routes.length >= 2);
    const staticRoute = manifest.routes.find(
      (r) => r.pattern === '/_next/static/*',
    );
    assert.ok(staticRoute);
    assert.strictEqual(staticRoute!.target, 's3');

    const catchAllRoute = manifest.routes.find((r) => r.pattern === '/*');
    assert.ok(catchAllRoute);
    assert.strictEqual(catchAllRoute!.target, 'default');

    // Static assets directory
    assert.strictEqual(manifest.staticAssets.directory, assetsDir);

    // The adapter does NOT hardcode invalidationPaths — deploy-time
    // invalidation is scoped on `hasCompute` in the L3 (it is not
    // Next-specific; Nuxt swr/isr and Astro SSR hit the same stale-HTML 403).
    // The field is reserved for adapter overrides/opt-out only.
    assert.strictEqual(manifest.invalidationPaths, undefined);
  });

  void it('detects ISR cache when not disabled', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
    // ISR evidence: revalidation-function directory exists
    fs.mkdirSync(path.join(openNextDir, 'revalidation-function'), {
      recursive: true,
    });

    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: { type: 'function', handler: 'index.handler' },
        },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: {},
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    assert.ok(manifest.cache);
    assert.strictEqual(manifest.cache!.tagRevalidation, true);
    assert.strictEqual(manifest.cache!.revalidationQueue, true);
    assert.strictEqual(manifest.cache!.computeResource, 'default');
    assert.ok(
      manifest.cache!.revalidationFunction,
      'Should include revalidation function when revalidation-function dir exists',
    );
    assert.strictEqual(
      manifest.cache!.revalidationFunction!.handler,
      'index.handler',
    );
    assert.ok(
      manifest.cache!.revalidationFunction!.bundle.includes(
        'revalidation-function',
      ),
    );
  });

  void it('does not provision DynamoDB when disableTagCache is set', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(openNextDir, 'revalidation-function'), {
      recursive: true,
    });
    // S3 incremental cache stays; only the tag cache is disabled.
    fs.mkdirSync(path.join(openNextDir, 'cache'), { recursive: true });

    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: { default: { type: 'function', handler: 'index.handler' } },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: { disableTagCache: true },
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    assert.ok(manifest.cache, 'incremental cache still provisioned');
    assert.strictEqual(
      manifest.cache!.tagRevalidation,
      false,
      'tag cache (DynamoDB) must be off when disableTagCache is set',
    );
    assert.strictEqual(
      manifest.cache!.initFunction,
      undefined,
      'no tag-table seeder when tag cache is disabled',
    );
    // S3 incremental cache seeding is unaffected.
    assert.ok(manifest.cache!.seedDirectory);
  });

  void it('surfaces the ISR cache seed dir + tag-table init function', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
    // Prebuilt ISR cache dir (what seeds the S3 bucket).
    fs.mkdirSync(path.join(openNextDir, 'cache', 'BUILDID', 'products'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'cache', 'BUILDID', 'products', '0.cache'),
      '{"type":"app","html":"<html></html>","rsc":""}',
    );
    // dynamodb-provider bundle (the tag-table seeder custom resource).
    fs.mkdirSync(path.join(openNextDir, 'dynamodb-provider'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'dynamodb-provider', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.writeFileSync(
      path.join(openNextDir, 'dynamodb-provider', 'dynamodb-cache.json'),
      '[]',
    );

    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: { default: { type: 'function', handler: 'index.handler' } },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: {
          initializationFunction: {
            handler: 'index.handler',
            bundle: '.open-next/dynamodb-provider',
          },
        },
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    assert.ok(manifest.cache);
    assert.ok(
      manifest.cache!.seedDirectory?.endsWith('cache'),
      'seedDirectory points at .open-next/cache',
    );
    assert.ok(
      manifest.cache!.initFunction?.bundle.includes('dynamodb-provider'),
      'initFunction bundle points at dynamodb-provider',
    );
    assert.strictEqual(manifest.cache!.initFunction!.handler, 'index.handler');
    assert.doesNotThrow(() => deployManifestSchema.parse(manifest));
  });

  void it('omits init function when OpenNext emits no initializationFunction', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(openNextDir, 'cache'), { recursive: true });
    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: { default: { type: 'function', handler: 'index.handler' } },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: {},
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.ok(manifest.cache!.seedDirectory);
    assert.strictEqual(manifest.cache!.initFunction, undefined);
  });

  void it('does not add cache when ISR is disabled', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });

    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: { type: 'function', handler: 'index.handler' },
        },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: { disableIncrementalCache: true },
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(manifest.cache, undefined);
  });

  void it('detects image optimization function', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });

    // Create image optimization function directory
    const imgDir = path.join(openNextDir, 'image-optimization-function');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(
      path.join(imgDir, 'index.mjs'),
      'export const handler = async () => {};',
    );

    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: { type: 'function', handler: 'index.handler' },
        },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: {},
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    assert.ok(manifest.imageOptimization);
    assert.strictEqual(manifest.imageOptimization!.bundle, imgDir);
    assert.strictEqual(manifest.imageOptimization!.handler, 'index.handler');
    assert.deepStrictEqual(manifest.imageOptimization!.formats, [
      'webp',
      'avif',
    ]);
  });

  void it('detects middleware', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });

    // Create middleware directory
    const mwDir = path.join(openNextDir, 'middleware');
    fs.mkdirSync(mwDir, { recursive: true });
    fs.writeFileSync(
      path.join(mwDir, 'handler.mjs'),
      'export const handler = async () => {};',
    );

    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: { type: 'function', handler: 'index.handler' },
        },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: {},
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    assert.ok(manifest.middleware);
    assert.strictEqual(manifest.middleware!.bundle, mwDir);
    assert.strictEqual(manifest.middleware!.handler, 'handler.handler');
  });

  void it('throws when open-next output is missing', () => {
    assert.throws(
      () => nextjsAdapter({ projectDir: tmpDir, skipBuild: true }),
      (error: Error) => {
        assert.strictEqual(error.name, 'OpenNextOutputNotFoundError');
        return true;
      },
    );
  });

  void it('handles http-server origin type', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'server.js'),
      'const http = require("http");',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });

    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: {
            type: 'ecs',
            entrypoint: 'server.js',
            port: 8080,
            streaming: false,
          },
        },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: {},
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    assert.ok(manifest.compute['default']);
    assert.strictEqual(manifest.compute['default'].type, 'http-server');
    assert.strictEqual(manifest.compute['default'].entrypoint, 'server.js');
    assert.strictEqual(manifest.compute['default'].port, 8080);
    assert.strictEqual(manifest.compute['default'].streaming, false);
  });

  void it('handles edge origin type', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });

    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: {
            type: 'edge',
            handler: 'index.handler',
          },
        },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: {},
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    assert.ok(manifest.compute['default']);
    assert.strictEqual(manifest.compute['default'].type, 'edge');
    assert.strictEqual(manifest.compute['default'].placement, 'global');
  });

  void it('skips s3 origin in compute mapping', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });

    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          s3: { type: 'function' },
          default: { type: 'function', handler: 'index.handler' },
        },
        behaviors: [
          { pattern: '/_next/static/*', origin: 's3' },
          { pattern: '/*', origin: 'default' },
        ],
        additionalProps: {},
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    // s3 should not be in compute
    assert.strictEqual(manifest.compute['s3'], undefined);
    assert.ok(manifest.compute['default']);
  });

  void it('adds catch-all route if missing from behaviors', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });

    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: { type: 'function', handler: 'index.handler' },
        },
        behaviors: [
          { pattern: '/_next/static/*', origin: 's3' },
          { pattern: '/api/*', origin: 'default' },
        ],
        additionalProps: {},
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    const catchAll = manifest.routes.find((r) => r.pattern === '/*');
    assert.ok(catchAll, 'Should add catch-all route');
    assert.strictEqual(catchAll!.target, 'default');
  });

  void it('adapter output passes schema validation', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(openNextDir, 'assets', 'index.html'),
      '<html></html>',
    );

    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: {
            type: 'function',
            handler: 'index.handler',
            streaming: true,
          },
        },
        behaviors: [
          { pattern: '/_next/static/*', origin: 's3' },
          { pattern: '/*', origin: 'default' },
        ],
        additionalProps: {},
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });
    const result = deployManifestSchema.safeParse(manifest);
    assert.ok(
      result.success,
      `Schema validation failed: ${JSON.stringify(result.error?.issues)}`,
    );
  });

  void it('lifts simple redirects from routes-manifest.json', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: { type: 'function', handler: 'index.handler' },
        },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: {},
      }),
    );

    // Create .next/routes-manifest.json with various redirect types
    const dotNext = path.join(tmpDir, '.next');
    fs.mkdirSync(dotNext, { recursive: true });
    fs.writeFileSync(
      path.join(dotNext, 'routes-manifest.json'),
      JSON.stringify({
        redirects: [
          // Simple redirect — should be lifted
          { source: '/old', destination: '/new', statusCode: 301 },
          // Has condition — should be skipped
          {
            source: '/conditional',
            destination: '/target',
            statusCode: 302,
            has: [{ type: 'header', key: 'x-foo' }],
          },
          // Internal redirect — should be skipped
          {
            source: '/internal',
            destination: '/dest',
            statusCode: 308,
            internal: true,
          },
          // Unsupported status code — should be skipped
          { source: '/perm', destination: '/dest', statusCode: 200 },
          // Regex source — should be skipped
          {
            source: '/:path(\\d+)',
            destination: '/page',
            statusCode: 302,
          },
        ],
        headers: [
          // Simple header — should be lifted
          {
            source: '/api/*',
            headers: [
              { key: 'X-Custom-Header', value: 'my-value' },
              { key: 'Cache-Control', value: 'public, max-age=3600' },
            ],
          },
          // Has condition — should be skipped
          {
            source: '/guarded',
            has: [{ type: 'cookie', key: 'session' }],
            headers: [{ key: 'X-Guard', value: 'true' }],
          },
          // Complex source — should be skipped
          {
            source: '/dynamic/:slug*',
            headers: [{ key: 'X-Dynamic', value: 'yes' }],
          },
        ],
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    assert.ok(manifest.redirects, 'Should have lifted redirects');
    assert.strictEqual(manifest.redirects!.length, 1);
    assert.strictEqual(manifest.redirects![0].source, '/old');
    assert.strictEqual(manifest.redirects![0].destination, '/new');
    assert.strictEqual(manifest.redirects![0].statusCode, 301);

    assert.ok(manifest.headers, 'Should have lifted headers');
    assert.strictEqual(manifest.headers!.length, 1);
    assert.strictEqual(manifest.headers![0].source, '/api/*');
  });

  void it('detects basePath and trailingSlash from required-server-files.json', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: { type: 'function', handler: 'index.handler' },
        },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: {},
      }),
    );

    // Create .next/required-server-files.json with basePath and trailingSlash
    const dotNext = path.join(tmpDir, '.next');
    fs.mkdirSync(dotNext, { recursive: true });
    fs.writeFileSync(
      path.join(dotNext, 'required-server-files.json'),
      JSON.stringify({
        config: {
          basePath: '/docs',
          trailingSlash: true,
          assetPrefix: '/cdn-prefix',
        },
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    assert.strictEqual(manifest.basePath, '/docs');
    assert.strictEqual(manifest.assetPrefix, '/cdn-prefix');
  });

  void it('ignores absolute-URL assetPrefix', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: { type: 'function', handler: 'index.handler' },
        },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: {},
      }),
    );

    const dotNext = path.join(tmpDir, '.next');
    fs.mkdirSync(dotNext, { recursive: true });
    fs.writeFileSync(
      path.join(dotNext, 'required-server-files.json'),
      JSON.stringify({
        config: { assetPrefix: 'https://cdn.example.com' },
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(
      manifest.assetPrefix,
      undefined,
      'Absolute-URL assetPrefix should be ignored',
    );
  });

  void it('handles edgeFunctions in OpenNext output', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    // Create edge function bundle
    const edgeFnDir = path.join(openNextDir, 'server-functions', 'edgeFn1');
    fs.mkdirSync(edgeFnDir, { recursive: true });
    fs.writeFileSync(
      path.join(edgeFnDir, 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: { type: 'function', handler: 'index.handler' },
        },
        edgeFunctions: {
          edgeFn1: {
            bundle: '.open-next/server-functions/edgeFn1',
            handler: 'index.handler',
            runtime: 'nodejs20.x',
          },
        },
        behaviors: [
          { pattern: '/api/edge/*', edgeFunction: 'edgeFn1' },
          { pattern: '/*', origin: 'default' },
        ],
        additionalProps: {},
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    assert.ok(
      manifest.compute['edgeFn1'],
      'Should map edge function to compute',
    );
    assert.strictEqual(manifest.compute['edgeFn1'].type, 'edge');
    assert.strictEqual(manifest.compute['edgeFn1'].placement, 'global');

    const edgeRoute = manifest.routes.find((r) => r.pattern === '/api/edge/*');
    assert.ok(edgeRoute, 'Should have edge function route');
    assert.strictEqual(edgeRoute!.target, 'edgeFn1');
  });

  void it('detects image optimization function', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });

    // Create image optimization function with config
    const imgDir = path.join(openNextDir, 'image-optimization-function');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(
      path.join(imgDir, 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.writeFileSync(
      path.join(imgDir, 'config.json'),
      JSON.stringify({ formats: ['webp'], sizes: [640, 1080] }),
    );

    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: { type: 'function', handler: 'index.handler' },
          imageOptimizer: { type: 'function', handler: 'index.handler' },
        },
        behaviors: [
          { pattern: '/_next/image*', origin: 'imageOptimizer' },
          { pattern: '/*', origin: 'default' },
        ],
        additionalProps: {},
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });

    assert.ok(manifest.imageOptimization, 'Should detect image optimization');
    assert.deepStrictEqual(manifest.imageOptimization!.formats, ['webp']);
    assert.deepStrictEqual(manifest.imageOptimization!.sizes, [640, 1080]);
  });

  void it('handles ecs/docker origin type', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    const ecsDir = path.join(openNextDir, 'server-functions', 'ecs-origin');
    fs.mkdirSync(ecsDir, { recursive: true });
    fs.writeFileSync(path.join(ecsDir, 'server.js'), 'require("http")');
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });

    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          'ecs-origin': {
            type: 'ecs',
            entrypoint: 'server.js',
            port: 8080,
            streaming: true,
          },
        },
        behaviors: [{ pattern: '/*', origin: 'ecs-origin' }],
        additionalProps: {},
      }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.ok(manifest.compute['ecs-origin']);
    assert.strictEqual(manifest.compute['ecs-origin'].type, 'http-server');
    assert.strictEqual(
      (manifest.compute['ecs-origin'] as { port?: number }).port,
      8080,
    );
  });

  void it('handles trailingSlash false in required-server-files', () => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: {
          default: { type: 'function', handler: 'index.handler' },
        },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: {},
      }),
    );

    const dotNext = path.join(tmpDir, '.next');
    fs.mkdirSync(dotNext, { recursive: true });
    fs.writeFileSync(
      path.join(dotNext, 'required-server-files.json'),
      JSON.stringify({ config: { trailingSlash: false } }),
    );

    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.ok(manifest, 'Should produce manifest with trailingSlash false');
  });
});

void describe('hasExistingMiddlewareManifest', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nextjs-manifest-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  void it('returns false when .next/server/middleware-manifest.json is missing', () => {
    assert.strictEqual(hasExistingMiddlewareManifest(tmp), false);
  });

  void it('returns true when the manifest exists', () => {
    const dir = path.join(tmp, '.next', 'server');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'middleware-manifest.json'),
      JSON.stringify({ functions: {} }),
    );
    assert.strictEqual(hasExistingMiddlewareManifest(tmp), true);
  });
});

void describe('projectHasEdgeRuntimeRoutes', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nextjs-edge-scan-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const writeFile = (rel: string, contents: string): void => {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  };

  void it('returns false for a project with no source files', () => {
    assert.strictEqual(projectHasEdgeRuntimeRoutes(tmp), false);
  });

  void it('returns false when no file declares runtime: edge', () => {
    writeFile(
      'app/page.tsx',
      'export default function Page() { return null; }',
    );
    writeFile(
      'app/api/users/route.ts',
      'export async function GET() { return Response.json({}); }',
    );
    assert.strictEqual(projectHasEdgeRuntimeRoutes(tmp), false);
  });

  void it("returns true when a route declares runtime = 'edge' (App Router)", () => {
    writeFile(
      'app/api/edge/route.ts',
      "export const runtime = 'edge';\nexport async function GET() { return Response.json({}); }",
    );
    assert.strictEqual(projectHasEdgeRuntimeRoutes(tmp), true);
  });

  void it("returns true when a Pages Router api file declares runtime: 'experimental-edge'", () => {
    writeFile(
      'pages/api/edge.ts',
      "export const config = { runtime: 'experimental-edge' };\nexport default function handler() {}",
    );
    assert.strictEqual(projectHasEdgeRuntimeRoutes(tmp), true);
  });

  void it('scans src/app/ as well as app/', () => {
    writeFile(
      'src/app/api/edge/route.ts',
      "export const runtime = 'edge';\nexport async function GET() {}",
    );
    assert.strictEqual(projectHasEdgeRuntimeRoutes(tmp), true);
  });

  void it('skips node_modules and dot-prefixed directories', () => {
    // Edge declaration only inside node_modules — must not trigger.
    writeFile(
      'node_modules/some-pkg/edge.ts',
      "export const runtime = 'edge';",
    );
    writeFile('.next/cache/edge.ts', "export const runtime = 'edge';");
    assert.strictEqual(projectHasEdgeRuntimeRoutes(tmp), false);
  });

  void it('returns false if no app/ or pages/ directories exist', () => {
    writeFile('lib/util.ts', "export const runtime = 'edge';");
    assert.strictEqual(projectHasEdgeRuntimeRoutes(tmp), false);
  });
});

void describe('patchStreamingWrapperForApiGateway — brittleness gating', () => {
  let tmp: string;
  let defaultDir: string;
  let envBackup: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-patch-stream-'));
    defaultDir = path.join(tmp, 'server-functions', 'default');
    fs.mkdirSync(defaultDir, { recursive: true });
    envBackup = process.env.HOSTING_LENIENT_PATCHES;
    delete process.env.HOSTING_LENIENT_PATCHES;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (envBackup === undefined) {
      delete process.env.HOSTING_LENIENT_PATCHES;
    } else {
      process.env.HOSTING_LENIENT_PATCHES = envBackup;
    }
  });

  void it('throws UpstreamPatchPatternChangedError when no bundle matches', () => {
    fs.writeFileSync(
      path.join(defaultDir, 'index.mjs'),
      'export const handler = async () => ({});',
    );
    assert.throws(
      () => patchStreamingWrapperForApiGateway(tmp),
      (error: Error) => error.name === 'UpstreamPatchPatternChangedError',
    );
  });

  void it('HOSTING_LENIENT_PATCHES=1 reverts to a warning', () => {
    fs.writeFileSync(
      path.join(defaultDir, 'index.mjs'),
      'export const handler = async () => ({});',
    );
    process.env.HOSTING_LENIENT_PATCHES = '1';
    assert.doesNotThrow(() => patchStreamingWrapperForApiGateway(tmp));
  });

  void it('returns silently when server-functions dir is missing', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-empty-'));
    assert.doesNotThrow(() => patchStreamingWrapperForApiGateway(empty));
    fs.rmSync(empty, { recursive: true, force: true });
  });

  // U31: snapshot test against the canonical OpenNext aws-lambda-streaming
  // wrapper shape. We synthesize a bundle that contains the four signatures
  // the patcher recognizes (setContentType + the three Accept-Encoding
  // checks) and assert the patcher applies exactly the expected number of
  // edits AND produces byte-stable post-patch content. If a future OpenNext
  // upgrade reshuffles either the function-call form or the encoding-check
  // form, this test fails BEFORE a real customer deploy hits the same drift
  // — at which point the patcher needs updating to match.
  void it('canonical wrapper bundle: applies expected edits + post-patch is byte-stable', () => {
    // Synthetic bundle modeled on @opennextjs/aws@3.10.x's emitted
    // aws-lambda-streaming wrapper. Every line below maps to one of the
    // four signatures the patcher's regexes look for.
    const PRE = [
      '// canonical OpenNext aws-lambda-streaming wrapper shape',
      'const responseStream = awslambda.HttpResponseStream.from(rawStream, metadata);',
      'responseStream.setContentType("application/vnd.awslambda.http-integration-response")',
      'if (acceptEncoding.includes("br")) {',
      '  encodeStream = createBrotliCompress();',
      '} else if (acceptEncoding.includes("gzip")) {',
      '  encodeStream = createGzip();',
      '} else if (acceptEncoding.includes("deflate")) {',
      '  encodeStream = createDeflate();',
      '} else {',
      '  encodeStream = passThrough;',
      '}',
      'export const handler = streamifyResponse(awslambda, async (event, responseStream) => { /* ... */ });',
    ].join('\n');
    const bundle = path.join(defaultDir, 'index.mjs');
    fs.writeFileSync(bundle, PRE);
    assert.doesNotThrow(() => patchStreamingWrapperForApiGateway(tmp));
    const post = fs.readFileSync(bundle, 'utf-8');

    // setContentType call neutered to `void 0`.
    assert.match(post, /\bvoid 0\b/);
    assert.doesNotMatch(
      post,
      /setContentType\("application\/vnd\.awslambda\.http-integration-response"\)/,
    );
    // Accept-Encoding branches all neutered (none of br/gzip/deflate
    // remain as the literal `.includes("…")` check; replaced with a
    // sentinel that never matches a real Accept-Encoding header).
    for (const algo of ['br', 'gzip', 'deflate']) {
      assert.doesNotMatch(post, new RegExp(`\\.includes\\("${algo}"\\)`));
      assert.match(
        post,
        new RegExp(`\\.includes\\("__hosting_no_${algo}__"\\)`),
      );
    }
    // Snapshot: re-running the patcher against the post-patch bundle must
    // be a no-op (the regexes don't match anymore) — proves the patcher
    // is idempotent and not partially-undoing prior runs.
    const stat1 = fs.statSync(bundle).size;
    // Second run on the now-patched bundle: nothing left to match, but
    // because some other bundle in the tree DID match on the first run,
    // we don't expect a throw. Reset the dir + re-run on the patched
    // content alone to assert idempotency.
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-patch-idem-'));
    const dir2 = path.join(tmp2, 'server-functions', 'default');
    fs.mkdirSync(dir2, { recursive: true });
    fs.writeFileSync(path.join(dir2, 'index.mjs'), post);
    // The post-patch bundle has no canonical signatures left → throws
    // unless lenient mode is on. That's the desired behavior: idempotent
    // for the no-op case, loud for the regression case.
    assert.throws(
      () => patchStreamingWrapperForApiGateway(tmp2),
      (error: Error) => error.name === 'UpstreamPatchPatternChangedError',
    );
    fs.rmSync(tmp2, { recursive: true, force: true });

    // Sanity: post-patch byte-count is non-zero and the file shrunk
    // (`void 0` < the original setContentType call). Exact size depends
    // on synth content above; we assert structural shape, not a magic
    // number that future refactors would have to keep updated.
    assert.ok(stat1 > 0);
    assert.ok(
      stat1 < PRE.length,
      `expected post-patch (${stat1}) < pre-patch (${PRE.length})`,
    );
  });
});

void describe('patchImageOptimizerForNext16 — fetchInternalImage arity', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-patch-img-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const writeBundle = (contents: string): string => {
    const dir = path.join(tmp, 'image-optimization-function');
    fs.mkdirSync(dir, { recursive: true });
    const bundle = path.join(dir, 'index.mjs');
    fs.writeFileSync(bundle, contents);
    return bundle;
  };

  // Write a fake project whose node_modules/next reports `version`, so the
  // adapter's version gate (semver.major(next) < 16 ⇒ skip) can be exercised.
  const writeProjectWithNext = (version: string): string => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-proj-'));
    const nextPkgDir = path.join(projectDir, 'node_modules', 'next');
    fs.mkdirSync(nextPkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(nextPkgDir, 'package.json'),
      JSON.stringify({ name: 'next', version }),
    );
    return projectDir;
  };

  void it('returns silently when the image-optimization-function dir is absent', () => {
    // image optimization disabled for this app → nothing to patch
    assert.doesNotThrow(() => patchImageOptimizerForNext16(tmp));
  });

  void it('inserts `void 0` so the request handler lands in the 5th slot', () => {
    const bundle = writeBundle(
      'var x=await(0,Pc.fetchInternalImage)(n,{headers:e},{},i),o=await Pc.imageOptimizer(x);',
    );
    patchImageOptimizerForNext16(tmp);
    const out = fs.readFileSync(bundle, 'utf-8');
    assert.match(out, /fetchInternalImage\)\(n,\{headers:e\},\{\},void 0,i\)/);
  });

  void it('is idempotent — a second run does not double-insert', () => {
    const bundle = writeBundle(
      'await(0,Pc.fetchInternalImage)(n,{headers:e},{},i);',
    );
    patchImageOptimizerForNext16(tmp);
    const once = fs.readFileSync(bundle, 'utf-8');
    patchImageOptimizerForNext16(tmp);
    const twice = fs.readFileSync(bundle, 'utf-8');
    assert.equal(once, twice);
    // exactly one `void 0` inserted into the call
    assert.equal((twice.match(/\{\},void 0,/g) || []).length, 1);
  });

  void it('warns (does not throw) when no matching call is present', () => {
    writeBundle('export const handler = async () => ({}); // already adapted\n');
    assert.doesNotThrow(() => patchImageOptimizerForNext16(tmp));
  });

  // ── Version gate (regression: Next 15.x must NOT be patched) ──────────
  // The maximumResponseBody arg was added in Next 16, not 15.5. On Next 15.x
  // OpenNext's 4-arg call is already correct; inserting `void 0` there broke
  // every local image (500 TypeError). See patchImageOptimizerForNext16.

  void it('does NOT patch on Next 15.x (4-arg signature is already correct)', () => {
    const bundle = writeBundle(
      'var x=await(0,Pc.fetchInternalImage)(n,{headers:e},{},i);',
    );
    const projectDir = writeProjectWithNext('15.5.15');
    patchImageOptimizerForNext16(tmp, projectDir);
    const out = fs.readFileSync(bundle, 'utf-8');
    // untouched — no `void 0` shoved into the call
    assert.doesNotMatch(out, /\{\},void 0,/);
    assert.match(out, /fetchInternalImage\)\(n,\{headers:e\},\{\},i\)/);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  void it('DOES patch on Next 16.x (5-arg signature needs the extra slot)', () => {
    const bundle = writeBundle(
      'var x=await(0,Pc.fetchInternalImage)(n,{headers:e},{},i);',
    );
    const projectDir = writeProjectWithNext('16.2.9');
    patchImageOptimizerForNext16(tmp, projectDir);
    const out = fs.readFileSync(bundle, 'utf-8');
    assert.match(out, /fetchInternalImage\)\(n,\{headers:e\},\{\},void 0,i\)/);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  void it('patches when the Next version is unknown (default to Next 16 behavior)', () => {
    const bundle = writeBundle(
      'var x=await(0,Pc.fetchInternalImage)(n,{headers:e},{},i);',
    );
    // projectDir points at an empty dir → no resolvable `next` → default patch
    const emptyProject = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-empty-'));
    patchImageOptimizerForNext16(tmp, emptyProject);
    const out = fs.readFileSync(bundle, 'utf-8');
    assert.match(out, /fetchInternalImage\)\(n,\{headers:e\},\{\},void 0,i\)/);
    fs.rmSync(emptyProject, { recursive: true, force: true });
  });
});

void describe('patchEdgeBundlesForLambdaEdge — brittleness gating', () => {
  let tmp: string;
  let envBackup: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-patch-edge-'));
    envBackup = process.env.HOSTING_LENIENT_PATCHES;
    delete process.env.HOSTING_LENIENT_PATCHES;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (envBackup === undefined) {
      delete process.env.HOSTING_LENIENT_PATCHES;
    } else {
      process.env.HOSTING_LENIENT_PATCHES = envBackup;
    }
  });

  void it('returns silently when there are no edge bundles', () => {
    fs.mkdirSync(path.join(tmp, 'server-functions', 'default'), {
      recursive: true,
    });
    assert.doesNotThrow(() => patchEdgeBundlesForLambdaEdge(tmp));
  });

  void it('throws UpstreamPatchPatternChangedError when bundles exist but banner is gone', () => {
    const dir = path.join(tmp, 'server-functions', 'edge-default');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.mjs'),
      'export const handler = async () => ({}); // no banner here\n',
    );
    assert.throws(
      () => patchEdgeBundlesForLambdaEdge(tmp),
      (error: Error) => error.name === 'UpstreamPatchPatternChangedError',
    );
  });

  void it('HOSTING_LENIENT_PATCHES=1 reverts to a warning', () => {
    const dir = path.join(tmp, 'server-functions', 'edge-default');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'index.mjs'),
      'export const handler = async () => ({});\n',
    );
    process.env.HOSTING_LENIENT_PATCHES = '1';
    assert.doesNotThrow(() => patchEdgeBundlesForLambdaEdge(tmp));
  });

  void it('successfully patches a bundle that has the banner', () => {
    const dir = path.join(tmp, 'server-functions', 'edge-default');
    fs.mkdirSync(dir, { recursive: true });
    const bundle = path.join(dir, 'index.mjs');
    fs.writeFileSync(
      bundle,
      'import * as process from "node:process";\nexport const handler = async () => ({});',
    );
    assert.doesNotThrow(() => patchEdgeBundlesForLambdaEdge(tmp));
    const patched = fs.readFileSync(bundle, 'utf-8');
    assert.match(
      patched,
      /const process = \(await import\("node:process"\)\)\.default;/,
    );
  });
});

void describe('detectEdgeRoutes — multi-matcher edge functions', () => {
  let tmp: string;
  let manifestPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-edge-mm-'));
    fs.mkdirSync(path.join(tmp, '.next', 'server'), { recursive: true });
    manifestPath = path.join(
      tmp,
      '.next',
      'server',
      'middleware-manifest.json',
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  void it('emits one EdgeRoute per matcher (not just matchers[0])', async () => {
    // Next's matcher.originalSource carries path-to-regexp tokens
    // (`:path*`). The existing nextPatternToCloudFront translator
    // only collapses Next file-system tokens (`[name]`, `[...name]`),
    // so path-to-regexp passes through unchanged. The fix under test
    // is that ALL matchers (not just matchers[0]) are emitted.
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        functions: {
          'src/middleware': {
            name: 'src/middleware',
            matchers: [
              { originalSource: '/admin/:path*' },
              { originalSource: '/api/admin/:path*' },
              { originalSource: '/dashboard' },
            ],
          },
        },
      }),
    );
    const { detectEdgeRoutes } = await import('./nextjs.js');
    const routes = detectEdgeRoutes(tmp);
    assert.strictEqual(routes.length, 3, JSON.stringify(routes));
    const patterns = routes.map((r) => r.pattern).sort();
    assert.deepStrictEqual(
      patterns,
      ['/admin/:path*', '/api/admin/:path*', '/dashboard'].sort(),
    );
    assert.ok(routes.every((r) => r.module === 'src/middleware'));
  });

  void it('translates Next file-system tokens ([name] / [...name]) per matcher', async () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        functions: {
          'src/middleware': {
            name: 'src/middleware',
            matchers: [
              { originalSource: '/api/[locale]/admin' },
              { originalSource: '/blog/[...slug]' },
            ],
          },
        },
      }),
    );
    const { detectEdgeRoutes } = await import('./nextjs.js');
    const routes = detectEdgeRoutes(tmp);
    assert.deepStrictEqual(routes.map((r) => r.pattern).sort(), [
      '/api/*/admin',
      '/blog/*',
    ]);
  });

  void it('skips matcher entries missing originalSource without dropping siblings', async () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        functions: {
          'src/middleware': {
            name: 'src/middleware',
            matchers: [
              { originalSource: '/keep-me' },
              {
                /* malformed: no originalSource */
              },
              { originalSource: '/also-keep' },
            ],
          },
        },
      }),
    );
    const { detectEdgeRoutes } = await import('./nextjs.js');
    const routes = detectEdgeRoutes(tmp);
    assert.strictEqual(routes.length, 2);
    assert.deepStrictEqual(routes.map((r) => r.pattern).sort(), [
      '/also-keep',
      '/keep-me',
    ]);
  });

  void it('skips function entries without a name', async () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        functions: {
          unnamed: { matchers: [{ originalSource: '/lost' }] },
          named: { name: 'named', matchers: [{ originalSource: '/found' }] },
        },
      }),
    );
    const { detectEdgeRoutes } = await import('./nextjs.js');
    const routes = detectEdgeRoutes(tmp);
    assert.strictEqual(routes.length, 1);
    assert.strictEqual(routes[0].pattern, '/found');
  });

  void it('returns [] when manifest is missing (no edge routes in project)', async () => {
    const { detectEdgeRoutes } = await import('./nextjs.js');
    assert.deepStrictEqual(detectEdgeRoutes(tmp), []);
  });

  void it('preserves existing single-matcher behavior', async () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        functions: {
          'src/middleware': {
            name: 'src/middleware',
            matchers: [{ originalSource: '/api/edge/[id]' }],
          },
        },
      }),
    );
    const { detectEdgeRoutes } = await import('./nextjs.js');
    const routes = detectEdgeRoutes(tmp);
    assert.deepStrictEqual(routes, [
      { module: 'src/middleware', pattern: '/api/edge/*' },
    ]);
  });
});

void describe('stripNextInternalLocale — Pages Router i18n source rewrite', () => {
  void it('strips a locale group with a sub-path', () => {
    assert.strictEqual(
      stripNextInternalLocale(
        '/:nextInternalLocale(en|fr|es|ja)/secure-headers',
      ),
      '/secure-headers',
    );
  });

  void it('maps a bare locale-only source to /', () => {
    assert.strictEqual(
      stripNextInternalLocale('/:nextInternalLocale(en|fr|es|ja)'),
      '/',
    );
    assert.strictEqual(
      stripNextInternalLocale('/:nextInternalLocale(en|fr|es|ja)/'),
      '/',
    );
  });

  void it('preserves trailing wildcards', () => {
    assert.strictEqual(
      stripNextInternalLocale('/:nextInternalLocale(en|fr|es|ja)/api/edge/*'),
      '/api/edge/*',
    );
  });

  void it('passes non-i18n sources through unchanged', () => {
    assert.strictEqual(
      stripNextInternalLocale('/secure-headers'),
      '/secure-headers',
    );
    assert.strictEqual(stripNextInternalLocale('/'), '/');
    assert.strictEqual(stripNextInternalLocale('/api/edge/*'), '/api/edge/*');
  });

  void it('does not alter sources with other capture groups', () => {
    // No nextInternalLocale prefix — leave untouched.
    assert.strictEqual(
      stripNextInternalLocale('/:slug(foo|bar)'),
      '/:slug(foo|bar)',
    );
  });
});

void describe('nextjsAdapter — Pages Router i18n header lift', () => {
  let tmpDir: string;
  let lenientBackup: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nextjs-i18n-'));
    mock.method(spawn, 'sync', () => undefined);
    lenientBackup = process.env.HOSTING_LENIENT_PATCHES;
    process.env.HOSTING_LENIENT_PATCHES = '1';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
    if (lenientBackup === undefined) {
      delete process.env.HOSTING_LENIENT_PATCHES;
    } else {
      process.env.HOSTING_LENIENT_PATCHES = lenientBackup;
    }
  });

  /**
   * Build the minimal `.open-next/` + `.next/routes-manifest.json`
   * fixture that nextjsAdapter accepts. Caller passes the routes-manifest
   * contents.
   */
  const writeFixture = (routesManifest: object): void => {
    const openNextDir = path.join(tmpDir, '.open-next');
    fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(openNextDir, 'open-next.output.json'),
      JSON.stringify({
        origins: { default: { type: 'function', handler: 'index.handler' } },
        behaviors: [{ pattern: '/*', origin: 'default' }],
        additionalProps: {},
      }),
    );
    const dotNextDir = path.join(tmpDir, '.next');
    fs.mkdirSync(dotNextDir, { recursive: true });
    fs.writeFileSync(
      path.join(dotNextDir, 'routes-manifest.json'),
      JSON.stringify(routesManifest),
    );
  };

  void it('lifts headers when the user has Pages Router i18n configured', () => {
    writeFixture({
      i18n: { locales: ['en', 'fr', 'es', 'ja'] },
      headers: [
        {
          source: '/:nextInternalLocale(en|fr|es|ja)/secure-headers',
          headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
        },
      ],
    });
    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.ok(manifest.headers, 'headers should be lifted');
    const lifted = manifest.headers!.find(
      (h) => h.source === '/secure-headers',
    );
    assert.ok(lifted, '/secure-headers should be lifted from the locale group');
    assert.strictEqual(lifted!.headers['X-Frame-Options'], 'DENY');
  });

  void it('lifts redirects with both source and destination locale-prefixed', () => {
    writeFixture({
      i18n: { locales: ['en', 'fr'] },
      redirects: [
        {
          source: '/:nextInternalLocale(en|fr)/old',
          destination: '/:nextInternalLocale(en|fr)/new',
          statusCode: 308,
        },
      ],
    });
    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.ok(manifest.redirects, 'redirects should be lifted');
    const lifted = manifest.redirects!.find((r) => r.source === '/old');
    assert.ok(lifted);
    assert.strictEqual(lifted!.destination, '/new');
    assert.strictEqual(lifted!.statusCode, 308);
  });

  void it('does NOT strip the locale group when i18n is not configured', () => {
    // A header source carrying `:nextInternalLocale(...)` without an
    // `i18n.locales` block is unexpected — leave it as-is so it falls
    // through to OpenNext (defensive).
    writeFixture({
      headers: [
        {
          source: '/:nextInternalLocale(en|fr)/secure-headers',
          headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
        },
      ],
    });
    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.strictEqual(
      manifest.headers,
      undefined,
      'no headers should lift without i18n config',
    );
  });

  void it('passes through non-i18n header sources unchanged', () => {
    writeFixture({
      i18n: { locales: ['en', 'fr'] },
      headers: [
        {
          source: '/api/static',
          headers: [{ key: 'X-Custom', value: 'yes' }],
        },
      ],
    });
    const manifest = nextjsAdapter({ projectDir: tmpDir, skipBuild: true });
    assert.ok(manifest.headers);
    assert.strictEqual(manifest.headers!.length, 1);
    assert.strictEqual(manifest.headers![0].source, '/api/static');
  });
});

void describe('nextjsAdapter — incompatible open-next.config.ts', () => {
  let tmpDir: string;
  let lenientBackup: string | undefined;
  let buildOutputCreator: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nextjs-config-'));
    buildOutputCreator = undefined;
    mock.method(spawn, 'sync', () => {
      buildOutputCreator?.();
    });
    lenientBackup = process.env.HOSTING_LENIENT_PATCHES;
    process.env.HOSTING_LENIENT_PATCHES = '1';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
    if (lenientBackup === undefined) {
      delete process.env.HOSTING_LENIENT_PATCHES;
    } else {
      process.env.HOSTING_LENIENT_PATCHES = lenientBackup;
    }
  });

  void it('throws IncompatibleOpenNextConfigError when user config lacks both overrides', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'open-next.config.ts'),
      `// User-authored config, no overrides
const config = { default: {} };
export default config;
`,
    );
    assert.throws(() => nextjsAdapter({ projectDir: tmpDir }), {
      code: 'IncompatibleOpenNextConfigError',
    });
  });

  void it('throws when user config has converter override but is missing the streaming wrapper', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'open-next.config.ts'),
      `const config = {
  default: { override: { converter: 'aws-apigw-v1' } },
};
export default config;
`,
    );
    assert.throws(() => nextjsAdapter({ projectDir: tmpDir }), {
      code: 'IncompatibleOpenNextConfigError',
    });
  });

  void it('accepts a user config that contains both required override tokens', () => {
    // Set up minimum OpenNext output so the adapter doesn't fail
    // post-config-check on a missing build artefact.
    fs.writeFileSync(
      path.join(tmpDir, 'open-next.config.ts'),
      `const config = {
  default: { override: { converter: 'aws-apigw-v1', wrapper: 'aws-lambda-streaming' } },
};
export default config;
`,
    );
    buildOutputCreator = () => {
      const openNextDir = path.join(tmpDir, '.open-next');
      fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
        'export const handler = async () => {};',
      );
      fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
      fs.writeFileSync(
        path.join(openNextDir, 'open-next.output.json'),
        JSON.stringify({
          origins: { default: { type: 'function', handler: 'index.handler' } },
          behaviors: [{ pattern: '/*', origin: 'default' }],
          additionalProps: {},
        }),
      );
    };
    assert.doesNotThrow(() => nextjsAdapter({ projectDir: tmpDir }));
  });

  void it("accepts OpenNext's native 'aws-apigw-streaming' wrapper", () => {
    // The upstream native wrapper is the better long-term option than the
    // community 'aws-lambda-streaming' we monkeypatch; the validator must
    // not reject a user who adopts it.
    fs.writeFileSync(
      path.join(tmpDir, 'open-next.config.ts'),
      `const config = {
  default: { override: { converter: 'aws-apigw-v1', wrapper: 'aws-apigw-streaming' } },
};
export default config;
`,
    );
    buildOutputCreator = () => {
      const openNextDir = path.join(tmpDir, '.open-next');
      fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
        'export const handler = async () => {};',
      );
      fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
      fs.writeFileSync(
        path.join(openNextDir, 'open-next.output.json'),
        JSON.stringify({
          origins: { default: { type: 'function', handler: 'index.handler' } },
          behaviors: [{ pattern: '/*', origin: 'default' }],
          additionalProps: {},
        }),
      );
    };
    assert.doesNotThrow(() => nextjsAdapter({ projectDir: tmpDir }));
  });
});

void describe('nextjsAdapter — OpenNext version-drift warning', () => {
  let tmpDir: string;
  let lenientBackup: string | undefined;
  let stderrChunks: string[];
  let restoreStderr: (() => void) | undefined;
  let buildOutputCreator: (() => void) | undefined;

  /**
   * Lay down the minimal `.open-next/` skeleton + an installed
   * `node_modules/@opennextjs/aws/package.json` at the requested
   * version so warnIfOpenNextOutOfRange's local-pkg probe finds it.
   */
  const writeFixtureWithOpenNextVersion = (version: string): void => {
    const openNextPkgDir = path.join(
      tmpDir,
      'node_modules',
      '@opennextjs',
      'aws',
    );
    fs.mkdirSync(openNextPkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(openNextPkgDir, 'package.json'),
      JSON.stringify({ name: '@opennextjs/aws', version, main: 'index.js' }),
    );
    fs.writeFileSync(path.join(openNextPkgDir, 'index.js'), '');
    buildOutputCreator = () => {
      const openNextDir = path.join(tmpDir, '.open-next');
      fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
        'export const handler = async () => {};',
      );
      fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
      fs.writeFileSync(
        path.join(openNextDir, 'open-next.output.json'),
        JSON.stringify({
          origins: { default: { type: 'function', handler: 'index.handler' } },
          behaviors: [{ pattern: '/*', origin: 'default' }],
          additionalProps: {},
        }),
      );
    };
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-nextjs-onv-'));
    buildOutputCreator = undefined;
    mock.method(spawn, 'sync', () => {
      buildOutputCreator?.();
    });
    lenientBackup = process.env.HOSTING_LENIENT_PATCHES;
    process.env.HOSTING_LENIENT_PATCHES = '1';
    stderrChunks = [];
    const orig = process.stderr.write.bind(process.stderr) as (
      s: string | Uint8Array,
    ) => boolean;
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrChunks.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    restoreStderr = () => {
      process.stderr.write = orig;
    };
  });

  afterEach(() => {
    restoreStderr?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mock.restoreAll();
    if (lenientBackup === undefined) {
      delete process.env.HOSTING_LENIENT_PATCHES;
    } else {
      process.env.HOSTING_LENIENT_PATCHES = lenientBackup;
    }
  });

  void it('does NOT warn when @opennextjs/aws is in the verified range', () => {
    writeFixtureWithOpenNextVersion('3.10.0');
    nextjsAdapter({ projectDir: tmpDir });
    assert.ok(
      !stderrChunks.some((c) => c.includes('outside the version range')),
      `unexpected drift warning; stderr was: ${stderrChunks.join('')}`,
    );
  });

  void it('warns when @opennextjs/aws is above the verified upper bound', () => {
    writeFixtureWithOpenNextVersion('3.20.0');
    nextjsAdapter({ projectDir: tmpDir });
    assert.ok(
      stderrChunks.some(
        (c) =>
          c.includes('@opennextjs/aws@3.20.0') &&
          c.includes('outside the version range'),
      ),
      `expected drift warning; stderr was: ${stderrChunks.join('')}`,
    );
  });

  void it('does NOT warn when @opennextjs/aws is not installed (skipBuild path)', () => {
    // Skip the version check by not writing the package.json — the
    // adapter still runs because the .open-next/ output is present.
    buildOutputCreator = () => {
      const openNextDir = path.join(tmpDir, '.open-next');
      fs.mkdirSync(path.join(openNextDir, 'server-functions', 'default'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(openNextDir, 'server-functions', 'default', 'index.mjs'),
        'export const handler = async () => {};',
      );
      fs.mkdirSync(path.join(openNextDir, 'assets'), { recursive: true });
      fs.writeFileSync(
        path.join(openNextDir, 'open-next.output.json'),
        JSON.stringify({
          origins: { default: { type: 'function', handler: 'index.handler' } },
          behaviors: [{ pattern: '/*', origin: 'default' }],
          additionalProps: {},
        }),
      );
    };
    nextjsAdapter({ projectDir: tmpDir });
    assert.ok(
      !stderrChunks.some((c) => c.includes('outside the version range')),
      `should not warn when @opennextjs/aws is absent; stderr was: ${stderrChunks.join('')}`,
    );
  });
});

void describe('stripBasePathPrefix', () => {
  void it('strips a leading basePath segment (no-leading-slash OpenNext form)', () => {
    assert.strictEqual(stripBasePathPrefix('/app', 'app/_next/*'), '/_next/*');
  });

  void it('strips a leading basePath segment (slash-prefixed form)', () => {
    assert.strictEqual(stripBasePathPrefix('/app', '/app/legacy'), '/legacy');
  });

  void it('maps the basePath root itself to "/"', () => {
    assert.strictEqual(stripBasePathPrefix('/app', '/app'), '/');
  });

  void it('leaves a pattern that is not under basePath unchanged', () => {
    assert.strictEqual(stripBasePathPrefix('/app', '/about'), '/about');
  });

  void it('is boundary-safe: does not strip a shared-prefix substring', () => {
    // `/application/*` is NOT under `/app` (no `/app/` boundary).
    assert.strictEqual(
      stripBasePathPrefix('/app', '/application/*'),
      '/application/*',
    );
  });

  void it('leaves an external/absolute destination unchanged', () => {
    assert.strictEqual(
      stripBasePathPrefix('/app', 'https://cdn.example.com/x'),
      'https://cdn.example.com/x',
    );
  });

  void it('round-trips: strip(prepend(x)) === x for a relative pattern', () => {
    // /app + /foo/* -> /app/foo/*  then strip -> /foo/*
    assert.strictEqual(stripBasePathPrefix('/app', '/app/foo/*'), '/foo/*');
  });
});

void describe('stripBakedBasePath', () => {
  const baseManifest = (): DeployManifest => ({
    version: 1,
    compute: {},
    staticAssets: { directory: '/tmp/static' },
    routes: [],
  });

  void it('is a no-op when basePath is unset', () => {
    const m = baseManifest();
    m.routes = [{ pattern: '/app/_next/*', target: 'static' }];
    stripBakedBasePath(m);
    assert.strictEqual(m.routes[0].pattern, '/app/_next/*');
  });

  void it('strips baked basePath from route patterns so the L3 prepends exactly once', () => {
    const m = baseManifest();
    m.basePath = '/app';
    m.routes = [
      { pattern: 'app/_next/image*', target: 'image-optimization' },
      { pattern: 'app/_next/data/*', target: 'default' },
      { pattern: 'app/_next/*', target: 's3' },
      { pattern: '/*', target: 'default' }, // catch-all is not under basePath
      // a blocks-injected relative route must be untouched
      { pattern: '/.blocks-sandbox/*', target: 'static' },
    ];
    stripBakedBasePath(m);
    assert.deepStrictEqual(
      m.routes.map((r) => r.pattern),
      ['/_next/image*', '/_next/data/*', '/_next/*', '/*', '/.blocks-sandbox/*'],
    );
  });

  void it('strips baked basePath from redirect source AND destination', () => {
    const m = baseManifest();
    m.basePath = '/app';
    m.redirects = [
      { source: '/app/legacy-home', destination: '/app', statusCode: 308 },
      { source: '/app/r/old-0', destination: '/app/r/new-0', statusCode: 308 },
    ];
    stripBakedBasePath(m);
    assert.deepStrictEqual(m.redirects, [
      { source: '/legacy-home', destination: '/', statusCode: 308 },
      { source: '/r/old-0', destination: '/r/new-0', statusCode: 308 },
    ]);
  });

  void it('strips baked basePath from header sources', () => {
    const m = baseManifest();
    m.basePath = '/app';
    m.headers = [
      { source: '/app/secure-headers', headers: { 'x-frame-options': 'DENY' } },
    ];
    stripBakedBasePath(m);
    assert.strictEqual(m.headers[0].source, '/secure-headers');
  });
});

void describe('nextPatternToCloudFront', () => {
  void it('collapses [...catchall] and [dynamic] segments', () => {
    assert.strictEqual(
      nextPatternToCloudFront('/api/edge/[slug]'),
      '/api/edge/*',
    );
    assert.strictEqual(
      nextPatternToCloudFront('/api/edge/catch/[...path]'),
      '/api/edge/catch/*',
    );
  });

  // Regression (edge 500): OpenNext joins basePath without collapsing the
  // separator → `app//edge`. A `//` pattern matches the literal `//` URL, never
  // the browser's `/app/edge`, so the dedicated edge behavior misses → the
  // request falls to the default KVS router → split edge bundle never runs → 500.
  void it('collapses an OpenNext double-slash basePath join', () => {
    assert.strictEqual(nextPatternToCloudFront('app//edge'), '/app/edge');
    assert.strictEqual(
      nextPatternToCloudFront('app//api/edge'),
      '/app/api/edge',
    );
  });

  void it('guarantees a single leading slash', () => {
    assert.strictEqual(nextPatternToCloudFront('app/edge'), '/app/edge');
  });

  void it('leaves a clean pattern unchanged', () => {
    assert.strictEqual(nextPatternToCloudFront('/api/edge'), '/api/edge');
    assert.strictEqual(nextPatternToCloudFront('/*'), '/*');
  });
});
