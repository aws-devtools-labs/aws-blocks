import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { App, CfnResource, Duration, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HostingConstruct } from './hosting_construct.js';
import { DeployManifest } from '../manifest/types.js';
import { HostingError } from '../hosting_error.js';
import { generateKvsRouterRequestCode } from './kvs_router.js';

// ---- Helpers ----

const createStack = (): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack');
};

let tmpDir: string;

const createStaticDir = (): string => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-test-'));
  fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
  return tmpDir;
};

const createBundleDir = (): string => {
  const dir = path.join(tmpDir, 'bundle');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'index.mjs'),
    'export const handler = async () => {};',
  );
  return dir;
};

const spaManifest = (staticDir: string): DeployManifest => ({
  version: 1,
  compute: {},
  staticAssets: { directory: staticDir },
  routes: [{ pattern: '/*', target: 'static' }],
  buildId: 'spa-test-1',
});

const ssrManifest = (staticDir: string, bundleDir: string): DeployManifest => ({
  version: 1,
  compute: {
    default: {
      type: 'handler',
      bundle: bundleDir,
      handler: 'index.handler',
      placement: 'regional',
      streaming: true,
      runtime: 'nodejs20.x',
    },
  },
  staticAssets: { directory: staticDir },
  routes: [
    { pattern: '/_next/static/*', target: 'static' },
    { pattern: '/favicon.ico', target: 'static' },
    { pattern: '/*', target: 'default' },
  ],
  buildId: 'ssr-test-1',
});

// ================================================================
// SPA mode
// ================================================================

void describe('HostingConstruct — SPA mode', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates S3 bucket with BlockPublicAccess', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
      }),
    });
  });

  void it('creates CloudFront distribution', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  void it('exposes bucket, distribution, and distributionUrl', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    assert.ok(construct.bucket);
    assert.ok(construct.distribution);
    assert.ok(construct.distributionUrl);
  });

  void it('does not create user Lambda when no compute in manifest', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    // BucketDeployment creates its own Lambda, so check for Lambda URL instead
    // A user SSR Lambda would have a Function URL resource
    template.resourceCountIs('AWS::Lambda::Url', 0);
  });
});

// ================================================================
// SSR mode
// ================================================================

void describe('HostingConstruct — SSR mode', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates Lambda function for handler compute type', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
    });
  });

  void it('fronts SSR Lambda with API Gateway REST API (no Function URL)', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    // SSR compute is fronted by REGIONAL REST API (cdn_construct), not OAC + Function URL.
    template.resourceCountIs('AWS::Lambda::Url', 0);
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: Match.objectLike({ Types: ['REGIONAL'] }),
    });
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'ANY',
      Integration: Match.objectLike({ Type: 'AWS_PROXY' }),
    });
  });

  void it('supports http-server compute type with Web Adapter', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    fs.writeFileSync(path.join(bundleDir, 'server.js'), '// http server');
    const stack = createStack();

    const manifest: DeployManifest = {
      version: 1,
      compute: {
        default: {
          type: 'http-server',
          bundle: bundleDir,
          entrypoint: 'server.js',
          port: 3000,
          placement: 'regional',
          runtime: 'nodejs20.x',
        },
      },
      staticAssets: { directory: staticDir },
      routes: [{ pattern: '/*', target: 'default' }],
      buildId: 'ssr-http-1',
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'server.js',
      Environment: {
        Variables: Match.objectLike({
          AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
          PORT: '3000',
        }),
      },
    });
  });

  void it('accepts compute.timeout as a plain number (seconds) and coerces to Duration', () => {
    // Regression: AWS Blocks bug-bash repro showed `timeout: 30`
    // (a plain number) reaching the L3 from a permissive JS-compiled
    // wrapper and crashing synth deep in aws-cdk-lib with
    // `props.timeout.toSeconds is not a function`. The L3 surface
    // now accepts `Duration | number` and normalizes once.
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    const manifest: DeployManifest = {
      version: 1,
      compute: {
        default: {
          type: 'handler',
          bundle: bundleDir,
          handler: 'index.handler',
          placement: 'regional',
          runtime: 'nodejs20.x',
        },
      },
      staticAssets: { directory: staticDir },
      routes: [{ pattern: '/*', target: 'default' }],
      buildId: 'ssr-timeout-coerce-1',
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
      compute: { timeout: 45 },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 45,
    });
  });

  void it('does not throw on manifest.rewrites (upstream proxy); warns instead', () => {
    // routeRules.proxy lifts to manifest.rewrites[]. The L3 doesn't edge-route
    // them yet, but they WORK via the SSR Lambda's Nitro runtime — so the
    // construct must deploy (warn), not throw and block a working app.
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    const stderrChunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.doesNotThrow(() => {
        new HostingConstruct(stack, 'Hosting', {
          manifest: {
            ...ssrManifest(staticDir, bundleDir),
            rewrites: [
              { source: '/api/external/*', destination: 'https://upstream/*' },
            ],
          },
          skipRegionValidation: true,
        });
      });
    } finally {
      process.stderr.write = original;
    }
    assert.ok(
      stderrChunks.join('').includes('upstream-proxy rewrite'),
      'must warn that proxy rewrites are not edge-optimized',
    );
  });

  void it('wires compute.provisionedConcurrency into a live alias on the SSR Lambda', () => {
    // Regression for the silently-dropped prop: the L3 used to forward only
    // memory/timeout/reserved to the SSR ComputeConstruct, so
    // compute.provisionedConcurrency was inert. Now it creates a `live`
    // alias the REST integration targets.
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      skipRegionValidation: true,
      compute: { provisionedConcurrency: 4 },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Alias', {
      Name: 'live',
      ProvisionedConcurrencyConfig: Match.objectLike({
        ProvisionedConcurrentExecutions: 4,
      }),
    });
  });

  void it('throws when skewProtection.maxAge exceeds storage.buildRetentionDays', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    // 7 days retention = 604800s; a 14-day (1209600s) cookie would pin a
    // returning viewer to a build prefix the lifecycle rule already deleted.
    assert.throws(
      () =>
        new HostingConstruct(stack, 'Hosting', {
          manifest: ssrManifest(staticDir, bundleDir),
          skipRegionValidation: true,
          storage: { buildRetentionDays: 7 },
          skewProtection: { enabled: true, maxAge: 14 * 24 * 60 * 60 },
        }),
      (error: Error) => error.name === 'InvalidSkewProtectionMaxAgeError',
    );
  });

  void it('allows skewProtection.maxAge within storage.buildRetentionDays', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    assert.doesNotThrow(
      () =>
        new HostingConstruct(stack, 'Hosting', {
          manifest: ssrManifest(staticDir, bundleDir),
          skipRegionValidation: true,
          storage: { buildRetentionDays: 30 },
          skewProtection: { enabled: true, maxAge: 24 * 60 * 60 },
        }),
    );
  });
});

// ================================================================
// Cache infrastructure (ISR)
// ================================================================

