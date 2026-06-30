import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { HostingConstruct } from './hosting_construct.js';
import { CdnConstruct } from './cdn_construct.js';
import { createSecurityHeadersPolicy } from './security_headers.js';
import { DeployManifest } from '../manifest/types.js';
import { SkewProtectionConfig } from './skew_protection.js';

// ============================================================================
// Atomic deploy window (403 elimination)
// ============================================================================
//
// Redeploys must be atomic for new/cookieless visitors: the CloudFront
// build-id functions rewrite every request to `/builds/<buildId>/...`, so
// they must NOT publish until that build's assets have been uploaded to the
// OAC-protected S3 bucket. Otherwise the new buildId propagates globally
// before the objects exist and CloudFront returns 403 Access Denied for the
// duration of the deploy.
//
// These tests assert the synthesized CloudFormation ordering:
//   1. the viewer-request (and assetPrefix strip) CF Function DependsOn every
//      asset BucketDeployment custom resource, and
//   2. no BucketDeployment carries a `/*` CloudFront invalidation anymore
//      (which is both useless under immutable build-id prefixes and was the
//      bad dependency that forced uploads to run AFTER the distribution).

type CfnTemplate = {
  Resources: Record<
    string,
    { Type: string; DependsOn?: string[]; Properties?: Record<string, unknown> }
  >;
};

let tmpDir: string;

const createStaticDir = (): string => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-atomic-test-'));
  fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
  // a content-hashed (immutable) asset and a mutable one so multiple asset
  // deployments are emitted.
  fs.writeFileSync(path.join(tmpDir, 'app.abcd1234.js'), 'console.log(1)');
  fs.writeFileSync(path.join(tmpDir, 'logo.png'), 'PNG');
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

const synth = (
  manifest: DeployManifest,
  skewProtection?: SkewProtectionConfig,
): CfnTemplate => {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  new HostingConstruct(stack, 'Hosting', {
    manifest,
    skipRegionValidation: true,
    ...(skewProtection ? { skewProtection } : {}),
  });
  return Template.fromStack(stack).toJSON() as CfnTemplate;
};

const resourceIdsOfType = (tpl: CfnTemplate, type: string): string[] =>
  Object.entries(tpl.Resources)
    .filter(([, r]) => r.Type === type)
    .map(([id]) => id);

/**
 * Logical ids of the asset BucketDeployments that write the new build's
 * `builds/<id>/` prefix. Excludes `IsrCacheSeed`: that deployment targets the
 * separate ISR cache bucket (NOT the build prefix) and is intentionally not a
 * dependency of the build-id functions, so a future ISR test that adds a
 * `cache.seedDirectory` must not make these "DependsOn every deployment"
 * assertions fail.
 */
const assetDeploymentIds = (tpl: CfnTemplate): string[] =>
  resourceIdsOfType(tpl, 'Custom::CDKBucketDeployment').filter(
    (id) => !/IsrCacheSeed/.test(id),
  );

/**
 * Logical ids of the CloudFront Functions that bake the buildId into the
 * request rewrite (the ones that flip routing to the new build). Excludes the
 * viewer-RESPONSE skew function and the compute forwarded-host function, which
 * do not rewrite to `/builds/<id>/`.
 */
const buildIdFunctionIds = (tpl: CfnTemplate): string[] =>
  Object.entries(tpl.Resources)
    .filter(
      ([id, r]) =>
        r.Type === 'AWS::CloudFront::Function' &&
        /(SkewProtectionRequestFunction|BuildIdRewriteFunction|AssetPrefixStripFunction)/.test(
          id,
        ),
    )
    .map(([id]) => id);

const assertFunctionsWaitForDeployments = (
  tpl: CfnTemplate,
  fnIds: string[],
  deployments: string[],
): void => {
  assert.ok(fnIds.length >= 1, 'expected at least one build-id CF Function');
  assert.ok(
    deployments.length >= 1,
    'expected at least one asset BucketDeployment',
  );
  for (const fnId of fnIds) {
    const dependsOn = tpl.Resources[fnId].DependsOn ?? [];
    for (const dep of deployments) {
      assert.ok(
        dependsOn.includes(dep),
        `build-id function ${fnId} must DependsOn asset deployment ${dep} ` +
          `(found: ${JSON.stringify(dependsOn)})`,
      );
    }
  }
};

