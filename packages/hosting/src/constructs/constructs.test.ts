/**
 * Integration tests for all provisioning paths.
 *
 * These use CDK assertion (Template.fromStack) to verify the synthesized
 * CloudFormation output matches expectations — no actual deployment.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { HostingConstruct } from './hosting_construct.js';
import { DeployManifest } from '../manifest/types.js';
import { ORIGIN_ID, buildKvsEntries } from './kvs_router.js';

// ---- Helpers ----

const createStack = (): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack');
};

const createEnvStack = (
  region = 'us-east-1',
  account = '123456789012',
): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack', { env: { account, region } });
};

let tmpDir: string;

const createStaticDir = (): string => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'constructs-integ-test-'));
  fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
  return tmpDir;
};

const createBundleDir = (name = 'bundle'): string => {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.mjs'),
    'export const handler = async () => {};',
  );
  return dir;
};

// ================================================================
// Middleware → Lambda@Edge viewer-request
// ================================================================

void describe('Middleware provisioning', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates Lambda@Edge function from middleware bundle', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir('server');
    const middlewareDir = createBundleDir('middleware');
    const stack = createEnvStack();

    const manifest: DeployManifest = {
      version: 1,
      compute: {
        default: {
          type: 'handler',
          bundle: bundleDir,
          handler: 'index.handler',
          placement: 'regional',
          streaming: true,
        },
      },
      staticAssets: { directory: staticDir },
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/*', target: 'default' },
      ],
      middleware: {
        bundle: middlewareDir,
        handler: 'handler.handler',
        matchers: ['/*'],
      },
      buildId: 'middleware-test-1',
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);

    // Should have a Lambda for the middleware (edge) — no Function URL
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'handler.handler',
    });

    // The distribution should have a Lambda@Edge association
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          LambdaFunctionAssociations: Match.arrayWith([
            Match.objectLike({
              EventType: 'viewer-request',
            }),
          ]),
        }),
      }),
    });
  });

  void it('does not create Lambda@Edge when no middleware in manifest', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir('server');
    const stack = createStack();

    const manifest: DeployManifest = {
      version: 1,
      compute: {
        default: {
          type: 'handler',
          bundle: bundleDir,
          handler: 'index.handler',
          placement: 'regional',
        },
      },
      staticAssets: { directory: staticDir },
      routes: [{ pattern: '/*', target: 'default' }],
      buildId: 'no-middleware-test-1',
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);

    // Should NOT have Lambda@Edge associations on default behavior
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.not(
          Match.objectLike({
            LambdaFunctionAssociations: Match.anyValue(),
          }),
        ),
      }),
    });
  });
});

// ================================================================
// Cache (ISR) → S3 bucket + DynamoDB + SQS + env vars
// ================================================================

void describe('Cache (ISR) provisioning', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('provisions S3 cache bucket, DynamoDB, SQS, and env vars', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir('server');
    const stack = createStack();

    const manifest: DeployManifest = {
      version: 1,
      compute: {
        default: {
          type: 'handler',
          bundle: bundleDir,
          handler: 'index.handler',
          placement: 'regional',
          streaming: true,
        },
      },
      staticAssets: { directory: staticDir },
      routes: [{ pattern: '/*', target: 'default' }],
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: true,
      },
      buildId: 'cache-test-1',
    };

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);

    // Cache S3 bucket (with lifecycle)
    assert.ok(construct.cacheBucket, 'cacheBucket should be defined');
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            ExpirationInDays: 30,
            Status: 'Enabled',
          }),
        ]),
      }),
    });

    // DynamoDB table for tag revalidation
    assert.ok(construct.cacheTable, 'cacheTable should be defined');
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: 'tag', KeyType: 'HASH' }),
        Match.objectLike({ AttributeName: 'path', KeyType: 'RANGE' }),
      ]),
      BillingMode: 'PAY_PER_REQUEST',
    });

    // SQS queue for revalidation
    assert.ok(
      construct.revalidationQueue,
      'revalidationQueue should be defined',
    );
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 30,
    });

    // Env vars on the compute Lambda
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Environment: Match.objectLike({
        Variables: Match.objectLike({
          CACHE_BUCKET_NAME: Match.anyValue(),
          CACHE_DYNAMO_TABLE: Match.anyValue(),
          REVALIDATION_QUEUE_URL: Match.anyValue(),
        }),
      }),
    });
  });

  void it('does NOT provision cache infra when no cache in manifest', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir('server');
    const stack = createStack();

    const manifest: DeployManifest = {
      version: 1,
      compute: {
        default: {
          type: 'handler',
          bundle: bundleDir,
          handler: 'index.handler',
          placement: 'regional',
        },
      },
      staticAssets: { directory: staticDir },
      routes: [{ pattern: '/*', target: 'default' }],
      buildId: 'no-cache-test-1',
    };

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    assert.strictEqual(construct.cacheBucket, undefined);
    assert.strictEqual(construct.cacheTable, undefined);
    assert.strictEqual(construct.revalidationQueue, undefined);

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
    template.resourceCountIs('AWS::SQS::Queue', 0);
  });

  void it('deploys revalidation worker Lambda wired to SQS queue', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir('server');
    const revalDir = createBundleDir('revalidation');
    const stack = createStack();

    const manifest: DeployManifest = {
      version: 1,
      compute: {
        default: {
          type: 'handler',
          bundle: bundleDir,
          handler: 'index.handler',
          placement: 'regional',
          streaming: true,
        },
      },
      staticAssets: { directory: staticDir },
      routes: [{ pattern: '/*', target: 'default' }],
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: true,
        revalidationFunction: {
          bundle: revalDir,
          handler: 'index.handler',
        },
      },
      buildId: 'reval-worker-test-1',
    };

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    assert.ok(
      construct.computeFunctions.has('revalidation'),
      'Should register revalidation function',
    );

    const template = Template.fromStack(stack);

    // SQS event source mapping should be present
    template.hasResourceProperties(
      'AWS::Lambda::EventSourceMapping',
      Match.objectLike({
        BatchSize: 5,
      }),
    );

    // Revalidation Lambda should have 256MB memory and 30s timeout
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 256,
      Timeout: 30,
      Runtime: 'nodejs20.x',
    });
  });
});

// ================================================================
// Image Optimization → separate Lambda + CloudFront behavior
// ================================================================

void describe('Image Optimization provisioning', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates separate image optimization Lambda with its own Function URL (SSR uses API Gateway)', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir('server');
    const imgDir = createBundleDir('image-opt');
    const stack = createStack();

    const manifest: DeployManifest = {
      version: 1,
      compute: {
        default: {
          type: 'handler',
          bundle: bundleDir,
          handler: 'index.handler',
          placement: 'regional',
          streaming: true,
        },
      },
      staticAssets: { directory: staticDir },
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/_next/image/*', target: 'image-optimization' },
        { pattern: '/*', target: 'default' },
      ],
      imageOptimization: {
        bundle: imgDir,
        handler: 'index.handler',
        formats: ['webp', 'avif'],
        sizes: [640, 1080, 1920],
      },
      buildId: 'img-test-1',
    };

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    // Should have the image-optimization function registered
    assert.ok(construct.computeFunctions.has('image-optimization'));
    assert.ok(construct.computeFunctionUrls.has('image-optimization'));
    // SSR 'default' is fronted by REST API, not by a Function URL.
    assert.ok(!construct.computeFunctionUrls.has('default'));

    const template = Template.fromStack(stack);

    // Only image-opt has a Function URL (image opt is GET-only — body-hash
    // bug doesn't apply, so OAC + FURL is fine).
    template.resourceCountIs('AWS::Lambda::Url', 1);
    // SSR 'default' is fronted by exactly one REGIONAL REST API.
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);

    // The image-opt route is no longer a dedicated cache behavior — it's a KVS
    // route row routed to the image origin. The distribution carries all three
    // stable origin ids, and the only additional behaviors are the
    // server/image origin-binding sentinels.
    const dist = Object.values(
      template.findResources('AWS::CloudFront::Distribution'),
    )[0] as {
      Properties: {
        DistributionConfig: {
          Origins: { Id: string }[];
          CacheBehaviors?: { PathPattern: string }[];
        };
      };
    };
    const ids = dist.Properties.DistributionConfig.Origins.map((o) => o.Id);
    assert.ok(ids.includes(ORIGIN_ID.s3));
    assert.ok(ids.includes(ORIGIN_ID.server));
    assert.ok(ids.includes(ORIGIN_ID.image));
    const patterns = (
      dist.Properties.DistributionConfig.CacheBehaviors ?? []
    ).map((b) => b.PathPattern);
    assert.ok(
      !patterns.includes('/_next/image/*'),
      `image route must not be a behavior; got ${JSON.stringify(patterns)}`,
    );
    assert.deepEqual(patterns.sort(), [
      '/__blocks_origin_image/*',
      '/__blocks_origin_server/*',
    ]);
  });
});

// ================================================================
// Multi-compute → per-origin routing
// ================================================================

void describe('Multi-compute provisioning', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates multiple Lambdas with correct Function URLs and routing', () => {
    const staticDir = createStaticDir();
    const serverDir = createBundleDir('server');
    const apiDir = createBundleDir('api');
    const stack = createStack();

    const manifest: DeployManifest = {
      version: 1,
      compute: {
        server: {
          type: 'handler',
          bundle: serverDir,
          handler: 'index.handler',
          placement: 'regional',
          streaming: true,
        },
        api: {
          type: 'handler',
          bundle: apiDir,
          handler: 'index.handler',
          placement: 'regional',
          streaming: false,
        },
      },
      staticAssets: { directory: staticDir },
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/api/*', target: 'api' },
        { pattern: '/*', target: 'server' },
      ],
      buildId: 'multi-compute-test-1',
    };

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    // Both compute functions should be registered.
    assert.ok(construct.computeFunctions.has('server'));
    assert.ok(construct.computeFunctions.has('api'));
    // 'server' is SSR — REST API origin, no Function URL.
    assert.ok(!construct.computeFunctionUrls.has('server'));
    assert.ok(construct.computeFunctionUrls.has('api'));

    const template = Template.fromStack(stack);

    // Only the non-SSR compute keeps a Function URL; SSR 'server' goes
    // through one REGIONAL REST API instead.
    template.resourceCountIs('AWS::Lambda::Url', 1);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);

    // Routing is in the KVS table now, not per-route cache behaviors. The
    // distribution carries the server origin; /api/* → compute and
    // /_next/static/* → S3 are route rows, NOT behaviors.
    const dist = Object.values(
      template.findResources('AWS::CloudFront::Distribution'),
    )[0] as {
      Properties: {
        DistributionConfig: {
          Origins: { Id: string }[];
          CacheBehaviors?: { PathPattern: string }[];
        };
      };
    };
    const ids = dist.Properties.DistributionConfig.Origins.map((o) => o.Id);
    assert.ok(ids.includes(ORIGIN_ID.s3));
    assert.ok(ids.includes(ORIGIN_ID.server));
    const patterns = (
      dist.Properties.DistributionConfig.CacheBehaviors ?? []
    ).map((b) => b.PathPattern);
    assert.ok(
      !patterns.includes('/api/*') && !patterns.includes('/_next/static/*'),
      `routes must not be behaviors; got ${JSON.stringify(patterns)}`,
    );

    // Verify the route kinds in the KVS table built from the same manifest.
    const rows: [string, string][] = [];
    const entries = buildKvsEntries({
      manifest,
      buildId: 'multi-compute-test-1',
      hasServer: true,
      hasImage: false,
    });
    for (const [k, v] of Object.entries(entries)) {
      if (/^r\d+$/.test(k)) rows.push(...(JSON.parse(v) as [string, string][]));
    }
    const kindFor = (p: string) => rows.find(([pat]) => pat === p)?.[1];
    assert.equal(kindFor('/api/*'), 'c', '/api/* routes to compute');
    assert.equal(kindFor('/_next/static/*'), 's', '/_next/static/* routes to S3');
  });

  void it('selects primary compute by convention (default > server > first)', () => {
    const staticDir = createStaticDir();
    const serverDir = createBundleDir('server-fn');
    const apiDir = createBundleDir('api-fn');
    const stack = createStack();

    // Name the first compute 'api' and second 'default' — 'default' should be primary
    const manifest: DeployManifest = {
      version: 1,
      compute: {
        api: {
          type: 'handler',
          bundle: apiDir,
          handler: 'index.handler',
          placement: 'regional',
        },
        default: {
          type: 'handler',
          bundle: serverDir,
          handler: 'index.handler',
          placement: 'regional',
          streaming: true,
        },
      },
      staticAssets: { directory: staticDir },
      routes: [
        { pattern: '/api/*', target: 'api' },
        { pattern: '/*', target: 'default' },
      ],
      buildId: 'primary-convention-test-1',
    };

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    // 'default' is SSR — fronted by REST API, not a Function URL.
    assert.ok(construct.computeFunctions.has('default'));
    assert.ok(!construct.computeFunctionUrls.has('default'));
    assert.ok(construct.computeFunctionUrls.has('api'));

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });
});

// ================================================================
// Edge compute — no Function URL
// ================================================================

void describe('Edge compute type safety', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('edge compute does not create Function URL', () => {
    const staticDir = createStaticDir();
    const edgeDir = createBundleDir('edge-fn');
    const serverDir = createBundleDir('server-fn');
    const stack = createEnvStack();

    const manifest: DeployManifest = {
      version: 1,
      compute: {
        default: {
          type: 'handler',
          bundle: serverDir,
          handler: 'index.handler',
          placement: 'regional',
        },
        edgeFn: {
          type: 'edge',
          bundle: edgeDir,
          handler: 'index.handler',
          placement: 'global',
        },
      },
      staticAssets: { directory: staticDir },
      routes: [{ pattern: '/*', target: 'default' }],
      buildId: 'edge-test-1',
    };

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    // Edge function should be in computeFunctions but NOT in computeFunctionUrls.
    assert.ok(construct.computeFunctions.has('edgeFn'));
    assert.ok(!construct.computeFunctionUrls.has('edgeFn'));
    // SSR 'default' is fronted by REST API, not a Function URL.
    assert.ok(!construct.computeFunctionUrls.has('default'));

    const template = Template.fromStack(stack);
    // No Function URLs at all: edge can't have one, SSR uses REST API instead.
    template.resourceCountIs('AWS::Lambda::Url', 0);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });
});