void describe('HostingConstruct — Cache/ISR', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('provisions DynamoDB table when cache.tagRevalidation is true', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: false,
      },
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: 'tag', KeyType: 'HASH' }),
        Match.objectLike({ AttributeName: 'path', KeyType: 'RANGE' }),
      ]),
    });
  });

  void it('provisions SQS queue when cache.revalidationQueue is true', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      cache: {
        computeResource: 'default',
        tagRevalidation: false,
        revalidationQueue: true,
      },
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SQS::Queue', 2); // Revalidation + DLQ
  });

  void it('provisions S3 cache bucket when cache is configured', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: true,
      },
    };

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    assert.ok(construct.cacheBucket, 'Should provision cache bucket');
    assert.ok(construct.cacheTable, 'Should provision cache table');
    assert.ok(
      construct.revalidationQueue,
      'Should provision revalidation queue',
    );
  });

  void it('does not provision cache resources when no cache in manifest', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      skipRegionValidation: true,
    });

    assert.strictEqual(construct.cacheBucket, undefined);
    assert.strictEqual(construct.cacheTable, undefined);
    assert.strictEqual(construct.revalidationQueue, undefined);
  });

  void it('sets CACHE_BUCKET_REGION, REVALIDATION_QUEUE_REGION, and OPEN_NEXT_BUILD_ID env vars', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: true,
      },
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    const functions = template.findResources('AWS::Lambda::Function');
    const hasIsrEnvVars = Object.values(functions).some(
      (fn: Record<string, unknown>) => {
        const props = fn['Properties'] as Record<string, unknown>;
        const env = props['Environment'] as Record<string, unknown> | undefined;
        const vars = env?.['Variables'] as Record<string, unknown> | undefined;
        return (
          vars &&
          'CACHE_BUCKET_NAME' in vars &&
          'CACHE_BUCKET_REGION' in vars &&
          'CACHE_DYNAMO_TABLE' in vars &&
          'REVALIDATION_QUEUE_URL' in vars &&
          'REVALIDATION_QUEUE_REGION' in vars &&
          'OPEN_NEXT_BUILD_ID' in vars
        );
      },
    );
    assert.ok(
      hasIsrEnvVars,
      'Cache compute Lambda should have all ISR env vars including CACHE_BUCKET_REGION, REVALIDATION_QUEUE_REGION, and OPEN_NEXT_BUILD_ID',
    );
  });

  void it('deploys revalidation worker Lambda with SQS event source when revalidationFunction is configured', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const revalDir = path.join(tmpDir, 'revalidation-fn');
    fs.mkdirSync(revalDir, { recursive: true });
    fs.writeFileSync(
      path.join(revalDir, 'index.mjs'),
      'export const handler = async () => {};',
    );
    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: true,
        revalidationFunction: {
          bundle: revalDir,
          handler: 'index.handler',
        },
      },
    };

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    assert.ok(
      construct.computeFunctions.has('revalidation'),
      'Should register revalidation function in computeFunctions map',
    );

    const template = Template.fromStack(stack);

    // Should have an SQS event source mapping for the revalidation Lambda
    template.hasResourceProperties(
      'AWS::Lambda::EventSourceMapping',
      Match.objectLike({
        BatchSize: 5,
      }),
    );

    // Revalidation Lambda should have ISR env vars
    const functions = template.findResources('AWS::Lambda::Function');
    const hasRevalEnvVars = Object.values(functions).some(
      (fn: Record<string, unknown>) => {
        const props = fn['Properties'] as Record<string, unknown>;
        const env = props['Environment'] as Record<string, unknown> | undefined;
        const vars = env?.['Variables'] as Record<string, unknown> | undefined;
        return (
          vars &&
          'CACHE_BUCKET_NAME' in vars &&
          'CACHE_BUCKET_REGION' in vars &&
          'CACHE_DYNAMO_TABLE' in vars &&
          'OPEN_NEXT_BUILD_ID' in vars &&
          (props['MemorySize'] as number) === 256
        );
      },
    );
    assert.ok(
      hasRevalEnvVars,
      'Revalidation Lambda should have cache env vars and 256MB memory',
    );
  });

  void it('revalidation worker Lambda has explicit LogGroup with retention (no deprecated logRetention prop)', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const revalDir = path.join(tmpDir, 'revalidation-fn');
    fs.mkdirSync(revalDir, { recursive: true });
    fs.writeFileSync(
      path.join(revalDir, 'index.mjs'),
      'export const handler = async () => {};',
    );
    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: true,
        revalidationFunction: {
          bundle: revalDir,
          handler: 'index.handler',
        },
      },
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);

    // Revalidation Lambda should have an explicit LogGroup with TWO_WEEKS retention
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 14,
    });
  });

  void it('does not deploy revalidation worker when revalidationFunction is not configured', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: true,
      },
    };

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    assert.ok(
      !construct.computeFunctions.has('revalidation'),
      'Should not register revalidation function when not configured',
    );

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
  });

  void it('seeds the cache bucket via BucketDeployment when seedDirectory is set', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const seedDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(path.join(seedDir, 'BUILDID', 'products'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(seedDir, 'BUILDID', 'products', '0.cache'),
      '{"type":"app","html":"<html></html>","rsc":""}',
    );
    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: true,
        seedDirectory: seedDir,
      },
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    // Static-asset deployments also create CDKBucketDeployment resources, so
    // identify the seed deployment by its construct id (`IsrCacheSeed`).
    const deployments = template.findResources('Custom::CDKBucketDeployment');
    const hasSeed = Object.keys(deployments).some((id) =>
      id.includes('IsrCacheSeed'),
    );
    assert.ok(
      hasSeed,
      'Should create a BucketDeployment seeding the cache bucket',
    );
  });

  void it('seeds the tag table via a custom resource when initFunction is set', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const initDir = path.join(tmpDir, 'dynamodb-provider');
    fs.mkdirSync(initDir, { recursive: true });
    fs.writeFileSync(
      path.join(initDir, 'index.mjs'),
      'export const handler = async () => {};',
    );
    fs.writeFileSync(path.join(initDir, 'dynamodb-cache.json'), '[]');
    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: true,
        initFunction: {
          bundle: initDir,
          handler: 'index.handler',
        },
      },
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    // The seed function should be granted write access to the tag table —
    // assert an IAM policy with DynamoDB write actions exists.
    template.hasResourceProperties(
      'AWS::IAM::Policy',
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['dynamodb:PutItem']),
            }),
          ]),
        }),
      }),
    );
  });

  void it('does not seed cache when seedDirectory / initFunction are absent', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: true,
      },
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    const deployments = template.findResources('Custom::CDKBucketDeployment');
    const hasSeed = Object.keys(deployments).some((id) =>
      id.includes('IsrCacheSeed'),
    );
    assert.ok(
      !hasSeed,
      'Should not seed the cache bucket when seedDirectory is absent',
    );
  });
});

// ================================================================
// Image optimization
// ================================================================

void describe('HostingConstruct — Image optimization', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates separate image optimization Lambda', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const imgDir = path.join(tmpDir, 'image-fn');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(
      path.join(imgDir, 'index.mjs'),
      'export const handler = async () => {};',
    );

    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      imageOptimization: {
        bundle: imgDir,
        handler: 'index.handler',
        formats: ['webp', 'avif'],
        sizes: [640, 1080],
      },
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    // Should have at least 2 Lambda functions (default + image optimization)
    const functions = template.findResources('AWS::Lambda::Function');
    assert.ok(
      Object.keys(functions).length >= 2,
      `Expected at least 2 Lambda functions, got ${Object.keys(functions).length}`,
    );
  });

  void it('uses default x86_64 architecture for image optimization Lambda', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const imgDir = path.join(tmpDir, 'image-fn');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(
      path.join(imgDir, 'index.mjs'),
      'export const handler = async () => {};',
    );

    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      imageOptimization: {
        bundle: imgDir,
        handler: 'index.handler',
        formats: ['webp', 'avif'],
        sizes: [640, 1080],
      },
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    const functions = template.findResources('AWS::Lambda::Function');
    // Image optimization Lambda should use x86_64 (default) to match sharp binaries
    const hasX86 = Object.values(functions).some(
      (fn: Record<string, unknown>) => {
        const props = fn['Properties'] as Record<string, unknown>;
        const architectures = props['Architectures'] as string[] | undefined;
        return !architectures || architectures.includes('x86_64');
      },
    );
    assert.ok(
      hasX86,
      'Image optimization Lambda should use x86_64 architecture',
    );
  });

  void it('sets BUCKET_NAME and BUCKET_KEY_PREFIX env vars on image optimization Lambda', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const imgDir = path.join(tmpDir, 'image-fn');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(
      path.join(imgDir, 'index.mjs'),
      'export const handler = async () => {};',
    );

    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      imageOptimization: {
        bundle: imgDir,
        handler: 'index.handler',
        formats: ['webp', 'avif'],
        sizes: [640, 1080],
      },
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    // At least one Lambda should have BUCKET_NAME env var
    const functions = template.findResources('AWS::Lambda::Function');
    const hasBucketEnv = Object.values(functions).some(
      (fn: Record<string, unknown>) => {
        const props = fn['Properties'] as Record<string, unknown>;
        const env = props['Environment'] as Record<string, unknown> | undefined;
        const vars = env?.['Variables'] as Record<string, unknown> | undefined;
        return vars && 'BUCKET_NAME' in vars && 'BUCKET_KEY_PREFIX' in vars;
      },
    );
    assert.ok(
      hasBucketEnv,
      'Image optimization Lambda should have BUCKET_NAME and BUCKET_KEY_PREFIX env vars',
    );
  });
});

