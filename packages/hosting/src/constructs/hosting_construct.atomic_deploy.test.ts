import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { HostingConstruct } from './hosting_construct.js';
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

    const deployments = resourceIdsOfType(tpl, 'Custom::CDKBucketDeployment');
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
    assertFunctionsWaitForDeployments(
      tpl,
      rewriteFns,
      resourceIdsOfType(tpl, 'Custom::CDKBucketDeployment'),
    );
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

    const deployments = resourceIdsOfType(tpl, 'Custom::CDKBucketDeployment');
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
});