void describe('Atomic deploy - build-id cutover waits for asset uploads', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  void it('viewer-request function DependsOn every asset BucketDeployment (skew enabled, default)', () => {
    const staticDir = createStaticDir();
    const tpl = synth({
      version: 1,
      compute: {},
      staticAssets: {
        directory: staticDir,
        immutablePaths: ['*.abcd1234.js'],
      },
      routes: [{ pattern: '/*', target: 'static' }],
      buildId: 'atomic-skew-1',
    });

    const deployments = assetDeploymentIds(tpl);
    assert.ok(
      deployments.length >= 2,
      `expected multiple asset deployments, got ${deployments.length}`,
    );
    // Default skew protection is on -> the viewer-request function is the
    // SkewProtectionRequestFunction.
    assertFunctionsWaitForDeployments(
      tpl,
      buildIdFunctionIds(tpl),
      deployments,
    );
  });

  void it('build-id rewrite function DependsOn asset deployments (skew disabled)', () => {
    const staticDir = createStaticDir();
    const tpl = synth(
      {
        version: 1,
        compute: {},
        staticAssets: {
          directory: staticDir,
          immutablePaths: ['*.abcd1234.js'],
        },
        routes: [{ pattern: '/*', target: 'static' }],
        buildId: 'atomic-noskew-1',
      },
      { enabled: false },
    );

    const rewriteFns = Object.keys(tpl.Resources).filter((id) =>
      /BuildIdRewriteFunction/.test(id),
    );
    assert.ok(
      rewriteFns.length >= 1,
      'expected a BuildIdRewriteFunction when skew protection is disabled',
    );
    assertFunctionsWaitForDeployments(tpl, rewriteFns, assetDeploymentIds(tpl));
  });

  void it('does NOT emit a /* CloudFront invalidation on any BucketDeployment', () => {
    const staticDir = createStaticDir();
    const tpl = synth({
      version: 1,
      compute: {},
      staticAssets: {
        directory: staticDir,
        immutablePaths: ['*.abcd1234.js'],
      },
      routes: [{ pattern: '/*', target: 'static' }],
      buildId: 'atomic-noinval-1',
    });

    // With immutable build-id prefixes there is nothing stale to invalidate:
    // each deploy writes to a brand-new builds/<id>/ prefix that was never
    // requested. A `/*` invalidation served no purpose AND created the
    // BucketDeployment -> Distribution dependency that re-opened the 403
    // window, so it was intentionally removed. The CDK BucketDeployment only
    // renders DistributionId / DistributionPaths when `distribution` is set,
    // so their absence proves the invalidation is gone.
    for (const [id, r] of Object.entries(tpl.Resources)) {
      const props = r.Properties ?? {};
      assert.ok(
        !('DistributionId' in props),
        `resource ${id} unexpectedly carries a DistributionId (invalidation)`,
      );
      assert.ok(
        !('DistributionPaths' in props),
        `resource ${id} unexpectedly carries DistributionPaths (invalidation)`,
      );
    }
  });

  void it('SSR build-id function waits for the error-page deployment too', () => {
    const staticDir = createStaticDir();
    const bundleDir = createBundleDir();
    const tpl = synth({
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
      staticAssets: {
        directory: staticDir,
        immutablePaths: ['*.abcd1234.js'],
      },
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/*', target: 'default' },
      ],
      buildId: 'atomic-ssr-1',
    });

    const deployments = assetDeploymentIds(tpl);
    // SSR mode ships the built-in error page under builds/<id>/ as well, and
    // it must also land before the cutover.
    assert.ok(
      deployments.some((id) => /ErrorPageDeployment/.test(id)),
      `expected an ErrorPageDeployment in SSR mode, got ${JSON.stringify(deployments)}`,
    );
    assertFunctionsWaitForDeployments(
      tpl,
      buildIdFunctionIds(tpl),
      deployments,
    );
  });

  void it('assetPrefix strip function DependsOn every asset BucketDeployment (Next.js)', () => {
    const staticDir = createStaticDir();
    const tpl = synth({
      version: 1,
      compute: {},
      assetPrefix: '/cdn-static',
      staticAssets: {
        directory: staticDir,
        immutablePaths: ['*.abcd1234.js'],
      },
      routes: [{ pattern: '/*', target: 'static' }],
      buildId: 'atomic-prefix-1',
    });

    // When the manifest carries `assetPrefix` (Next.js), the CDN adds an
    // AssetPrefixStripFunction that ALSO bakes in the `/builds/<buildId>/`
    // prefix, so it is a build-id cutover function and must wait for the asset
    // uploads exactly like the viewer-request function.
    const stripFns = Object.keys(tpl.Resources).filter((id) =>
      /AssetPrefixStripFunction/.test(id),
    );
    assert.ok(
      stripFns.length >= 1,
      'expected an AssetPrefixStripFunction when assetPrefix is set',
    );
    assertFunctionsWaitForDeployments(tpl, stripFns, assetDeploymentIds(tpl));
  });
});

// ============================================================================
// Self-enforcing guard (synth-time validation in CdnConstruct)
// ============================================================================
//
// The wiring that gates the build-id cutover on the asset uploads lives in the
// hosting construct (a loop calling `cdn.addBuildAssetDependency(dep)`). If a
// future change removes that loop - or adds a new asset BucketDeployment
// without registering it - the build-id functions would publish before the
// assets land and the 403 window silently re-opens. CdnConstruct carries a
// node validation that fails synth in that case, scoped so it never
// false-positives on a CdnConstruct that genuinely has no asset deployments.

void describe('Atomic deploy - CdnConstruct self-enforcing dependency guard', () => {
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const guardManifest = (
    buildId: string,
    directory: string,
  ): DeployManifest => ({
    version: 1,
    compute: {},
    staticAssets: { directory },
    routes: [{ pattern: '/*', target: 'static' }],
    buildId,
  });

  void it('synth fails when an asset BucketDeployment is left unregistered', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    // CdnConstruct creates the build-id CloudFront function(s)...
    new CdnConstruct(stack, 'Cdn', {
      bucket,
      manifest: guardManifest('guard-violate-1', staticDir),
      securityHeadersPolicy: policy,
    });
    // ...and an asset BucketDeployment writes the build prefix, but we
    // deliberately DON'T call cdn.addBuildAssetDependency(dep). This is the
    // exact regression that re-opens the 403 deploy window, so synth must fail.
    new BucketDeployment(stack, 'OrphanAssetDeployment', {
      sources: [Source.asset(staticDir)],
      destinationBucket: bucket,
      destinationKeyPrefix: 'builds/guard-violate-1/',
      prune: false,
    });
    assert.throws(
      () => Template.fromStack(stack),
      /addBuildAssetDependency/,
      'expected synth to fail when an asset deployment is left unregistered',
    );
  });

  void it('synth succeeds when the asset BucketDeployment IS registered', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    const cdn = new CdnConstruct(stack, 'Cdn', {
      bucket,
      manifest: guardManifest('guard-ok-1', staticDir),
      securityHeadersPolicy: policy,
    });
    const dep = new BucketDeployment(stack, 'AssetDeployment', {
      sources: [Source.asset(staticDir)],
      destinationBucket: bucket,
      destinationKeyPrefix: 'builds/guard-ok-1/',
      prune: false,
    });
    cdn.addBuildAssetDependency(dep);
    assert.doesNotThrow(() => Template.fromStack(stack));
  });

  void it('synth succeeds for a standalone CdnConstruct with no asset deployments', () => {
    const staticDir = createStaticDir();
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const bucket = new Bucket(stack, 'Bucket');
    const policy = createSecurityHeadersPolicy(stack, 'SH', {});
    // No BucketDeployment in the stack at all -> the guard must not fire
    // (mirrors the 50 standalone CdnConstruct unit tests).
    new CdnConstruct(stack, 'Cdn', {
      bucket,
      manifest: guardManifest('guard-noassets-1', staticDir),
      securityHeadersPolicy: policy,
    });
    assert.doesNotThrow(() => Template.fromStack(stack));
  });
});