// ================================================================
// getResources
// ================================================================

void describe('HostingConstruct — getResources', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('returns bucket, distribution, and distributionUrl', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const resources = construct.getResources();
    assert.ok(resources.bucket);
    assert.ok(resources.distribution);
    assert.ok(resources.distributionUrl);
  });
});

// ================================================================
// Multi-compute
// ================================================================

void describe('HostingConstruct — Multi-compute', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates separate Lambda and Function URL for each compute target', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const apiBundleDir = path.join(tmpDir, 'api-bundle');
    fs.mkdirSync(apiBundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(apiBundleDir, 'index.mjs'),
      'export const handler = async () => {};',
    );

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
          runtime: 'nodejs20.x',
        },
        api: {
          type: 'handler',
          bundle: apiBundleDir,
          handler: 'index.handler',
          placement: 'regional',
          streaming: false,
          runtime: 'nodejs20.x',
        },
      },
      staticAssets: { directory: staticDir },
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/api/*', target: 'api' },
        { pattern: '/*', target: 'default' },
      ],
      buildId: 'multi-compute-1',
    };

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    // Each compute target gets its own Lambda
    assert.ok(
      construct.computeFunctions.has('default'),
      'Should have default compute function',
    );
    assert.ok(
      construct.computeFunctions.has('api'),
      'Should have api compute function',
    );
    assert.strictEqual(
      construct.computeFunctions.size,
      2,
      'Should have exactly 2 compute functions',
    );

    // 'default' is SSR — fronted by REST API, no Function URL. 'api' is
    // non-SSR, keeps OAC + Function URL.
    assert.ok(
      !construct.computeFunctionUrls.has('default'),
      'SSR default uses API Gateway, not Function URL',
    );
    assert.ok(
      construct.computeFunctionUrls.has('api'),
      'Should have api Function URL',
    );
    assert.strictEqual(
      construct.computeFunctionUrls.size,
      1,
      'Only the non-SSR compute target gets a Function URL',
    );

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::Lambda::Url', 1);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);

    // OAC still grants InvokeFunctionUrl for the non-SSR compute.
    const permissions = template.findResources('AWS::Lambda::Permission');
    const invokeUrlPermissions = Object.values(permissions).filter(
      /* eslint-disable @typescript-eslint/naming-convention */
      (p: Record<string, unknown>) =>
        (p as { Properties?: { Action?: string } }).Properties?.Action ===
        'lambda:InvokeFunctionUrl',
      /* eslint-enable @typescript-eslint/naming-convention */
    );
    assert.ok(
      invokeUrlPermissions.length >= 1,
      `Expected at least 1 InvokeFunctionUrl permission, got ${invokeUrlPermissions.length}`,
    );
  });
});

// ================================================================
// WAF Integration (hosted construct level)
// ================================================================

void describe('HostingConstruct — WAF integration', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates WebACL and associates with CloudFront when waf.enabled is true', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      waf: { enabled: true },
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        WebACLId: {
          'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('.*WebAcl.*')]),
        },
      }),
    });
  });

  void it('does NOT create WebACL when waf is omitted', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
  });

  void it('does NOT create WebACL when waf.enabled is false', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      waf: { enabled: false },
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
  });

  void it('applies custom rate limit to WAF', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      waf: { enabled: true, rateLimit: 500 },
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'RateLimitRule',
          Statement: {
            RateBasedStatement: {
              Limit: 500,
              AggregateKeyType: 'IP',
            },
          },
        }),
      ]),
    });
  });

  void it('includes AWS managed rule groups in WAF', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      waf: { enabled: true },
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWSManagedRulesCommonRuleSet',
        }),
        Match.objectLike({
          Name: 'AWSManagedRulesKnownBadInputsRuleSet',
        }),
      ]),
    });
  });

  void it('WebACL has CLOUDFRONT scope', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      waf: { enabled: true },
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
    });
  });
});

// ================================================================
// Domain / Custom Domain (hosted construct level)
// ================================================================

void describe('HostingConstruct — Custom domain integration', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates Route53 records and ACM certificate for custom domain', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      domain: {
        domainName: 'www.example.com',
        hostedZone: 'example.com',
      },
    });

    const template = Template.fromStack(stack);

    // Should have A and AAAA records
    const records = template.findResources('AWS::Route53::RecordSet');
    const recordTypes = Object.values(records).map(
      (r) => (r as Record<string, Record<string, unknown>>).Properties?.Type,
    );
    assert.ok(recordTypes.includes('A'), 'Should have an A record');
    assert.ok(recordTypes.includes('AAAA'), 'Should have an AAAA record');

    // Distribution should have domain alias
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['www.example.com'],
      }),
    });
  });

  void it('uses BYO certificate when certificateArn is provided', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    const cert = Certificate.fromCertificateArn(
      stack,
      'ImportedCert',
      'arn:aws:acm:us-east-1:123456789012:certificate/abc-123',
    );

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      domain: {
        domainName: 'www.example.com',
        hostedZone: 'example.com',
        certificate: cert,
      },
    });

    const template = Template.fromStack(stack);

    // Should NOT create DnsValidatedCertificate custom resource
    const customResources = template.findResources(
      'AWS::CloudFormation::CustomResource',
    );
    const certResources = Object.entries(customResources).filter(([, r]) => {
      const props = (r as Record<string, Record<string, unknown>>).Properties;
      return props?.DomainName === 'www.example.com';
    });
    assert.strictEqual(
      certResources.length,
      0,
      'Should NOT create DnsValidatedCertificate when BYO cert is provided',
    );

    // Distribution should still have alias
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['www.example.com'],
      }),
    });
  });

  void it('rejects invalid domain not within hosted zone', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    assert.throws(
      () =>
        new HostingConstruct(stack, 'Hosting', {
          manifest: spaManifest(staticDir),
          domain: {
            domainName: 'evil.other.com',
            hostedZone: 'example.com',
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof HostingError);
        assert.strictEqual(err.name, 'InvalidDomainConfigError');
        return true;
      },
    );
  });

  void it('rejects suffix-attack domain name', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    assert.throws(
      () =>
        new HostingConstruct(stack, 'Hosting', {
          manifest: spaManifest(staticDir),
          domain: {
            domainName: 'evilexample.com',
            hostedZone: 'example.com',
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof HostingError);
        assert.strictEqual(err.name, 'InvalidDomainConfigError');
        return true;
      },
    );
  });
});

// ================================================================
// Error Paths
// ================================================================

void describe('HostingConstruct — Error paths', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('throws CacheComputeResourceNotFoundError when cache references non-existent compute', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      cache: {
        computeResource: 'nonexistent',
        tagRevalidation: true,
        revalidationQueue: true,
      },
    };

    assert.throws(
      () =>
        new HostingConstruct(stack, 'Hosting', {
          manifest,
          skipRegionValidation: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HostingError);
        assert.strictEqual(err.name, 'CacheComputeResourceNotFoundError');
        assert.ok(err.message.includes('nonexistent'));
        assert.ok(err.resolution);
        return true;
      },
    );
  });

  void it('throws InvalidWafConfigError when rate limit is below 100', () => {
    const staticDir = createStaticDir();
    const stack = createStack();

    assert.throws(
      () =>
        new HostingConstruct(stack, 'Hosting', {
          manifest: spaManifest(staticDir),
          waf: { enabled: true, rateLimit: 50 },
          skipRegionValidation: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HostingError);
        assert.strictEqual(err.name, 'InvalidWafConfigError');
        return true;
      },
    );
  });

  void it('throws InvalidCertificateRegionError for non-us-east-1 cert', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    const badCert = Certificate.fromCertificateArn(
      stack,
      'BadCert',
      'arn:aws:acm:eu-west-1:123456789012:certificate/bad-cert',
    );

    assert.throws(
      () =>
        new HostingConstruct(stack, 'Hosting', {
          manifest: spaManifest(staticDir),
          domain: {
            domainName: 'www.example.com',
            hostedZone: 'example.com',
            certificate: badCert,
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof HostingError);
        assert.strictEqual(err.name, 'InvalidCertificateRegionError');
        return true;
      },
    );
  });

  void it('creates cache infrastructure when manifest.cache is present', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    const manifest: DeployManifest = {
      ...ssrManifest(staticDir, bundleDir),
      cache: {
        computeResource: 'default',
        tagRevalidation: true,
        revalidationQueue: true,
      },
    };

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest,
      skipRegionValidation: true,
    });

    assert.ok(construct.cacheBucket, 'Should have cacheBucket');
    assert.ok(construct.cacheTable, 'Should have cacheTable');
    assert.ok(construct.revalidationQueue, 'Should have revalidationQueue');

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: 'tag', KeyType: 'HASH' }),
        Match.objectLike({ AttributeName: 'path', KeyType: 'RANGE' }),
      ]),
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 30,
    });
  });

  void it('does not create cache infrastructure when manifest.cache is absent', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      skipRegionValidation: true,
    });

    assert.strictEqual(construct.cacheBucket, undefined);
    assert.strictEqual(construct.cacheTable, undefined);
    assert.strictEqual(construct.revalidationQueue, undefined);
  });
});

// ================================================================
// CSP / Security Headers (via hosting construct)
// ================================================================

void describe('HostingConstruct — CSP / Security Headers', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('uses managed SECURITY_HEADERS policy when cdn.contentSecurityPolicy is not set', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    // No custom ResponseHeadersPolicy resource should be created
    template.resourceCountIs('AWS::CloudFront::ResponseHeadersPolicy', 0);
    // The distribution should reference the managed SECURITY_HEADERS policy ID
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            ResponseHeadersPolicyId: '67f7725c-6f97-4210-82d7-5512b31e9d03',
          }),
        }),
      }),
    );
  });

  void it('uses custom CSP when cdn.contentSecurityPolicy is provided', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    const customCsp = "default-src 'none'; script-src 'self'";
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      cdn: { contentSecurityPolicy: customCsp },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties(
      'AWS::CloudFront::ResponseHeadersPolicy',
      Match.objectLike({
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            ContentSecurityPolicy: Match.objectLike({
              ContentSecurityPolicy: customCsp,
            }),
          }),
        }),
      }),
    );
  });

  void it('includes HSTS headers via managed policy (SECURITY_HEADERS includes HSTS by design)', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    // With no custom CSP, the managed SECURITY_HEADERS policy is used.
    // The managed policy includes HSTS, X-Content-Type-Options, X-Frame-Options,
    // X-XSS-Protection, and Referrer-Policy. Verify it's referenced:
    template.hasResourceProperties(
      'AWS::CloudFront::Distribution',
      Match.objectLike({
        DistributionConfig: Match.objectLike({
          DefaultCacheBehavior: Match.objectLike({
            ResponseHeadersPolicyId: '67f7725c-6f97-4210-82d7-5512b31e9d03',
          }),
        }),
      }),
    );
  });
});

// ================================================================
// CDN Edge Cases (via hosting construct)
// ================================================================

void describe('HostingConstruct — CDN edge cases', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('supports static-only mode (no compute functions)', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    const construct = new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    assert.strictEqual(
      construct.computeFunctions.size,
      0,
      'Should have no compute functions for SPA',
    );
    assert.strictEqual(
      construct.computeFunctionUrls.size,
      0,
      'Should have no compute function URLs for SPA',
    );

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        HttpVersion: 'http2and3',
      }),
    });
  });

  void it('sets TLS minimum protocol version to TLSv1.2_2021 with custom domain', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    const cert = Certificate.fromCertificateArn(
      stack,
      'TlsCert',
      'arn:aws:acm:us-east-1:123456789012:certificate/tls-test',
    );

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      domain: {
        domainName: 'tls.example.com',
        hostedZone: 'example.com',
        certificate: cert,
      },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        ViewerCertificate: Match.objectLike({
          MinimumProtocolVersion: 'TLSv1.2_2021',
        }),
      }),
    });
  });

  void it('configures custom error pages for SPA (403/404 → index.html)', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    // SPA fallback is now handled in the viewer-request CloudFront Function
    // (navigation requests rewrite to /index.html before hitting S3).
    // No custom error responses needed for 403/404 in SPA mode — missing
    // assets correctly 403 without being caught by a blanket fallback.
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          FunctionAssociations: Match.arrayWith([
            Match.objectLike({
              EventType: 'viewer-request',
            }),
          ]),
        }),
      }),
    });
  });

  void it('configures 5xx error pages for SSR mode', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 502 }),
          Match.objectLike({ ErrorCode: 503 }),
          Match.objectLike({ ErrorCode: 504 }),
        ]),
      }),
    });
  });

  void it('adds OAC S3 bucket policy for CloudFront access', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:GetObject',
            Principal: { Service: 'cloudfront.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  void it('supports geo-restriction via cdn prop', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      cdn: {
        geoRestriction: { type: 'whitelist', countries: ['US', 'CA'] },
      },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Restrictions: Match.objectLike({
          GeoRestriction: Match.objectLike({
            RestrictionType: 'whitelist',
            Locations: ['US', 'CA'],
          }),
        }),
      }),
    });
  });

  void it('uses default price class PRICE_CLASS_100', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        PriceClass: 'PriceClass_100',
      }),
    });
  });
});

// ================================================================
// Storage (via hosting construct)
// ================================================================

void describe('HostingConstruct — Storage', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates bucket with lifecycle rules', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'DeleteOldBuilds',
            Prefix: 'builds/',
            Status: 'Enabled',
          }),
          Match.objectLike({
            Id: 'ExpireNoncurrentVersions',
            Status: 'Enabled',
          }),
        ]),
      }),
    });
  });

  void it('sizes the asset-upload Lambda above CDK defaults (1024 MB / 1024 MiB tmp)', () => {
    // CDK defaults the BucketDeployment Lambda to 128 MB / 512 MiB tmp, which
    // large static sites overrun → opaque deploy failure. The L3 raises both.
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    // The asset-upload Lambda is the BucketDeployment handler — assert one
    // Lambda carries the raised memory + ephemeral storage.
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 1024,
      EphemeralStorage: { Size: 1024 },
    });
  });

  void it('honors storage.deployment overrides for the asset-upload Lambda', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      storage: { deployment: { memoryLimit: 2048, ephemeralStorageMiB: 4096 } },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 2048,
      EphemeralStorage: { Size: 4096 },
    });
  });

  void it('does NOT warn about resource count for a normal-sized stack', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });
    Annotations.fromStack(stack).hasNoWarning(
      '*',
      Match.stringLikeRegexp('approaching the hard limit'),
    );
  });

  void it('warns when the stack approaches the 500-resource CloudFormation limit', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });
    // Pad the stack past the 450 warning threshold with dummy resources so the
    // synth-time guard fires. (Real apps reach this via many routes/headers.)
    for (let i = 0; i < 460; i++) {
      new CfnResource(stack, `Dummy${i}`, { type: 'AWS::CloudFormation::WaitConditionHandle' });
    }
    Annotations.fromStack(stack).hasWarning(
      '*',
      Match.stringLikeRegexp('approaching the hard limit'),
    );
  });

  void it('creates bucket with BlockPublicAccess BLOCK_ALL', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      }),
    });
  });

  void it('uses S3_MANAGED encryption by default', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          },
        ],
      },
    });
  });

  void it('uses KMS encryption when storage.encryption is KMS', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      storage: { encryption: 'KMS' },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: 'aws:kms',
            }),
          },
        ],
      },
    });
  });

  void it('creates access log bucket when logging.enabled is true', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      logging: { enabled: true },
    });

    const template = Template.fromStack(stack);
    // Should have logging enabled on distribution
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Logging: Match.anyValue(),
      }),
    });
  });
});

// ================================================================
// KMS Key Policy Grants
// ================================================================

void describe('HostingConstruct — KMS Key Policy', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates KMS key when storage.encryption is KMS', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      storage: { encryption: 'KMS' },
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::KMS::Key', 1);
  });

  void it('KMS key policy grants kms:Decrypt to cloudfront.amazonaws.com', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      storage: { encryption: 'KMS' },
    });

    const template = Template.fromStack(stack);
    const keys = template.findResources('AWS::KMS::Key');
    assert.ok(Object.keys(keys).length > 0, 'Should have at least one KMS key');

    const keyResource = Object.values(keys)[0] as Record<
      string,
      Record<string, unknown>
    >;
    const keyPolicy = keyResource.Properties.KeyPolicy as Record<
      string,
      unknown
    >;
    const statements = keyPolicy['Statement'] as Array<Record<string, unknown>>;

    // Find the CloudFront decrypt statement
    const cfDecryptStatement = statements.find((stmt) => {
      const actions = stmt.Action;
      const principal = stmt.Principal as Record<string, unknown> | undefined;
      const service = principal?.Service;
      const hasDecrypt = Array.isArray(actions)
        ? actions.includes('kms:Decrypt')
        : actions === 'kms:Decrypt';
      const isCfPrincipal =
        service === 'cloudfront.amazonaws.com' ||
        (Array.isArray(service) &&
          service.some((s: string) => s === 'cloudfront.amazonaws.com'));
      return hasDecrypt && isCfPrincipal;
    });

    assert.ok(
      cfDecryptStatement,
      'KMS key policy must grant kms:Decrypt to cloudfront.amazonaws.com',
    );
  });

  void it('does NOT create KMS key when encryption is S3_MANAGED (default)', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    const keys = template.findResources('AWS::KMS::Key');
    assert.strictEqual(
      Object.keys(keys).length,
      0,
      'Should NOT create a KMS key with default S3_MANAGED encryption',
    );
  });

  void it('does NOT create KMS key when storage.encryption is explicitly S3_MANAGED', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      storage: { encryption: 'S3_MANAGED' },
    });

    const template = Template.fromStack(stack);
    const keys = template.findResources('AWS::KMS::Key');
    assert.strictEqual(
      Object.keys(keys).length,
      0,
      'Should NOT create a KMS key with explicit S3_MANAGED encryption',
    );
  });

  // ---- cdn.ssrDefaultTtl ----

  void describe('cdn.ssrDefaultTtl prop', () => {
    void it('sets CachePolicy DefaultTTL when provided', () => {
      const staticDir = createStaticDir();
      const bundleDir = createBundleDir();
      const stack = createStack();

      new HostingConstruct(stack, 'Hosting', {
        manifest: ssrManifest(staticDir, bundleDir),
        cdn: { ssrDefaultTtl: Duration.seconds(60) },
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties(
        'AWS::CloudFront::CachePolicy',
        Match.objectLike({
          CachePolicyConfig: Match.objectLike({
            DefaultTTL: 60,
          }),
        }),
      );
    });

    void it('defaults to 0 when ssrDefaultTtl is omitted', () => {
      const staticDir = createStaticDir();
      const bundleDir = createBundleDir();
      const stack = createStack();

      new HostingConstruct(stack, 'Hosting', {
        manifest: ssrManifest(staticDir, bundleDir),
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties(
        'AWS::CloudFront::CachePolicy',
        Match.objectLike({
          CachePolicyConfig: Match.objectLike({
            DefaultTTL: 0,
          }),
        }),
      );
    });
  });

  // ---- cdn.webAclArn ----

  void describe('cdn.webAclArn prop', () => {
    void it('uses provided ARN on the distribution WebACLId', () => {
      const staticDir = createStaticDir();
      const stack = createStack();
      // prettier-ignore
      // eslint-disable-next-line spellcheck/spell-checker
      const testArn = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/my-waf/abc123';

      new HostingConstruct(stack, 'Hosting', {
        manifest: spaManifest(staticDir),
        cdn: { webAclArn: testArn },
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          WebACLId: testArn,
        }),
      });
    });

    void it('does NOT create WAF construct when webAclArn is provided', () => {
      const staticDir = createStaticDir();
      const stack = createStack();
      // prettier-ignore
      // eslint-disable-next-line spellcheck/spell-checker
      const testArn = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/my-waf/abc123';

      new HostingConstruct(stack, 'Hosting', {
        manifest: spaManifest(staticDir),
        cdn: { webAclArn: testArn },
        waf: { enabled: true },
      });

      const template = Template.fromStack(stack);
      const webAcls = template.findResources('AWS::WAFv2::WebACL');
      assert.strictEqual(
        Object.keys(webAcls).length,
        0,
        'Should NOT create a WAF WebACL when cdn.webAclArn is provided',
      );
    });
  });
});

// ================================================================
// M4: Custom environment variables
// ================================================================

void describe('HostingConstruct — custom environment variables (M4)', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('adds custom environment variables to all compute Lambda functions', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      environment: {
        DATABASE_URL: 'postgres://localhost:5432/app',
        API_KEY: 'sk-test-123',
      },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          DATABASE_URL: 'postgres://localhost:5432/app',
          API_KEY: 'sk-test-123',
        }),
      },
    });
  });

  void it('does not add extra env vars when environment is not provided', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
    });

    const template = Template.fromStack(stack);
    const lambdas = template.findResources('AWS::Lambda::Function');
    for (const [, resource] of Object.entries(lambdas)) {
      const props = (resource as Record<string, Record<string, unknown>>)
        .Properties;
      const env = props?.Environment as Record<string, unknown> | undefined;
      const vars = env?.Variables as Record<string, unknown> | undefined;
      assert.strictEqual(
        vars !== undefined && 'DATABASE_URL' in vars,
        false,
        'Should not have DATABASE_URL when environment is not provided',
      );
    }
  });

  void it('adds env vars to ALL compute functions including image opt', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
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
          runtime: 'nodejs20.x',
        },
      },
      staticAssets: { directory: staticDir },
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/*', target: 'default' },
      ],
      buildId: 'multi-compute-test',
      imageOptimization: {
        bundle: bundleDir,
        handler: 'index.handler',
        formats: ['webp'],
        sizes: [640, 1920],
      },
    };

    new HostingConstruct(stack, 'Hosting', {
      manifest,
      environment: { MY_FEATURE_FLAG: 'enabled' },
    });

    const template = Template.fromStack(stack);
    // All user Lambda functions should have the env var
    const lambdas = template.findResources('AWS::Lambda::Function');
    const lambdasWithEnvVar = Object.entries(lambdas).filter(([, resource]) => {
      const props = (resource as Record<string, Record<string, unknown>>)
        .Properties;
      const env = props?.Environment as Record<string, unknown> | undefined;
      const vars = env?.Variables as Record<string, unknown> | undefined;
      return vars?.MY_FEATURE_FLAG === 'enabled';
    });
    // Both the default compute and image-optimization Lambda should have it (2 total)
    assert.strictEqual(
      lambdasWithEnvVar.length,
      2,
      `Expected exactly 2 Lambdas with MY_FEATURE_FLAG (default + image-opt), got ${lambdasWithEnvVar.length}`,
    );
  });

  void it('throws InvalidEnvironmentKeyError for invalid key characters', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();
    assert.throws(
      () => {
        new HostingConstruct(stack, 'Hosting', {
          manifest: ssrManifest(staticDir, bundleDir),
          environment: { 'invalid-key': 'value' },
        });
      },
      (err: HostingError) => {
        assert.strictEqual(err.name, 'InvalidEnvironmentKeyError');
        assert.ok(err.message.includes('invalid-key'));
        return true;
      },
    );
  });

  void it('throws ReservedEnvironmentKeyError for reserved prefix', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();
    assert.throws(
      () => {
        new HostingConstruct(stack, 'Hosting', {
          manifest: ssrManifest(staticDir, bundleDir),
          environment: { AWS_SECRET: 'forbidden' },
        });
      },
      (err: HostingError) => {
        assert.strictEqual(err.name, 'ReservedEnvironmentKeyError');
        assert.ok(err.message.includes('AWS_SECRET'));
        return true;
      },
    );
  });

  void it('throws ReservedEnvironmentKeyError for NODE_ prefix', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();
    assert.throws(
      () => {
        new HostingConstruct(stack, 'Hosting', {
          manifest: ssrManifest(staticDir, bundleDir),
          environment: { NODE_OPTIONS: '--require=/tmp/evil.js' },
        });
      },
      (err: HostingError) => {
        assert.strictEqual(err.name, 'ReservedEnvironmentKeyError');
        assert.ok(err.message.includes('NODE_OPTIONS'));
        return true;
      },
    );
  });

  void it('throws ReservedEnvironmentKeyError for LAMBDA_ prefix', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();
    assert.throws(
      () => {
        new HostingConstruct(stack, 'Hosting', {
          manifest: ssrManifest(staticDir, bundleDir),
          environment: { LAMBDA_TASK_ROOT: '/tmp' },
        });
      },
      (err: HostingError) => {
        assert.strictEqual(err.name, 'ReservedEnvironmentKeyError');
        assert.ok(err.message.includes('LAMBDA_TASK_ROOT'));
        return true;
      },
    );
  });

  void it('throws ReservedEnvironmentKeyError for exact reserved keys', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();
    assert.throws(
      () => {
        new HostingConstruct(stack, 'Hosting', {
          manifest: ssrManifest(staticDir, bundleDir),
          environment: { _HANDLER: 'override' },
        });
      },
      (err: HostingError) => {
        assert.strictEqual(err.name, 'ReservedEnvironmentKeyError');
        assert.ok(err.message.includes('_HANDLER'));
        return true;
      },
    );
  });

  void it('throws EnvironmentKeyTooLongError for keys exceeding 256 chars', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();
    const longKey = 'A'.repeat(257);
    assert.throws(
      () => {
        new HostingConstruct(stack, 'Hosting', {
          manifest: ssrManifest(staticDir, bundleDir),
          environment: { [longKey]: 'value' },
        });
      },
      (err: HostingError) => {
        assert.strictEqual(err.name, 'EnvironmentKeyTooLongError');
        assert.ok(err.message.includes('exceeds 256 character limit'));
        return true;
      },
    );
  });

  void it('throws EnvironmentValueTooLongError for values exceeding 8KB', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();
    const longValue = 'x'.repeat(8193);
    assert.throws(
      () => {
        new HostingConstruct(stack, 'Hosting', {
          manifest: ssrManifest(staticDir, bundleDir),
          environment: { MY_VAR: longValue },
        });
      },
      (err: HostingError) => {
        assert.strictEqual(err.name, 'EnvironmentValueTooLongError');
        assert.ok(err.message.includes('exceeds 8KB limit'));
        return true;
      },
    );
  });
});

// ================================================================
// M5: Custom error pages
// ================================================================

void describe('HostingConstruct — custom error pages (M5)', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates Custom404Deployment when notFound error page is provided', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    // Create a custom 404 HTML file
    const custom404Path = path.join(tmpDir, '404.html');
    fs.writeFileSync(custom404Path, '<html><body>Custom 404</body></html>');

    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      errorPages: { notFound: custom404Path },
    });

    const template = Template.fromStack(stack);
    // Should have BucketDeployment resources (at least the built-in error page + custom 404 + asset)
    const deployments = template.findResources('Custom::CDKBucketDeployment');
    assert.ok(
      Object.keys(deployments).length >= 3,
      `Expected at least 3 BucketDeployments (error + custom404 + assets), got ${Object.keys(deployments).length}`,
    );
  });

  void it('creates Custom500Deployment when serverError page is provided', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    // Create a custom 500 HTML file
    const custom500Path = path.join(tmpDir, '500.html');
    fs.writeFileSync(custom500Path, '<html><body>Custom 500</body></html>');

    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      errorPages: { serverError: custom500Path },
    });

    const template = Template.fromStack(stack);
    const deployments = template.findResources('Custom::CDKBucketDeployment');
    assert.ok(
      Object.keys(deployments).length >= 3,
      `Expected at least 3 BucketDeployments (error + custom500 + assets), got ${Object.keys(deployments).length}`,
    );
  });

  void it('adds CloudFront custom 404 error response when notFound is provided', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const custom404Path = path.join(tmpDir, '404.html');
    fs.writeFileSync(custom404Path, '<html><body>Custom 404</body></html>');

    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      errorPages: { notFound: custom404Path },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 404,
            ResponsePagePath: Match.stringLikeRegexp('/builds/.*/404\\.html'),
          }),
        ]),
      },
    });
  });

  void it('adds CloudFront custom 500 error response when serverError is provided', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const custom500Path = path.join(tmpDir, '500.html');
    fs.writeFileSync(custom500Path, '<html><body>Custom 500</body></html>');

    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      errorPages: { serverError: custom500Path },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 500,
            ResponseCode: 500,
            ResponsePagePath: Match.stringLikeRegexp('/builds/.*/500\\.html'),
          }),
        ]),
      },
    });
  });

  void it('preserves default error behavior when errorPages is not provided', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
    });

    const template = Template.fromStack(stack);
    // Default SSR behavior: 502/503/504 error responses pointing to _error.html
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 502,
            ResponsePagePath: Match.stringLikeRegexp(
              '/builds/.*/_error\\.html',
            ),
          }),
          Match.objectLike({
            ErrorCode: 503,
            ResponsePagePath: Match.stringLikeRegexp(
              '/builds/.*/_error\\.html',
            ),
          }),
          Match.objectLike({
            ErrorCode: 504,
            ResponsePagePath: Match.stringLikeRegexp(
              '/builds/.*/_error\\.html',
            ),
          }),
        ]),
      },
    });
    // Should NOT have custom 404/500 responses
    const distributions = template.findResources(
      'AWS::CloudFront::Distribution',
    );
    const distConfig = Object.values(distributions)[0] as Record<
      string,
      Record<string, unknown>
    >;
    const distProperties = distConfig.Properties?.DistributionConfig as
      | Record<string, unknown>
      | undefined;
    const errorResponses = (distProperties?.CustomErrorResponses ??
      []) as Array<Record<string, unknown>>;
    const has404 = errorResponses.some((r) => r.ErrorCode === 404);
    assert.strictEqual(
      has404,
      false,
      'Should not have 404 error response by default in SSR mode',
    );
  });

  void it('supports both notFound and serverError together', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const custom404Path = path.join(tmpDir, '404.html');
    const custom500Path = path.join(tmpDir, '500.html');
    fs.writeFileSync(custom404Path, '<html><body>Not Found</body></html>');
    fs.writeFileSync(custom500Path, '<html><body>Server Error</body></html>');

    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      errorPages: {
        notFound: custom404Path,
        serverError: custom500Path,
      },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 404,
            ResponsePagePath: Match.stringLikeRegexp('/builds/.*/404\\.html'),
          }),
          Match.objectLike({
            ErrorCode: 500,
            ResponseCode: 500,
            ResponsePagePath: Match.stringLikeRegexp('/builds/.*/500\\.html'),
          }),
        ]),
      },
    });
  });

  void it('throws CustomErrorPageNotFoundError for invalid file path', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();
    assert.throws(
      () => {
        new HostingConstruct(stack, 'Hosting', {
          manifest: ssrManifest(staticDir, bundleDir),
          errorPages: { notFound: '/nonexistent/path/404.html' },
        });
      },
      (err: HostingError) => {
        assert.strictEqual(err.name, 'CustomErrorPageNotFoundError');
        assert.ok(err.message.includes('/nonexistent/path/404.html'));
        return true;
      },
    );
  });

  void it('throws InvalidErrorPageContentError for non-HTML file', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const notHtmlPath = path.join(tmpDir, 'not-html.txt');
    fs.writeFileSync(notHtmlPath, 'This is just plain text, not HTML');

    const stack = createStack();
    assert.throws(
      () => {
        new HostingConstruct(stack, 'Hosting', {
          manifest: ssrManifest(staticDir, bundleDir),
          errorPages: { notFound: notHtmlPath },
        });
      },
      (err: HostingError) => {
        assert.strictEqual(err.name, 'InvalidErrorPageContentError');
        assert.ok(err.message.includes('does not appear to be valid HTML'));
        return true;
      },
    );
  });

  void it('configures custom error pages for SPA mode with CloudFront error responses', () => {
    const staticDir = createStaticDir();
    const custom404Path = path.join(tmpDir, '404.html');
    fs.writeFileSync(
      custom404Path,
      '<!DOCTYPE html><html><body>Custom SPA 404</body></html>',
    );

    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      errorPages: { notFound: custom404Path },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 404,
            ResponsePagePath: Match.stringLikeRegexp('/builds/.*/404\\.html'),
          }),
        ]),
      },
    });
  });

  void it('routes /builds/* asset re-fetches to S3 via the KVS router (no dedicated behavior)', () => {
    // CloudFront custom-error responses re-request /builds/<id>/<page>. In the
    // single-behavior model there is no dedicated /builds/* cache behavior:
    // the viewer-request router function detects the /builds/ prefix and sends
    // the request straight to the S3 origin (selectRequestOriginById). Assert
    // that wiring exists in the router source, and that no /builds/* behavior
    // is synthesized.
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const custom404Path = path.join(tmpDir, '404.html');
    fs.writeFileSync(custom404Path, '<html><body>Custom 404</body></html>');

    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      errorPages: { notFound: custom404Path },
    });

    const template = Template.fromStack(stack);
    const distConfig = (
      Object.values(
        template.findResources('AWS::CloudFront::Distribution'),
      )[0] as { Properties: { DistributionConfig: Record<string, unknown> } }
    ).Properties.DistributionConfig;
    const patterns = (
      (distConfig.CacheBehaviors as { PathPattern: string }[] | undefined) ?? []
    ).map((b) => b.PathPattern);
    assert.ok(
      !patterns.includes('/builds/*'),
      `/builds/* must not be a dedicated behavior; got ${JSON.stringify(patterns)}`,
    );
    // The router function short-circuits /builds/ requests to the S3 origin.
    const code = generateKvsRouterRequestCode();
    assert.ok(
      code.includes("uri.indexOf('/builds/') === 0"),
      'router must detect the /builds/ prefix',
    );
    assert.ok(
      code.includes('cf.selectRequestOriginById(meta.oS3)'),
      'router must send /builds/ requests to the S3 origin',
    );
  });

  void it('does not add /builds/* behavior in SPA mode without custom error pages', () => {
    const staticDir = createStaticDir();

    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
    });

    const template = Template.fromStack(stack);
    const distributions = template.findResources(
      'AWS::CloudFront::Distribution',
    );
    const distConfig = Object.values(distributions)[0] as Record<
      string,
      Record<string, unknown>
    >;
    const distProperties = distConfig.Properties?.DistributionConfig as
      | Record<string, unknown>
      | undefined;
    const cacheBehaviors = (distProperties?.CacheBehaviors ?? []) as Array<
      Record<string, unknown>
    >;
    const buildsBehavior = cacheBehaviors.find(
      (b) => b.PathPattern === '/builds/*',
    );
    assert.strictEqual(
      buildsBehavior,
      undefined,
      '/builds/* behavior should not exist in SPA mode without custom error pages',
    );
  });

  void it('throws ErrorPageTooLargeError for oversized error pages', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const largePath = path.join(tmpDir, 'large-404.html');
    const largeContent = '<html>' + 'x'.repeat(51 * 1024) + '</html>';
    fs.writeFileSync(largePath, largeContent);

    const stack = createStack();
    assert.throws(
      () => {
        new HostingConstruct(stack, 'Hosting', {
          manifest: ssrManifest(staticDir, bundleDir),
          errorPages: { notFound: largePath },
        });
      },
      (err: HostingError) => {
        assert.strictEqual(err.name, 'ErrorPageTooLargeError');
        assert.ok(err.message.includes('Maximum is 50KB'));
        return true;
      },
    );
  });
});

// ================================================================
// N6: Multi-domain + www redirect
// ================================================================

void describe('HostingConstruct — N6: Multi-domain + www redirect', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates A + AAAA records for each domain name in the array', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      domain: {
        domainName: ['example.com', 'www.example.com'],
        hostedZone: 'example.com',
      },
    });

    const template = Template.fromStack(stack);

    // Should have 4 records: A + AAAA for each domain
    const records = template.findResources('AWS::Route53::RecordSet');
    const recordEntries = Object.values(records);
    assert.strictEqual(
      recordEntries.length,
      4,
      'Should have 4 DNS records (A+AAAA per domain)',
    );

    const recordNames = recordEntries.map((r) =>
      String((r as Record<string, Record<string, unknown>>).Properties?.Name),
    );
    assert.ok(
      recordNames.some((n) => n === 'example.com' || n === 'example.com.'),
      `Expected a record for 'example.com' but got: ${JSON.stringify(recordNames)}`,
    );
    assert.ok(
      recordNames.some(
        (n) => n === 'www.example.com' || n === 'www.example.com.',
      ),
      `Expected a record for 'www.example.com' but got: ${JSON.stringify(recordNames)}`,
    );
  });

  void it('CloudFront distribution has multiple aliases for multi-domain', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      domain: {
        domainName: ['example.com', 'www.example.com'],
        hostedZone: 'example.com',
      },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['example.com', 'www.example.com'],
      }),
    });
  });

  void it('synthesizes a multi-domain distribution with wwwRedirect set (single-behavior router)', () => {
    // The legacy model emitted a dedicated www-redirect CloudFront Function
    // (matching code `startsWith('www.')`) and wired it as an extra
    // viewer-request association. The single-behavior KVS router replaces all
    // per-event functions with KvsRouterRequest/KvsRouterResponse, so the
    // standalone www-redirect function no longer exists. Setting wwwRedirect
    // must still synth cleanly with both aliases and exactly the two router
    // functions on cloudfront-js-2.0.
    //
    // NOTE: edge-side apex/www canonicalization is not yet re-expressed in the
    // KVS router; wwwRedirect is currently accepted but inert at the edge.
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    assert.doesNotThrow(() => {
      new HostingConstruct(stack, 'Hosting', {
        manifest: spaManifest(staticDir),
        domain: {
          domainName: ['example.com', 'www.example.com'],
          hostedZone: 'example.com',
          wwwRedirect: 'toApex',
        },
      });
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['example.com', 'www.example.com'],
      }),
    });

    // No legacy standalone www-redirect function; only the two router fns.
    const cfFunctions = template.findResources('AWS::CloudFront::Function');
    const functionCodes = Object.values(cfFunctions).map(
      (r) =>
        (r as Record<string, Record<string, unknown>>).Properties
          ?.FunctionCode as string,
    );
    assert.ok(
      !functionCodes.some((code) => code && code.includes("startsWith('www.')")),
      'legacy www-redirect CloudFront Function must not be present',
    );
    assert.strictEqual(
      Object.keys(cfFunctions).length,
      2,
      'only the two KVS router functions should exist',
    );
  });

  void it('does NOT generate a standalone www-redirect function when wwwRedirect is none', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      domain: {
        domainName: ['example.com'],
        hostedZone: 'example.com',
        wwwRedirect: 'none',
      },
    });

    const template = Template.fromStack(stack);
    const cfFunctions = template.findResources('AWS::CloudFront::Function');
    const functionCodes = Object.values(cfFunctions).map(
      (r) =>
        (r as Record<string, Record<string, unknown>>).Properties
          ?.FunctionCode as string,
    );
    const hasWwwRedirect = functionCodes.some(
      (code) => code && code.includes("startsWith('www.')"),
    );
    assert.ok(
      !hasWwwRedirect,
      'Should NOT have www redirect logic in CF Function',
    );
  });
});

// ================================================================
// P7: Build cache bucket
// ================================================================

void describe('HostingConstruct — P7: Build cache bucket', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('creates S3 bucket when buildCache.enabled is true', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      buildCache: { enabled: true },
    });

    const template = Template.fromStack(stack);

    // Should have at least one bucket with lifecycle (the build cache bucket)
    const buckets = template.findResources('AWS::S3::Bucket');
    const hasBuildCacheBucket = Object.values(buckets).some((b) => {
      const str = JSON.stringify(b);
      return str.includes('"ExpirationInDays":30');
    });
    assert.ok(
      hasBuildCacheBucket,
      'Should create a build cache bucket with 30-day lifecycle',
    );
  });

  void it('exports CfnOutput for build cache bucket name', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      buildCache: { enabled: true },
    });

    const template = Template.fromStack(stack);
    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);
    const hasBuildCacheOutput = outputKeys.some((k) =>
      k.includes('BuildCacheBucketName'),
    );
    assert.ok(
      hasBuildCacheOutput,
      'Should have BuildCacheBucketName CfnOutput',
    );
  });

  void it('sets HOSTING_BUILD_CACHE_BUCKET env var on compute functions', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      buildCache: { enabled: true },
    });

    const template = Template.fromStack(stack);
    const lambdas = template.findResources('AWS::Lambda::Function');
    const hasEnvVar = Object.values(lambdas).some((fn) => {
      const env = (
        fn as Record<
          string,
          Record<string, Record<string, Record<string, unknown>>>
        >
      ).Properties?.Environment?.Variables;
      return env && 'HOSTING_BUILD_CACHE_BUCKET' in env;
    });
    assert.ok(
      hasEnvVar,
      'Lambda should have HOSTING_BUILD_CACHE_BUCKET env var',
    );
  });

  void it('does NOT create build cache bucket when disabled', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const stack = createStack();

    new HostingConstruct(stack, 'Hosting', {
      manifest: ssrManifest(staticDir, bundleDir),
      buildCache: { enabled: false },
    });

    const template = Template.fromStack(stack);
    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);
    const hasBuildCacheOutput = outputKeys.some((k) =>
      k.includes('BuildCacheBucketName'),
    );
    assert.ok(
      !hasBuildCacheOutput,
      'Should NOT have BuildCacheBucketName CfnOutput',
    );
  });
});

// ================================================================
// P11: Cross-region WAF
// ================================================================

void describe('HostingConstruct — P11: Cross-region WAF', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('uses provided waf.webAclArn on the distribution WebACLId', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    const testArn =
      'arn:aws:wafv2:us-east-1:123456789012:global/webacl/my-waf/abc123';

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      waf: { enabled: true, webAclArn: testArn },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        WebACLId: testArn,
      }),
    });
  });

  void it('does NOT create WAF WebACL when waf.webAclArn is provided', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    const testArn =
      'arn:aws:wafv2:us-east-1:123456789012:global/webacl/my-waf/abc123';

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      waf: { enabled: true, webAclArn: testArn },
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
  });

  void it('creates WAF WebACL normally when webAclArn is NOT provided', () => {
    const staticDir = createStaticDir();
    const stack = createStack();

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      waf: { enabled: true },
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
  });

  void it('waf.webAclArn takes precedence over cdn.webAclArn', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    const wafArn =
      'arn:aws:wafv2:us-east-1:123456789012:global/webacl/waf-prop/111';
    const cdnArn =
      'arn:aws:wafv2:us-east-1:123456789012:global/webacl/cdn-prop/222';

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      waf: { enabled: true, webAclArn: wafArn },
      cdn: { webAclArn: cdnArn },
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        WebACLId: wafArn,
      }),
    });
  });
});

// ================================================================
// BYO domain + hostedZoneId
// ================================================================

void describe('HostingConstruct — BYO domain + hostedZoneId', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('domain with hostedZoneId uses fromHostedZoneId (no lookup)', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    const cert = Certificate.fromCertificateArn(
      stack,
      'Cert',
      'arn:aws:acm:us-east-1:123456789012:certificate/abc-123',
    );

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      domain: {
        domainName: ['example.com'],
        hostedZoneId: 'Z1234567890ABC',
        certificate: cert,
      },
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);

    // Should have A and AAAA records
    const records = template.findResources('AWS::Route53::RecordSet');
    const recordEntries = Object.values(records);
    assert.strictEqual(recordEntries.length, 2, 'Should have A + AAAA records');

    // Should have CloudFront alias
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['example.com'],
      }),
    });
  });

  void it('domain without hostedZone/hostedZoneId skips DNS records but sets CF aliases', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    const cert = Certificate.fromCertificateArn(
      stack,
      'Cert',
      'arn:aws:acm:us-east-1:123456789012:certificate/abc-123',
    );

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      domain: {
        domainName: ['custom.example.com'],
        certificate: cert,
      },
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);

    // Should NOT have Route53 records
    const records = template.findResources('AWS::Route53::RecordSet');
    assert.strictEqual(
      Object.keys(records).length,
      0,
      'Should have NO Route53 records for BYO domain',
    );

    // Should still have CloudFront alias
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['custom.example.com'],
      }),
    });
  });

  void it('outputs DistributionDomainName when domain is configured', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    const cert = Certificate.fromCertificateArn(
      stack,
      'Cert',
      'arn:aws:acm:us-east-1:123456789012:certificate/abc-123',
    );

    new HostingConstruct(stack, 'Hosting', {
      manifest: spaManifest(staticDir),
      domain: {
        domainName: ['custom.example.com'],
        certificate: cert,
      },
      skipRegionValidation: true,
    });

    const template = Template.fromStack(stack);
    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);
    const hasDistDomainOutput = outputKeys.some((k) =>
      k.includes('DistributionDomainName'),
    );
    assert.ok(
      hasDistDomainOutput,
      'Should have DistributionDomainName CfnOutput for BYO domain users',
    );
  });

  void it('throws MissingCertificateError when BYO domain has no cert and no hostedZone', () => {
    const staticDir = createStaticDir();
    const stack = createStack();

    assert.throws(
      () => {
        new HostingConstruct(stack, 'Hosting', {
          manifest: spaManifest(staticDir),
          domain: {
            domainName: ['example.com'],
          },
          skipRegionValidation: true,
        });
      },
      (err: HostingError) => {
        assert.strictEqual(err.name, 'MissingCertificateError');
        return true;
      },
    );
  });
});

// ================================================================
// Cache-Control split on static asset deployments (G19)
//
// The single-behavior KVS model means static assets ride the same CloudFront
// behavior as SSR, so the per-OBJECT Cache-Control headers (set on the S3
// BucketDeployments) are what actually controls browser/edge caching. A
// regression here silently collapses cache hit-rate. These assert the 3-tier
// split documented in hosting_construct.ts:
//   1. immutablePaths → `max-age=31536000, immutable`
//   2. *.html         → `no-cache, no-store, must-revalidate`
//   3. mutable assets → `s-maxage=31536000, max-age=0, must-revalidate`
// ================================================================

void describe('HostingConstruct — static asset Cache-Control split (G19)', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The BucketDeployment custom resource carries the Cache-Control in its
  // `SystemMetadata.cacheControl` (CDK lowercases the metadata key but the
  // string is what we assert).
  const cacheControlValues = (template: Template): string[] => {
    const deployments = template.findResources('Custom::CDKBucketDeployment');
    const values: string[] = [];
    for (const res of Object.values(deployments)) {
      const props = (res as { Properties?: Record<string, unknown> }).Properties ?? {};
      const sysMeta = props.SystemMetadata as { 'cache-control'?: string } | undefined;
      if (sysMeta?.['cache-control']) values.push(sysMeta['cache-control']);
    }
    return values;
  };

  void it('emits immutable, html-no-store, and mutable-edge-cache Cache-Control tiers', () => {
    const staticDir = createStaticDir();
    fs.writeFileSync(path.join(staticDir, 'app.abc123.js'), 'console.log(1)');
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: {
        version: 1,
        compute: {},
        staticAssets: {
          directory: staticDir,
          immutablePaths: ['*.abc123.js', '_next/static/*'],
        },
        routes: [{ pattern: '/*', target: 'static' }],
        buildId: 'cc-test-1',
      },
    });
    const template = Template.fromStack(stack);
    const ccs = cacheControlValues(template).join(' | ');

    assert.match(ccs, /max-age=31536000, immutable/, 'immutable tier present');
    assert.match(ccs, /no-cache, no-store, must-revalidate/, 'html no-store tier present');
    assert.match(
      ccs,
      /s-maxage=31536000, max-age=0, must-revalidate/,
      'mutable edge-cache tier present',
    );
  });

  void it('honors a custom staticAssets.cacheControl for the mutable tier', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: {
        version: 1,
        compute: {},
        staticAssets: {
          directory: staticDir,
          cacheControl: 'public, max-age=42',
        },
        routes: [{ pattern: '/*', target: 'static' }],
        buildId: 'cc-test-2',
      },
    });
    const template = Template.fromStack(stack);
    assert.match(cacheControlValues(template).join(' | '), /public, max-age=42/);
  });

  void it('deploys all asset objects under the immutable builds/<id>/ prefix (atomic deploy)', () => {
    const staticDir = createStaticDir();
    const stack = createStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: {
        version: 1,
        compute: {},
        staticAssets: { directory: staticDir },
        routes: [{ pattern: '/*', target: 'static' }],
        buildId: 'cc-test-3',
      },
    });
    const template = Template.fromStack(stack);
    const deployments = template.findResources('Custom::CDKBucketDeployment');
    const prefixes = Object.values(deployments)
      .map(
        (r) =>
          (r as { Properties?: { DestinationBucketKeyPrefix?: string } })
            .Properties?.DestinationBucketKeyPrefix,
      )
      .filter((p): p is string => typeof p === 'string');
    assert.ok(prefixes.length > 0, 'has asset deployments with a key prefix');
    for (const p of prefixes) {
      assert.match(p, /^builds\/cc-test-3\//, `prefix ${p} is under the build id`);
    }
  });
});
