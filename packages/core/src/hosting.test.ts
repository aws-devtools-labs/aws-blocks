// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { config, secret } from '@aws-blocks/hosting';
import {
  _setSynthExistsChecker,
  _setSynthSecretFetcher,
  cf,
  type DoorInput,
  defineFrontDoor,
  type RouteBehavior,
} from '@aws-blocks/hosting/constructs';
import * as cdk from 'aws-cdk-lib';
import { App, Duration, Stack, Token } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Construct } from 'constructs';
import { claimApiFrontDoor, scheduleApiFrontDoor } from './cdk/api-front-door.js';
import { BlocksPresets } from './cdk/blocks-defaults.js';
import { coverBlocksRoot, forEachBlocksRole } from './cdk/blocks-roles.js';
import { applyBlocksPermissionsBoundary } from './cdk/permissions-boundary.js';
import { BLOCKS_RPC_PREFIX, BLOCKS_AUTH_PREFIX } from './constants.js';
import { BLOCKS_BUILD_ID_CONFIG_KEY } from './common/constants.js';
import { type BlocksStackApi, buildConfigJson, Hosting, type HostingProps } from './hosting.js';
import { clearRouteRegistry, compilePath, registerRoute, type RegisteredRoute } from './raw-route.js';

// ================================================================
// Hosting construct tests
//
// These validate that the Blocks wrapper around HostingConstruct
// produces the expected CloudFormation resources for SPA and SSR.
// ================================================================

const MOCK_API: BlocksStackApi = {
  apiUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api',
};

/** Helper: create a minimal SPA build output (dist/ with index.html). */
function createSpaBuildOutput(root: string): void {
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!DOCTYPE html><html><body>Hello</body></html>');
  fs.writeFileSync(path.join(distDir, 'main.js'), 'console.log("app")');
  // package.json without next → detected as SPA
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'test-spa', dependencies: { react: '^18' } }),
  );
}

/** Helper: create a minimal Next.js standalone build output. */
function createNextjsBuildOutput(root: string): void {
  // package.json with next dep → detected as nextjs
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'test-nextjs', dependencies: { next: '15.0.0', react: '^18' } }),
  );

  // Create .next dir so build output validation passes
  const nextDir = path.join(root, '.next');
  fs.mkdirSync(nextDir, { recursive: true });
  fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), 'test-build-id');

  // Create compute bundle directory with a handler
  const computeDir = path.join(root, '.hosting', 'compute', 'default');
  fs.mkdirSync(computeDir, { recursive: true });
  fs.writeFileSync(path.join(computeDir, 'index.mjs'), 'export const handler = async () => ({})');
  // run.sh for Lambda Web Adapter
  fs.writeFileSync(path.join(computeDir, 'run.sh'), '#!/bin/bash\nnode index.mjs');

  // Create static assets directory
  const staticDir = path.join(root, '.hosting', 'static');
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!DOCTYPE html><html><body>SSR</body></html>');
}

/**
 * Creates a fixture DeployManifest that mimics what the OpenNext adapter
 * would produce for a Next.js app. Used with `customAdapter` in unit tests
 * to avoid needing a real Next.js build + OpenNext binary.
 */
function createNextjsFixtureAdapter(root: string, opts: { streaming?: boolean } = {}) {
  return (_projectDir: string) => ({
    version: 1 as const,
    compute: {
      default: {
        type: 'handler' as const,
        bundle: path.join(root, '.hosting', 'compute', 'default'),
        handler: 'index.handler',
        placement: 'regional' as const,
        streaming: opts.streaming ?? true,
      },
    },
    staticAssets: {
      directory: path.join(root, '.hosting', 'static'),
    },
    routes: [
      { pattern: '/_next/static/*', target: 'static' },
      { pattern: '/*', target: 'default' },
    ],
  });
}

// ----------------------------------------------------------------

describe('Hosting', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-hosting-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearRouteRegistry();
  });

	// ── Deploy-time existence check (key change 4) ───────────────

	describe('environment marker existence check (Hosting.create)', () => {
		it('rejects at deploy when a declared environment secret has no value', async () => {
			createSpaBuildOutput(tmpDir);
			const app = new App();
			const stack = new Stack(app, 'MissingEnvSecretStack');
			// Stub the synth existence probe to report "not set" — rejects before any
			// CDK construction, so this needs no assets and no AWS.
			_setSynthExistsChecker(async () => {
				const e = new Error('missing') as Error & { name: string };
				e.name = 'ResourceNotFoundException';
				throw e;
			});
			try {
				await assert.rejects(
					Hosting.create(stack, 'Hosting', {
						root: tmpDir,
						api: MOCK_API,
						environment: { MISSING_SECRET: secret('MISSING_SECRET') },
					}),
					/MISSING_SECRET.*not set/s,
				);
			} finally {
				_setSynthExistsChecker(null);
			}
		});
	});

  // ── SPA tests ────────────────────────────────────────────────

  describe('SPA mode', () => {
    it('creates S3 bucket and CloudFront distribution', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'TestSpaStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);

      // CloudFront distribution
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);

      // At least one S3 bucket
      const buckets = template.findResources('AWS::S3::Bucket');
      assert.ok(Object.keys(buckets).length >= 1, 'Should have at least one S3 bucket');

      // No Lambda function (SPA = static only)
      template.resourceCountIs('AWS::Lambda::Url', 0);
    });

    it('auto-detects SPA framework from package.json without "next"', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'AutoDetectSpaStack');

      const hosting = new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      // Should produce a URL
      assert.ok(hosting.url.startsWith('https://'), 'URL should start with https://');
      // No SSR function
      assert.strictEqual(hosting.ssrFunction, undefined, 'SPA should not have ssrFunction');
    });

    it('writes placeholder to static assets and deploys real config via BucketDeployment', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'ConfigStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        backendConfig: { pluginA: 'valueA' },
      });

      // The static file should be a placeholder (not the real config) since CDK tokens
      // are only resolved at deploy time, not synth time.
      const configPath = path.join(tmpDir, '.hosting', 'static', '.blocks-sandbox', 'config.json');
      assert.ok(fs.existsSync(configPath), 'placeholder config.json should exist in static assets');

      const placeholder = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      assert.strictEqual(placeholder._placeholder, true, 'static file should be a placeholder');
      assert.strictEqual(placeholder.apiUrl, undefined, 'placeholder should NOT contain apiUrl (CDK token)');

      // The real config is deployed via BucketDeployment (Custom Resource)
      // which resolves CDK tokens at deploy time via CloudFormation.
      const template = Template.fromStack(stack);

      // BucketDeployment creates a Custom::CDKBucketDeployment resource.
      // Verify the destination key prefix ends with .blocks-sandbox.
      const customResources = template.findResources('Custom::CDKBucketDeployment');
      const crKeys = Object.keys(customResources);
      assert.ok(crKeys.length >= 1, 'Should have at least one BucketDeployment custom resource');

      const hasBlocksSandboxPrefix = crKeys.some((key) => {
        const props = (customResources[key] as Record<string, unknown>).Properties as
          | Record<string, unknown>
          | undefined;
        const prefix = props?.DestinationBucketKeyPrefix as string | undefined;
        return typeof prefix === 'string' && prefix.endsWith('.blocks-sandbox');
      });
      assert.ok(hasBlocksSandboxPrefix, 'BucketDeployment should target .blocks-sandbox prefix');
    });

    it('throws when build output directory does not exist', () => {
      // No build output, no buildCommand
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test', dependencies: { react: '^18' } }),
      );

      const app = new App();
      const stack = new Stack(app, 'MissingDistStack');

      assert.throws(
        () => {
          new Hosting(stack, 'Hosting', {
            root: tmpDir,
            api: MOCK_API,
          });
        },
        (err: Error) => {
          assert.ok(
            err.message.includes('Build output directory not found'),
            `Expected build dir error, got: ${err.message}`,
          );
          return true;
        },
      );
    });

    it('exposes bucket and distribution resources for composition', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'ComposeStack');

      const hosting = new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      assert.ok(hosting.bucket, 'Should expose bucket');
      assert.ok(hosting.bucket.bucketName, 'Bucket should have a name');
      assert.ok(hosting.distribution, 'Should expose distribution');
      assert.ok(hosting.distribution.distributionId, 'Distribution should have an ID');
    });

    it('creates CfnOutput for the hosting URL', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'OutputStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);
      const outputs = template.findOutputs('*');
      const outputKeys = Object.keys(outputs);
      const hostingOutput = outputKeys.find((k) => k.includes('HostingUrl'));
      assert.ok(hostingOutput, 'Should create a HostingUrl CfnOutput');
    });
  });

  // ── Next.js SSR tests ────────────────────────────────────────

  describe('Next.js SSR mode', () => {
    it('creates Lambda function fronted by API Gateway REST for SSR compute', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'TestSsrStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::CloudFront::Distribution', 1);
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
      });
      template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    });

    it('exposes ssrFunction', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'SsrFnStack');

      const hosting = new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
      });

      assert.ok(hosting.ssrFunction, 'Should expose ssrFunction for Next.js');
    });

    it('injects full API Gateway URL as BLOCKS_API_URL env var into SSR Lambda when api is provided', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'EnvVarStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            BLOCKS_API_URL: MOCK_API.apiUrl,
          }),
        }),
      });
    });

    it('injects BLOCKS_CONFIG env var when backendConfig is provided', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'FullConfigStack');

      const backendConfig = { pluginX: 'hello', pluginY: { nested: true } };

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        backendConfig,
      });

      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: Match.objectLike({
          Variables: Match.objectLike({
            BLOCKS_CONFIG: JSON.stringify(backendConfig),
          }),
        }),
      });
    });

    it('applies custom compute configuration', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'ComputeConfigStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        compute: {
          memorySize: 2048,
          timeout: Duration.seconds(120),
        },
      });

      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        MemorySize: 2048,
        Timeout: 120,
      });
    });

    it('auto-detects Next.js from package.json', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'AutoDetectNextStack');

      const hosting = new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
      });

      // Should detect Next.js and create SSR function
      assert.ok(hosting.ssrFunction, 'Auto-detected Next.js should have ssrFunction');
    });
  });

  // ── Infrastructure options tests ─────────────────────────────

  describe('Infrastructure options', () => {
    it('enables WAF when waf config is provided', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'WafStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        waf: { enabled: true, rateLimit: 500 },
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    });

    it('sets custom CSP header', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'CspStack');
      const customCsp = "default-src 'self'; script-src 'none'";

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        contentSecurityPolicy: customCsp,
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

    it('retains bucket when retainOnDelete is true', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'RetainStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        retainOnDelete: true,
      });

      const template = Template.fromStack(stack);
      const buckets = template.findResources('AWS::S3::Bucket');

      let foundRetain = false;
      for (const [, bucket] of Object.entries(buckets)) {
        if ((bucket as Record<string, unknown>).DeletionPolicy === 'Retain') {
          foundRetain = true;
        }
      }
      assert.ok(foundRetain, 'At least one bucket should have Retain deletion policy');
    });

    it('forwards buildRetentionDays to the hosting bucket lifecycle rule (#480)', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'RetentionStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        buildRetentionDays: 90,
      });

      const template = Template.fromStack(stack);
      // Before the fix, core dropped buildRetentionDays (only retainOnDelete was
      // forwarded), so this asserted 30. It must now reach the DeleteOldBuilds
      // rule as 90.
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: Match.objectLike({
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'DeleteOldBuilds',
              ExpirationInDays: 90,
            }),
          ]),
        }),
      });
    });
  });

  // ── cloudfront front door + Hosting coexistence (P2) ─────────────────
  //
  // When the app sets apiFrontDoor: 'cloudfront' AND fronts its frontend with Hosting in
  // the same stack, the API belongs on Hosting's distribution — the standalone
  // managed cloudfront distribution must stand down so there is exactly one.
  describe('cloudfront front door + Hosting claim', () => {
    it('leaves exactly one distribution (Hosting’s) when Hosting fronts the API under cloudfront', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'CloudFrontHostingClaimStack');

      // Simulate what BlocksStack.create() does under cloudfront: schedule the managed
      // front door over the shared gateway, then build Hosting in the same stack.
      // In production `props.api` IS the owner the aspect is scheduled on (the
      // BlocksStack), so its `claimApiFrontDoor` records the claim on that same
      // object; the aspect reads it back and stands down. Mirror that here by
      // backing the api's claim with the scheduled owner (`stack`).
      const api: BlocksStackApi = {
        apiUrl: MOCK_API.apiUrl,
        claimApiFrontDoor: (url) => claimApiFrontDoor(stack, url),
      };
      scheduleApiFrontDoor(stack, true, api.apiUrl);
      new Hosting(stack, 'Hosting', { root: tmpDir, api });

      const template = Template.fromStack(stack);
      // The managed front door stood down — only Hosting's single distribution remains.
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    });

    it('the claim is recorded on the backend instance, not in its stack’s state', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const backendStack = new Stack(app, 'BackendStack');
      const frontendStack = new Stack(app, 'FrontendStack');

      // The managed cloudfront front door is scheduled on the backend stack; a Hosting
      // built in a SEPARATE stack claims the role on the backend object (a live
      // reference), so the aspect — scheduled on that same object — reads the claim
      // and stands the managed distribution down. This pins the claim mechanism only:
      // a real BlocksStack with Hosting in another stack doesn't synthesize today
      // (Hosting registers its domain back into the backend's config, a
      // cross-stack cycle).
      const api: BlocksStackApi = {
        apiUrl: MOCK_API.apiUrl,
        claimApiFrontDoor: (url) => claimApiFrontDoor(backendStack, url),
      };
      scheduleApiFrontDoor(backendStack, true, api.apiUrl);
      new Hosting(frontendStack, 'Hosting', { root: tmpDir, api });

      // Managed cloudfront distribution stood down in the backend stack (the claim reached it through the backend object)...
      Template.fromStack(backendStack).resourceCountIs('AWS::CloudFront::Distribution', 0);
      // ...and only Hosting's distribution exists, in the frontend stack — carrying
      // the API behaviors, so the API is actually served from it.
      const frontend = Template.fromStack(frontendStack);
      frontend.resourceCountIs('AWS::CloudFront::Distribution', 1);
      const distConfig = Object.values(frontend.findResources('AWS::CloudFront::Distribution'))[0].Properties
        .DistributionConfig;
      const patterns = (distConfig.CacheBehaviors ?? []).map((b: { PathPattern: string }) => b.PathPattern);
      assert.ok(patterns.includes(BLOCKS_RPC_PREFIX), 'Hosting distribution carries the RPC behavior');
    });
  });

  // ── API integration tests ────────────────────────────────────

  describe('API integration', () => {
    it(`creates ${BLOCKS_RPC_PREFIX} and ${BLOCKS_RPC_PREFIX}/* CloudFront behaviors when api prop is provided`, () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'ApiBehaviorStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      assert.ok(distKeys.length >= 1, 'Should have at least one distribution');

      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;
      const cacheBehaviors = distConfig.CacheBehaviors ?? [];

      const apiExactPattern = cacheBehaviors.find((b: any) => b.PathPattern === BLOCKS_RPC_PREFIX);
      assert.ok(apiExactPattern, `Should have ${BLOCKS_RPC_PREFIX} exact cache behavior`);
      assert.strictEqual(apiExactPattern.ViewerProtocolPolicy, 'redirect-to-https');

      const apiWildcardPattern = cacheBehaviors.find((b: any) => b.PathPattern === `${BLOCKS_RPC_PREFIX}/*`);
      assert.ok(apiWildcardPattern, `Should have ${BLOCKS_RPC_PREFIX}/* cache behavior`);
      assert.strictEqual(apiWildcardPattern.ViewerProtocolPolicy, 'redirect-to-https');

      // AllowedMethods should include all methods for API proxy
      assert.deepStrictEqual(
        apiExactPattern.AllowedMethods.sort(),
        ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
        'API exact behavior should allow all HTTP methods',
      );
      assert.deepStrictEqual(
        apiWildcardPattern.AllowedMethods.sort(),
        ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
        'API wildcard behavior should allow all HTTP methods',
      );
    });

    it('attaches the distribution security-headers policy to the API and auth behaviors', () => {
      // The static root behavior carries a security-headers / CSP policy; the
      // API, auth and raw-route proxy behaviors must carry the same one, so no
      // behavior on the distribution serves responses without security headers.
      createSpaBuildOutput(tmpDir);

      // A raw route outside /aws-blocks/* gets its own behavior too; register
      // one so this test guards the raw-route tagging path, not just the
      // fixed /aws-blocks/* patterns.
      registerRoute({ method: 'GET', path: '/health', handler: async () => {} });

      const app = new App();
      const stack = new Stack(app, 'ApiHeadersStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distConfig = (distributions[Object.keys(distributions)[0]] as any).Properties.DistributionConfig;
      const defaultPolicy = distConfig.DefaultCacheBehavior.ResponseHeadersPolicyId;
      assert.ok(defaultPolicy, 'default behavior should have a ResponseHeadersPolicy');

      const cacheBehaviors = distConfig.CacheBehaviors ?? [];
      for (const pattern of [BLOCKS_RPC_PREFIX, `${BLOCKS_RPC_PREFIX}/*`, `${BLOCKS_AUTH_PREFIX}/*`, '/health']) {
        const behavior = cacheBehaviors.find((b: any) => b.PathPattern === pattern);
        assert.ok(behavior, `expected a behavior for ${pattern}`);
        assert.deepStrictEqual(
          behavior.ResponseHeadersPolicyId,
          defaultPolicy,
          `${pattern} should reuse the distribution's security-headers policy`,
        );
      }
    });

    it(`does not create ${BLOCKS_RPC_PREFIX}/* behavior when api prop is omitted`, () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'NoApiBehaviorStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      assert.ok(distKeys.length >= 1, 'Should have at least one distribution');

      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;
      const cacheBehaviors = distConfig.CacheBehaviors ?? [];

      const apiPattern = cacheBehaviors.find((b: any) => b.PathPattern === `${BLOCKS_RPC_PREFIX}/*`);
			assert.strictEqual(
				apiPattern,
				undefined,
				`Should NOT have ${BLOCKS_RPC_PREFIX}/* behavior when api is omitted`,
			);
    });

    // Regression: /api/* is the framework SSR namespace; Blocks must
    // not synthesize a CloudFront behavior there.
    it('does NOT claim the framework-reserved /api or /api/* prefix', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'NoApiPrefixStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distConfig = (distributions[Object.keys(distributions)[0]] as any).Properties.DistributionConfig;
      const cacheBehaviors = distConfig.CacheBehaviors ?? [];

      const apiExact = cacheBehaviors.find((b: any) => b.PathPattern === '/api');
      const apiWildcard = cacheBehaviors.find((b: any) => b.PathPattern === '/api/*');

      assert.strictEqual(apiExact, undefined, '/api must not be claimed by Blocks (framework SSR API namespace)');
			assert.strictEqual(
				apiWildcard,
				undefined,
				'/api/* must not be claimed by Blocks (framework SSR API namespace)',
			);
    });

    it('works without api prop (static-only site)', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'StaticOnlyStack');

      const hosting = new Hosting(stack, 'Hosting', {
        root: tmpDir,
      });

      assert.ok(hosting.url.startsWith('https://'), 'URL should start with https://');
      assert.ok(hosting.bucket, 'Should still expose bucket');
      assert.ok(hosting.distribution, 'Should still expose distribution');

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    });

    it(`config JSON contains relative ${BLOCKS_RPC_PREFIX} URL when api is provided`, () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'ConfigRelativeUrlStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        backendConfig: { region: 'us-east-1' },
      });

      const template = Template.fromStack(stack);
      const customResources = template.findResources('Custom::CDKBucketDeployment');
      const crKeys = Object.keys(customResources);
      assert.ok(crKeys.length >= 1, 'Should have at least one BucketDeployment');

      // The BucketDeployment source includes an S3 object with the JSON.
      // We can't easily inspect the content directly, but we can verify the
      // resource exists. The buildConfigJson() method is tested implicitly
      // through the SSR Lambda env var test.
    });

    it('does not set apiUrl in config JSON when api is omitted', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'ConfigNoApiStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        backendConfig: { region: 'us-east-1' },
      });

      // Should still deploy config (with backendConfig), just without apiUrl
      const template = Template.fromStack(stack);
      const customResources = template.findResources('Custom::CDKBucketDeployment');
      assert.ok(Object.keys(customResources).length >= 1, 'Should have BucketDeployment even without api');
    });

    it('emits a HostingBuildId output so a post-deploy liveness poll can match the served build', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'HostingBuildIdOutputStack');

      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API });

      const template = Template.fromStack(stack);
      // CDK suffixes a nested construct's CfnOutput logical id with a hash
      // (e.g. `HostingHostingBuildId8EDD8441`), and deploy.ts matches it by the
      // same `Hosting`+`BuildId` substring it uses on outputs.json — so match
      // by substring here too rather than an exact logical id.
      const outputs = template.toJSON().Outputs ?? {};
      const buildIdKeys = Object.keys(outputs).filter(
        (k) => k.includes('Hosting') && k.includes('BuildId'),
      );
      assert.equal(buildIdKeys.length, 1, 'exactly one HostingBuildId output should be emitted');
      // The value is the generated build id — a non-empty literal string.
      const value: unknown = outputs[buildIdKeys[0]].Value;
      if (typeof value !== 'string' || value.length === 0) {
        assert.fail('HostingBuildId output value should be a non-empty build id');
      }

      // Guard the PRODUCER half of the --wait-live contract: the config this
      // deploy serves must stamp the SAME build id under BLOCKS_BUILD_ID_CONFIG_KEY
      // that the HostingBuildId output advertises. Renaming/dropping either side
      // silently breaks every --wait-live deploy (the poll never matches), so
      // assert the stamp directly against the output value via the pure seam.
      const stamp = buildConfigJson({ root: tmpDir, api: MOCK_API }, value)[BLOCKS_BUILD_ID_CONFIG_KEY];
      assert.equal(stamp, value, 'config stamp must equal the HostingBuildId output value');
    });

    it('emits no HostingInvalidationId output for a pure-static deploy (no invalidation issued)', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'StaticNoInvalidationOutputStack');

      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API });

      const outputs = Template.fromStack(stack).toJSON().Outputs ?? {};
      const invKeys = Object.keys(outputs).filter((k) => k.includes('InvalidationId'));
      assert.equal(invKeys.length, 0, 'a pure-static deploy issues no invalidation, so no output');
    });

    it('emits a HostingInvalidationId output for a compute deploy so the liveness poll can wait on it', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'ComputeInvalidationOutputStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
      });

      const outputs = Template.fromStack(stack).toJSON().Outputs ?? {};
      const invKeys = Object.keys(outputs).filter(
        (k) => k.includes('Hosting') && k.includes('InvalidationId'),
      );
      assert.equal(invKeys.length, 1, 'exactly one HostingInvalidationId output should be emitted');
      // The value carries `<distributionId>/<invalidationId>` as CDK tokens, so
      // it resolves to a Fn::Join rather than a plain string — assert it is
      // present and non-trivial rather than a literal.
      assert.ok(outputs[invKeys[0]].Value !== undefined, 'HostingInvalidationId output should have a value');
    });

    it('does not inject BLOCKS_API_URL into SSR Lambda when api is omitted', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'SsrNoApiStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
      });

      const template = Template.fromStack(stack);

      // Lambda should exist (SSR) but should NOT have BLOCKS_API_URL
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'index.handler',
      });

      // Verify BLOCKS_API_URL is absent
      const lambdaFns = template.findResources('AWS::Lambda::Function');
      for (const [, fn] of Object.entries(lambdaFns)) {
        const env = (fn as any).Properties?.Environment?.Variables;
        if (env) {
					assert.strictEqual(
						env.BLOCKS_API_URL,
						undefined,
						'BLOCKS_API_URL should not be set when api is omitted',
					);
        }
      }
    });

    it(`adds CloudFront behaviors for RawRoute paths not under ${BLOCKS_RPC_PREFIX}/`, () => {
      createSpaBuildOutput(tmpDir);

      registerRoute({
        method: 'GET',
        path: '/health',
        handler: async () => {},
      });
      registerRoute({
        method: 'GET',
        path: '/users/{id}',
        handler: async () => {},
      });

      const app = new App();
      const stack = new Stack(app, 'RawRouteBehaviorStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;
      const cacheBehaviors = distConfig.CacheBehaviors ?? [];
      const patterns = cacheBehaviors.map((b: any) => b.PathPattern);

      assert.ok(patterns.includes('/aws-blocks/api/*'), 'Should have /aws-blocks/api/* behavior');
      assert.ok(patterns.includes('/health'), 'Should have /health behavior for RawRoute');
      assert.ok(patterns.includes('/users/*'), 'Should have /users/* behavior for parameterized RawRoute');
    });

    it('only adds RawRoute behaviors owned by the backend this distribution fronts', () => {
      createSpaBuildOutput(tmpDir);

      // The route registry is a process-global shared by every backend in a
      // multi-stack synth. Three routes: one owned by THIS distribution's
      // backend root, one owned by a DIFFERENT backend, and one owner-less
      // (a framework built-in / the runtime path). Only the first and the
      // owner-less one may reach this distribution — before ownership tagging,
      // every stack's CloudFront picked up every other stack's routes.
      const thisBackendId = 'OwnerFilterStack'; // a top-level stack's node.path == its id
      registerRoute({ method: 'GET', path: '/mine', handler: async () => {}, ownerRootId: thisBackendId });
      registerRoute({ method: 'GET', path: '/theirs', handler: async () => {}, ownerRootId: 'OtherBackend' });
      registerRoute({ method: 'GET', path: '/builtin', handler: async () => {} }); // owner-less → matches all

      const app = new App();
      const stack = new Stack(app, thisBackendId);

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distConfig = (distributions[Object.keys(distributions)[0]] as any).Properties.DistributionConfig;
      const patterns = (distConfig.CacheBehaviors ?? []).map((b: any) => b.PathPattern);

      assert.ok(patterns.includes('/mine'), 'own backend route must get a behavior');
      assert.ok(patterns.includes('/builtin'), 'owner-less (built-in) route must get a behavior');
      assert.ok(
        !patterns.includes('/theirs'),
        `a foreign backend's route must NOT leak into this distribution, got: ${JSON.stringify(patterns)}`,
      );
    });

    it('adds a CloudFront behavior for a route another core copy registered', () => {
      createSpaBuildOutput(tmpDir);

      // Synth has the same split as dispatch: a bundle can hold more than one
      // copy of @aws-blocks/core, and this loop reads whichever route table
      // its own copy owns. Register the way a second copy would — straight
      // into the shared state, not through this copy's registerRoute() — and
      // the behavior must still be emitted. With a module-local registry it
      // never is, and the route 404s at CloudFront before Lambda is reached.
      const REGISTRY_KEY = '__AWS_BLOCKS_RAW_ROUTE_REGISTRY_V1__';
      const state = (globalThis as typeof globalThis & { [REGISTRY_KEY]?: { routes: RegisteredRoute[] } })[
        REGISTRY_KEY
      ];
      assert.ok(state, `route registry state must live on globalThis['${REGISTRY_KEY}']`);

      const { pattern, paramNames } = compilePath('/from-other-copy');
      state.routes.push({
        method: 'GET',
        path: '/from-other-copy',
        pattern,
        paramNames,
        handler: async () => {},
      });

      const app = new App();
      const stack = new Stack(app, 'ForeignRouteBehaviorStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;
      const patterns = (distConfig.CacheBehaviors ?? []).map((b: any) => b.PathPattern);

      assert.ok(
        patterns.includes('/from-other-copy'),
        `synth must see routes from every core copy, got: ${JSON.stringify(patterns)}`,
      );
    });

    it('proxies the reserved /aws-blocks/auth subtree with a single behavior', () => {
      createSpaBuildOutput(tmpDir);

      // A route under the auth subtree (as the auth runtime would mount) must
      // NOT get its own behavior — the subtree wildcard covers it.
      registerRoute({
        method: 'GET',
        path: '/aws-blocks/auth/callback',
        handler: async () => {},
      });

      const app = new App();
      const stack = new Stack(app, 'AuthBehaviorStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distConfig = (distributions[Object.keys(distributions)[0]] as any).Properties.DistributionConfig;
      const cacheBehaviors = distConfig.CacheBehaviors ?? [];
      const patterns = cacheBehaviors.map((b: any) => b.PathPattern);

      assert.ok(patterns.includes('/aws-blocks/auth/*'), 'Should have /aws-blocks/auth/* behavior');
      assert.ok(
        !patterns.includes('/aws-blocks/auth/callback'),
        'A route under the auth subtree should be covered by the wildcard, not get its own behavior',
      );
    });

    it('deduplicates CloudFront behaviors for same path prefix', () => {
      createSpaBuildOutput(tmpDir);

      registerRoute({
        method: 'GET',
        path: '/webhooks/{id}',
        handler: async () => {},
      });
      registerRoute({
        method: 'POST',
        path: '/webhooks/{id}',
        handler: async () => {},
      });

      const app = new App();
      const stack = new Stack(app, 'DedupBehaviorStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;
      const cacheBehaviors = distConfig.CacheBehaviors ?? [];
      const webhookPatterns = cacheBehaviors.filter((b: any) => b.PathPattern === '/webhooks/*');

			assert.strictEqual(
				webhookPatterns.length,
				1,
				'Should have exactly one /webhooks/* behavior despite two routes',
			);
    });

    it('strips {param} segments from mixed param+wildcard routes for CloudFront patterns', () => {
      createSpaBuildOutput(tmpDir);

      registerRoute({
        method: 'GET',
        path: '/proxy/{version}/*',
        handler: async () => {},
      });

      const app = new App();
      const stack = new Stack(app, 'MixedParamWildcardStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;
      const cacheBehaviors = distConfig.CacheBehaviors ?? [];
      const patterns = cacheBehaviors.map((b: any) => b.PathPattern);

      assert.ok(patterns.includes('/proxy/*'), 'Should strip {version} and produce /proxy/*');
			assert.ok(
				!patterns.includes('/proxy/{version}/*'),
				'Should NOT have literal {version} in CloudFront pattern',
			);
    });

    it('converts param-only routes to wildcard patterns for CloudFront', () => {
      createSpaBuildOutput(tmpDir);

      registerRoute({
        method: 'GET',
        path: '/items/{id}/details/{detailId}',
        handler: async () => {},
      });

      const app = new App();
      const stack = new Stack(app, 'ParamOnlyPatternStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;
      const cacheBehaviors = distConfig.CacheBehaviors ?? [];
      const patterns = cacheBehaviors.map((b: any) => b.PathPattern);

      assert.ok(patterns.includes('/items/*'), 'Should produce /items/* from /items/{id}/details/{detailId}');
    });
  });

  // ── Issue #728: SSR cache policy honors origin Cache-Control ──

  describe('SSR cache policy (issue #728)', () => {
    it('uses a cache policy with minTTL=0, defaultTTL=0, maxTTL=31536000 for compute behaviors', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'SsrCachePolicyStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);

      // The L3 construct should create an SsrCachePolicy with these values.
      // maxTtl is 1 year (31536000s): it clamps wild origin Cache-Control
      // values to at most a year.
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          MinTTL: 0,
          DefaultTTL: 0,
          MaxTTL: 31536000,
        }),
      });
    });

    it('default behavior for SSR routes does NOT use CACHING_DISABLED', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'SsrNotDisabledStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
      });

      const template = Template.fromStack(stack);

      // The default behavior (catch-all SSR) should reference a custom cache policy,
      // NOT the managed CACHING_DISABLED policy (4135ea2d-6df8-44a3-9df3-4b5a84be39ad).
      // Verify a custom CachePolicy resource exists with SSR-appropriate TTL values.
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          MinTTL: 0,
          DefaultTTL: 0,
        }),
      });

      // Verify the distribution does NOT reference the managed CACHING_DISABLED policy ID directly
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;
      const defaultBehavior = distConfig.DefaultCacheBehavior;
      assert.ok(defaultBehavior, 'Should have a DefaultCacheBehavior');

      // In CDK templates, CachePolicyId is a { Ref } object pointing to the custom policy.
      // If it were a string matching the managed CACHING_DISABLED ID, that would be a bug.
      const cachePolicyId = defaultBehavior.CachePolicyId;
      assert.notStrictEqual(
        cachePolicyId,
        '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
        'SSR default behavior should NOT use managed CACHING_DISABLED policy',
      );
      // Confirm it's a Ref (pointing to a custom CachePolicy resource)
      assert.ok(
        typeof cachePolicyId === 'object' && cachePolicyId !== null,
        'CachePolicyId should be a CDK reference (object), not a literal string',
      );
    });

    it('forwards ssrDefaultTtl + cacheKeyCookies to the SSR cache policy', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'SsrCacheKeyForwardStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        ssrDefaultTtl: Duration.seconds(60),
        cacheKeyCookies: ['session'],
      });

      const template = Template.fromStack(stack);

      // DefaultTTL comes through as 60, and the session cookie lands in the
      // SSR cache-key cookie allowList alongside the reserved preview cookies.
      template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
        CachePolicyConfig: Match.objectLike({
          DefaultTTL: 60,
          ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
            CookiesConfig: Match.objectLike({
              Cookies: Match.arrayWith(['session']),
            }),
          }),
        }),
      });
    });
  });

  // ── Issue #729: timeout accepts number or Duration ──────────

  describe('Compute timeout normalization (issue #729)', () => {
    it('accepts timeout as a plain number (seconds)', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'TimeoutNumberStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        compute: {
          memorySize: 512,
          timeout: 45,
        },
      });

      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 45,
      });
    });

    it('accepts timeout as a cdk.Duration', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'TimeoutDurationStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        compute: {
          memorySize: 512,
          timeout: Duration.seconds(60),
        },
      });

      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Timeout: 60,
      });
    });

    it('works without timeout specified (uses default)', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'TimeoutDefaultStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        compute: {
          memorySize: 512,
        },
      });

      // Should not throw — synth completes successfully
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::Lambda::Function', {
        MemorySize: 512,
      });
    });
  });

  // ── CORS hosting origin registration tests ─────────────────────

  describe('CORS hosting origin registration', () => {
    it('registers CORS_HOSTING_ORIGINS via registerConfig when api prop is provided', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'CorsRegisterStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      // registerConfig with a CloudFront domain token means the
      // BucketDeployment (created by finalizeConfigRegistry) will
      // include CORS_HOSTING_ORIGINS in blocks-config.json.
      // The Hosting construct should NOT create any Custom Resource
      // for CORS — it simply calls registerConfig().
      const template = Template.fromStack(stack);

      // No Lambda function with the old CORS merge description
      const lambdas = template.findResources('AWS::Lambda::Function', {
        Properties: {
          Description: 'Merges CORS_HOSTING_ORIGINS into blocks-config.json after deployment',
        },
      });
      assert.strictEqual(Object.keys(lambdas).length, 0, 'Should NOT create a CORS merge Lambda');
    });

    it('registers the RAW CloudFront domain token (not an escaped dead literal)', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'CorsTokenRoundTripStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      // Read the registered value straight from the per-stack config registry,
      // matching how other synth-state tests inspect registerConfig() entries.
      const registry = (stack as any)[Symbol.for('BLOCKS_CONFIG_REGISTRY')] as
        | { entries: Map<string, unknown> }
        | undefined;
      assert.ok(registry, 'config registry exists on the stack');
      const value = registry.entries.get('CORS_HOSTING_ORIGINS');
      assert.ok(value !== undefined, 'CORS_HOSTING_ORIGINS is registered');

      // The default-domain origin is `https://<distributionDomainName>`, so the
      // registered value stays an unresolved token that resolves to the
      // distribution DomainName intrinsic — never a plain escaped string.
      assert.ok(Token.isUnresolved(value), 'CORS_HOSTING_ORIGINS must stay an unresolved token');
      assert.ok(
        JSON.stringify(stack.resolve(value)).includes('Fn::GetAtt'),
        'must resolve to the distribution DomainName intrinsic',
      );
    });

    it('routes origin config to the backend named by props.api, not the last-created backend', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'TwoBackendHostingStack');

      // Two branded backend roots sharing one stack. `A` is what the distribution
      // fronts; `B` is created last, so it is the ambient CURRENT_BLOCKS_STACK that
      // the previous `registerConfig(this, …)` path would have resolved to — the
      // bug this test guards against (both keys landing in B, A getting neither).
      const BRAND = Symbol.for('blocks:BackendRoot');
      const makeBackend = (id: string): BlocksStackApi => {
        const backend = new Construct(stack, id);
        (backend as unknown as Record<symbol, unknown>)[BRAND] = true;
        (backend as unknown as { apiUrl: string }).apiUrl =
          `https://${id}.execute-api.us-east-1.amazonaws.com/prod/aws-blocks`;
        return backend as unknown as BlocksStackApi;
      };
      const backendA = makeBackend('BackendA');
      const backendB = makeBackend('BackendB');

      const prevAmbient = (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;
      (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK = backendB;
      try {
        new Hosting(stack, 'WebA', { root: tmpDir, api: backendA });
      } finally {
        (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK = prevAmbient;
      }

      const entriesOf = (owner: unknown) =>
        (owner as Record<symbol, unknown>)[Symbol.for('BLOCKS_CONFIG_REGISTRY')] as
          | { entries: Map<string, unknown> }
          | undefined;

      const aEntries = entriesOf(backendA)?.entries;
      assert.ok(aEntries, 'the fronted backend A has a config registry');
      assert.ok(aEntries.has('BLOCKS_PUBLIC_ORIGIN'), 'BLOCKS_PUBLIC_ORIGIN lands in backend A');
      assert.ok(aEntries.has('CORS_HOSTING_ORIGINS'), 'CORS_HOSTING_ORIGINS lands in backend A');

      const bEntries = entriesOf(backendB)?.entries;
      const bGotOrigin = Boolean(
        bEntries?.has('BLOCKS_PUBLIC_ORIGIN') || bEntries?.has('CORS_HOSTING_ORIGINS'),
      );
      assert.strictEqual(bGotOrigin, false, 'the last-created backend B must NOT receive the origin config');
    });

    it('registers the raw custom-domain origin (not escaped, not anchored)', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'CorsCustomDomainStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });

      // A custom domain requires a certificate when no hostedZone is given
      // (mirrors the BYO-domain tests above).
      const cert = cdk.aws_certificatemanager.Certificate.fromCertificateArn(
        stack,
        'ImportedCert',
        'arn:aws:acm:us-east-1:123456789012:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      );

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        domain: {
          domainName: 'custom.example.com',
          certificate: cert,
        },
      });

      const registry = (stack as any)[Symbol.for('BLOCKS_CONFIG_REGISTRY')] as
        | { entries: Map<string, unknown> }
        | undefined;
      assert.ok(registry, 'config registry exists on the stack');
      const value = registry.entries.get('CORS_HOSTING_ORIGINS');
      // A custom domain resolves distributionUrl to a plain string at synth, so
      // Hosting registers the RAW origin. Escaping/anchoring is deferred to
      // runtime by getCorsPatterns(); the registered value must be untouched.
      assert.strictEqual(value, 'https://custom.example.com');
    });

    it('does not register CORS_HOSTING_ORIGINS when api prop is missing', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'NoCorsStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
      });

      // Without api prop, no CORS hosting origin should be registered
      const template = Template.fromStack(stack);
      const lambdas = template.findResources('AWS::Lambda::Function', {
        Properties: {
          Description: 'Merges CORS_HOSTING_ORIGINS into blocks-config.json after deployment',
        },
      });
      assert.strictEqual(Object.keys(lambdas).length, 0, 'No CORS merge Lambda when api is missing');
    });
  });

  // ── Multi-domain support ────────────────────────────────────────

  describe('Multi-domain support', () => {
    it('accepts an array of domain names', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'MultiDomainStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        domain: {
          domainName: ['example.com', 'www.example.com'],
          hostedZone: 'example.com',
        },
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;

      // Both domains should appear as CloudFront aliases
      assert.ok(distConfig.Aliases, 'Distribution should have Aliases');
      assert.ok(
        Array.isArray(distConfig.Aliases) && distConfig.Aliases.length === 2,
        `Should have 2 aliases, got ${JSON.stringify(distConfig.Aliases)}`,
      );
    });

    it('still accepts a single domain name string (backward compat)', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'SingleDomainStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        domain: {
          domainName: 'example.com',
          hostedZone: 'example.com',
        },
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;

      assert.ok(distConfig.Aliases, 'Distribution should have Aliases');
    });
  });

  // ── www redirect ────────────────────────────────────────────────

  describe('www redirect', () => {
    it('passes wwwRedirect config to the underlying construct', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'WwwRedirectStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });

      // Should not throw; the L3 handles redirect logic
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        domain: {
          domainName: ['example.com', 'www.example.com'],
          hostedZone: 'example.com',
          wwwRedirect: 'toApex',
        },
      });

      // If the L3 creates a CloudFront Function for redirect, it will show up
      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    });
  });

  // ── hostedZoneId ────────────────────────────────────────────────

  describe('hostedZoneId support', () => {
    it('accepts hostedZoneId to skip hosted zone lookup', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'HostedZoneIdStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });

      // Using hostedZoneId instead of hostedZone name avoids the
      // HostedZone.fromLookup() call (which requires context)
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        domain: {
          domainName: 'example.com',
          hostedZoneId: 'Z1234567890ABC',
        },
      });

      const template = Template.fromStack(stack);
      // DNS records should still be created
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    });
  });

  // ── BYO domain (no hostedZone) ─────────────────────────────────

  describe('BYO domain (external DNS)', () => {
    it('works without hostedZone when user manages DNS externally', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'ExternalDnsStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });

      // When hostedZone is omitted, a BYO certificate is required (the construct
      // cannot create one via DNS validation without a zone).
      const cert = cdk.aws_certificatemanager.Certificate.fromCertificateArn(
        stack,
        'ImportedCert',
        'arn:aws:acm:us-east-1:123456789012:certificate/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      );

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        domain: {
          domainName: 'custom.example.com',
          certificate: cert,
        },
      });

      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);

      // No Route53 records should be created
      const route53Records = template.findResources('AWS::Route53::RecordSet');
      assert.strictEqual(
        Object.keys(route53Records).length,
        0,
        'Should not create Route53 records when hostedZone is omitted',
      );
    });
  });

  // ── BYO WAF (webAclArn) ────────────────────────────────────────

  describe('BYO WAF', () => {
    it('uses existing WebACL ARN instead of creating a new one', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'ByoWafStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });

      const existingAclArn = 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/my-acl/abc123';

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        waf: {
          enabled: true,
          webAclArn: existingAclArn,
        },
      });

      const template = Template.fromStack(stack);

      // When webAclArn is provided, the L3 should NOT create a new WebACL
      template.resourceCountIs('AWS::WAFv2::WebACL', 0);

      // The distribution should reference the existing ACL
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;
			assert.strictEqual(
				distConfig.WebACLId,
				existingAclArn,
				'Distribution should reference the provided WebACL ARN',
			);
    });
  });

  // ── Build cache ────────────────────────────────────────────────

  describe('Build cache', () => {
    it('provisions build cache bucket when enabled', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'BuildCacheStack');

      const hosting = new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        buildCache: { enabled: true },
      });

      assert.ok(hosting.buildCacheBucket, 'Should expose buildCacheBucket when enabled');

      const template = Template.fromStack(stack);
      // Should have the build cache bucket output
      const outputs = template.findOutputs('*');
      const outputKeys = Object.keys(outputs);
      const buildCacheOutput = outputKeys.find((k) => k.includes('BuildCacheBucketName'));
      assert.ok(buildCacheOutput, 'Should create a BuildCacheBucketName CfnOutput');
    });

    it('does not provision build cache bucket when not configured', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'NoBuildCacheStack');

      const hosting = new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
      });

      assert.strictEqual(hosting.buildCacheBucket, undefined, 'Should not have buildCacheBucket by default');
    });
  });

  // ── Error pages ────────────────────────────────────────────────

  describe('Custom error pages', () => {
    it('passes errorPages config to the construct', () => {
      createSpaBuildOutput(tmpDir);

      // The construct validates error page files via fs.existsSync on the
      // provided path. Write the files to a known location and pass absolute paths.
      const notFoundPath = path.join(tmpDir, '404.html');
      const serverErrorPath = path.join(tmpDir, '500.html');
      fs.writeFileSync(notFoundPath, '<!DOCTYPE html><html><body>Not Found</body></html>');
      fs.writeFileSync(serverErrorPath, '<!DOCTYPE html><html><body>Server Error</body></html>');

      const app = new App();
      const stack = new Stack(app, 'ErrorPagesStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        errorPages: {
          notFound: notFoundPath,
          serverError: serverErrorPath,
        },
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;

      // When errorPages is set, CloudFront CustomErrorResponses should be configured
      const errorResponses = distConfig.CustomErrorResponses;
      assert.ok(errorResponses, 'Distribution should have CustomErrorResponses');
      const has404 = errorResponses.some((r: any) => r.ErrorCode === 404);
      assert.ok(has404, 'Should configure 404 error response');
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    });

    it('does not produce duplicate 404 responses when 404.html is in build output', () => {
      createSpaBuildOutput(tmpDir);

      // Simulate Vite copying public/404.html into dist/404.html —
      // this triggers the SPA adapter's auto-detection.
      const distDir = path.join(tmpDir, 'dist');
      fs.writeFileSync(path.join(distDir, '404.html'), '<!DOCTYPE html><html><body>Not Found</body></html>');
      fs.writeFileSync(path.join(distDir, '500.html'), '<!DOCTYPE html><html><body>Server Error</body></html>');

      // Also provide error pages via props (real paths for the construct's fs.existsSync check)
      const notFoundPath = path.join(tmpDir, '404.html');
      const serverErrorPath = path.join(tmpDir, '500.html');
      fs.writeFileSync(notFoundPath, '<!DOCTYPE html><html><body>Not Found</body></html>');
      fs.writeFileSync(serverErrorPath, '<!DOCTYPE html><html><body>Server Error</body></html>');

      const app = new App();
      const stack = new Stack(app, 'DuplicateErrorPagesStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        errorPages: {
          notFound: notFoundPath,
          serverError: serverErrorPath,
        },
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;

      // Verify no duplicate 404 error responses
      const errorResponses = distConfig.CustomErrorResponses;
      assert.ok(errorResponses, 'Distribution should have CustomErrorResponses');
      const error404Responses = errorResponses.filter((r: any) => r.ErrorCode === 404);
      assert.strictEqual(
        error404Responses.length,
        1,
        `Expected exactly one 404 error response but got ${error404Responses.length}`,
      );
    });
  });

  // ── Geo-restriction ────────────────────────────────────────────

  describe('Geo-restriction', () => {
    it('passes geo-restriction whitelist to CloudFront', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'GeoRestrictionStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        geoRestriction: { type: 'whitelist', countries: ['US', 'CA'] },
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;

      assert.ok(distConfig.Restrictions, 'Distribution should have Restrictions');
      const geoRestriction = distConfig.Restrictions?.GeoRestriction;
      assert.ok(geoRestriction, 'Should have GeoRestriction config');
      assert.strictEqual(geoRestriction.RestrictionType, 'whitelist');
      assert.deepStrictEqual(geoRestriction.Locations, ['US', 'CA']);
    });
  });

  // ── Logging ────────────────────────────────────────────────────

  describe('Access logging', () => {
    it('enables CloudFront access logging when configured', () => {
      createSpaBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'LoggingStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        logging: { enabled: true, retentionDays: 30 },
      });

      const template = Template.fromStack(stack);
      const distributions = template.findResources('AWS::CloudFront::Distribution');
      const distKeys = Object.keys(distributions);
      const distConfig = (distributions[distKeys[0]] as any).Properties.DistributionConfig;

      // When logging is enabled, the distribution should have a Logging config
      assert.ok(distConfig.Logging, 'Distribution should have Logging config');
    });
  });

  // ── Monitoring ─────────────────────────────────────────────────

  describe('Monitoring', () => {
    it('exposes monitoring surface (alarms + alarmTopics) when enabled', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'MonitoringStack');

      const hosting = new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        monitoring: { enabled: true },
      });

      assert.ok(hosting.monitoring, 'Should expose monitoring when enabled');
      assert.ok(
        hosting.monitoring.alarmTopics.length >= 1,
        'Should expose at least one alarm topic',
      );
      assert.ok(
        hosting.monitoring.alarms.length >= 1,
        'Should expose alarms',
      );
    });
  });

  // ── Skew protection ─────────────────────────────────────────────

  describe('Skew protection', () => {
    it('passes skewProtection config through to L3 construct', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'SkewProtectionStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        skewProtection: { enabled: true },
      });

      // Synth should succeed without throwing
      const template = Template.fromStack(stack);

      // The L3 creates a CloudFront Function for skew protection cookie handling
      // Verify distribution was created (synth success proves passthrough works)
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    });

    it('allows disabling skew protection', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'NoSkewStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        skewProtection: { enabled: false },
      });

      // Synth should succeed without throwing
      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    });
  });

  // ── basePath prop (caller-declared source of truth) ─────────
  // Under KVS edge routing, basePath is no longer expressed as a per-behavior
  // PathPattern prefix — it lives in the KVS route table's `meta.bp`, which the
  // edge router uses for the canonical 308 + static strip. So these tests read
  // the basePath out of the RouteStoreKeys custom resource's Entries.
  describe('basePath prop', () => {
    const metaBasePath = (root: string, basePath?: string): string => {
      const app = new App();
      const stack = new Stack(app, 'BasePathStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      new Hosting(stack, 'Web', {
        root,
        framework: 'spa',
        buildOutputDir: 'dist',
        ...(basePath !== undefined ? { basePath } : {}),
      });
      const tpl = Template.fromStack(stack).toJSON() as {
        Resources: Record<string, { Type: string; Properties?: any }>;
      };
      const kvKeys = Object.entries(tpl.Resources).find(
        ([id, r]) => r.Type === 'AWS::CloudFormation::CustomResource' && /RouteStoreKeys/.test(id),
      );
      assert.ok(kvKeys, 'expected a RouteStoreKeys custom resource');
      const entries = JSON.parse(kvKeys![1].Properties.Entries);
      const meta = JSON.parse(entries.meta);
      return meta.bp as string;
    };

    it('records basePath in the KVS route table when set (SPA, no framework base)', () => {
      createSpaBuildOutput(tmpDir);
      assert.strictEqual(metaBasePath(tmpDir, '/app'), '/app');
    });

    it('normalizes a trailing slash (/app/ → /app)', () => {
      createSpaBuildOutput(tmpDir);
      assert.strictEqual(metaBasePath(tmpDir, '/app/'), '/app');
    });

    it('treats "/" as no base path', () => {
      createSpaBuildOutput(tmpDir);
      assert.strictEqual(metaBasePath(tmpDir, '/'), '');
    });
  });

  // ── P0.4: config.json ordering dependency ────────────────────
  describe('config.json deploy ordering (P0.4)', () => {
    it('BlocksConfigDeployment depends on the asset deployments', () => {
      // The asset deployments upload the whole static dir — including the
      // placeholder `.blocks-sandbox/config.json` — to the same key the
      // resolved config writes to. Without an ordering dependency the
      // placeholder can clobber the real config. The previous
      // `tryFindChild('AssetDeployment')` never matched the real child ids
      // (AssetDeploymentImmutable/Html/Mutable), so the dep was never wired.
      createSpaBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'ConfigOrderStack');
      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API });

      const tpl = Template.fromStack(stack).toJSON() as {
        Resources: Record<string, { Type: string; DependsOn?: string[] }>;
      };
      const configId = Object.keys(tpl.Resources).find(
        (id) => /BlocksConfigDeployment/.test(id) && /CustomResource/.test(id),
      );
      assert.ok(configId, 'expected a BlocksConfigDeployment custom resource');

      const dependsOn = tpl.Resources[configId].DependsOn ?? [];
      const assetDeps = dependsOn.filter((d) => /AssetDeployment/.test(d));
      assert.ok(
        assetDeps.length >= 1,
        `BlocksConfigDeployment must DependsOn the asset deployment(s); ` +
          `found DependsOn=${JSON.stringify(dependsOn)}`,
      );

      const routeCutoverId = Object.entries(tpl.Resources).find(
        ([id, resource]) =>
          resource.Type === 'AWS::CloudFormation::CustomResource' &&
          /RouteStoreKeys/.test(id),
      )?.[0];
      assert.ok(routeCutoverId, 'expected a RouteStoreKeys cutover resource');

      const routeCutoverDeps = tpl.Resources[routeCutoverId].DependsOn ?? [];
      assert.ok(
        routeCutoverDeps.includes(configId),
        `RouteStoreKeys must DependsOn BlocksConfigDeployment; ` +
          `found DependsOn=${JSON.stringify(routeCutoverDeps)}`,
      );
    });
  });

  // ── value() integration ─────────────────────────────────────────
  //
  // Runtime values: the store LOCATOR (never the value) is injected as a Lambda
  // env var, and the role is granted read + kms:Decrypt. The store is derived from
  // the marker's type — secret → Secrets Manager, config → SSM Parameter Store.
  // Domain markers resolve at synth time via Hosting.create().

  describe('secret() / config() integration', () => {
    it('secret() → Secrets Manager: injects the locator (not the value) + grants read+decrypt', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'SecretEnvStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        environment: { STRIPE_KEY: secret('STRIPE_KEY') },
      });

      const template = Template.fromStack(stack);

      // secret → Secrets Manager: slash-free locator under the Blocks /blocks/secrets namespace.
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({ HOSTING_SECRET_PARAM_STRIPE_KEY: 'blocks/secrets/STRIPE_KEY' }),
        },
      });

      // The plaintext value must NOT appear anywhere in the template.
      const json = JSON.stringify(template.toJSON());
      assert.ok(!json.includes('STRIPE_KEY_VALUE'), 'no value should be in the template');

      // The role has secretsmanager:GetSecretValue scoped to the secret + kms:Decrypt.
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Action: 'secretsmanager:GetSecretValue' }),
            Match.objectLike({
              Action: 'kms:Decrypt',
              Condition: { StringEquals: Match.objectLike({ 'kms:ViaService': Match.anyValue() }) },
            }),
          ]),
        },
      });
    });

    it('threads secretStore { prefix, stage, cacheTtlSeconds } from core HostingProps to the wiring (B3)', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'SecretStoreOverrideStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        environment: { STRIPE_KEY: secret('STRIPE_KEY') },
        // Custom prefix + stage + warm-cache TTL must all reach the leaf wiring.
        secretStore: { prefix: '/myapp/secrets', stage: 'prod', cacheTtlSeconds: 30 },
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            // custom prefix + stage (Secrets Manager → slash-free)
            HOSTING_SECRET_PARAM_STRIPE_KEY: 'myapp/secrets/prod/STRIPE_KEY',
            // shared fallback (no stage)
            HOSTING_SECRET_PARAM_STRIPE_KEY_FALLBACK: 'myapp/secrets/STRIPE_KEY',
            // warm-cache TTL for rotation without a cold start
            HOSTING_SECRET_CACHE_TTL: '30',
          }),
        },
      });
    });

    it('config() → SSM: HOSTING_CONFIG_PARAM_* (leading-slash) + ssm:GetParameter', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'ConfigEnvStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        environment: { FEATURE_FLAGS: config('FEATURE_FLAGS') },
      });

      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({ HOSTING_CONFIG_PARAM_FEATURE_FLAGS: '/blocks/config/FEATURE_FLAGS' }),
        },
      });
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'ssm:GetParameter' })]) },
      });
    });

    it('does not inject a plaintext env var for a runtime value', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'SecretNoPlaintextStack');

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        environment: { FLAG: 'on', STRIPE_KEY: secret('STRIPE_KEY') },
      });

      const template = Template.fromStack(stack);
      const fns = template.findResources('AWS::Lambda::Function');
      for (const fn of Object.values(fns)) {
        const vars = ((fn as any).Properties?.Environment?.Variables ?? {}) as Record<string, unknown>;
        assert.strictEqual(vars.STRIPE_KEY, undefined, 'value key must not be a plaintext env var');
      }
    });

    it('rejects a runtime value whose key mismatches the env var name', () => {
      createNextjsBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'SecretMismatchStack');
      assert.throws(
        () =>
          new Hosting(stack, 'Hosting', {
            root: tmpDir,
            customAdapter: createNextjsFixtureAdapter(tmpDir),
            api: MOCK_API,
            environment: { STRIPE_KEY: secret('OTHER') },
          }),
        /must match the environment variable name/,
      );
    });

    it('throws if a domain marker is used with the sync constructor', () => {
      createSpaBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'SecretDomainSyncStack');
      assert.throws(
        () =>
          new Hosting(stack, 'Hosting', {
            root: tmpDir,
            api: MOCK_API,
            domain: { domainName: config('DOMAIN_PROD') },
          }),
        /requires async resolution/,
      );
    });
  });

  describe('config.json stale-placeholder guard (#173)', () => {
    // Helper: pull every BucketDeployment custom resource's Properties.
    const bucketDeployments = (stack: Stack) => {
      const crs = Template.fromStack(stack).findResources('Custom::CDKBucketDeployment');
      return Object.values(crs).map((cr) => (cr as { Properties: Record<string, unknown> }).Properties);
    };

    it('uploads the placeholder config.json with a no-cache directive, never the 1-year mutable cache-control', () => {
      // The build-time placeholder (`{_placeholder:true}`) is written into the
      // static dir. If it inherits the mutable asset tier's
      // `s-maxage=31536000` and an edge caches it during the deploy window, the
      // edge serves the placeholder for up to a year — breaking every client
      // API call. It must instead be uploaded as a no-cache path so the edge
      // never caches it long-term.
      createSpaBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'PlaceholderCacheStack');
      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API });

      const deployments = bucketDeployments(stack);
      const cc = (p: Record<string, unknown>) =>
        (p.SystemMetadata as Record<string, string> | undefined)?.['cache-control'];
      const includes = (p: Record<string, unknown>) => (p.Include as string[] | undefined) ?? [];
      const excludes = (p: Record<string, unknown>) => (p.Exclude as string[] | undefined) ?? [];

      // A deployment must upload `.blocks-sandbox/config.json` with the
      // no-cache directive (this is the placeholder upload).
      const noCacheDeploy = deployments.find(
				(p) =>
					includes(p).includes('.blocks-sandbox/config.json') &&
					cc(p) === 'no-cache, no-store, must-revalidate',
      );
      assert.ok(
        noCacheDeploy,
				'placeholder .blocks-sandbox/config.json must be uploaded with ' +
					'"no-cache, no-store, must-revalidate"',
      );

      // No deployment may cover the placeholder with the 1-year mutable
      // cache-control: the mutable/other tier must EXCLUDE it.
      const leaks = deployments.filter((p) => {
        const directive = cc(p);
        return (
          typeof directive === 'string' &&
          directive.includes('s-maxage=31536000') &&
          !excludes(p).includes('.blocks-sandbox/config.json')
        );
      });
      assert.strictEqual(
        leaks.length,
        0,
        'no mutable-tier deployment may apply s-maxage=31536000 to ' + '.blocks-sandbox/config.json',
      );
    });

    it('registers the placeholder as a no-cache path even for a static-only site (no api)', () => {
      // The placeholder is always written (step 5), so its no-cache
      // registration must not depend on `props.api`. This guards against a
      // regression that moves the registration inside an `if (props.api)`
      // block, which would reopen the stale-placeholder window for
      // static-only sites.
      createSpaBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'StaticOnlyPlaceholderStack');
      new Hosting(stack, 'Hosting', { root: tmpDir });

      Template.fromStack(stack).hasResourceProperties(
        'Custom::CDKBucketDeployment',
        Match.objectLike({
          Include: Match.arrayWith(['.blocks-sandbox/config.json']),
          SystemMetadata: Match.objectLike({
            'cache-control': 'no-cache, no-store, must-revalidate',
          }),
        }),
      );
    });

    it('invalidates the post-rewrite cache key (/builds/<id>/.blocks-sandbox/*)', () => {
      // The viewer-request skew-protection function rewrites the URI to
      // `/builds/<buildId>/.blocks-sandbox/config.json` BEFORE the cache
      // lookup, so the real edge cache key lives under `/builds/<id>/`.
      // Invalidating only `/.blocks-sandbox/*` never matches it.
      createSpaBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'InvalidationPathStack');
      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API });

      // Assert via Template + Match so a CDK property rename fails loudly here
      // rather than silently skipping a structural-heuristic lookup.
      Template.fromStack(stack).hasResourceProperties(
        'Custom::CDKBucketDeployment',
        Match.objectLike({
          DistributionPaths: Match.arrayWith([Match.stringLikeRegexp('^/builds/.+/\\.blocks-sandbox/\\*$')]),
        }),
      );
    });
  });

  describe('defaults.permissionsBoundary of the fronted backend', () => {
    const BOUNDARY_ARN = 'arn:aws:iam::123456789012:policy/app-ceiling';

    /**
     * A branded backend root (stand-in for BlocksBackend) wired the way
     * `setupBlocksInfra` wires one: role coverage on, then the boundary (if any).
     */
    const makeBackend = (stack: Stack, id: string, permissionsBoundary?: string): BlocksStackApi => {
      const backend = new Construct(stack, id);
      (backend as unknown as Record<symbol, unknown>)[Symbol.for('blocks:BackendRoot')] = true;
      (backend as unknown as { apiUrl: string }).apiUrl = `https://${id}.execute-api.eu-west-1.amazonaws.com/prod/aws-blocks`;
      (backend as unknown as { defaults: unknown }).defaults = { ...BlocksPresets.production, permissionsBoundary };
      coverBlocksRoot(backend);
      applyBlocksPermissionsBoundary(backend);
      return backend as unknown as BlocksStackApi;
    };

    /** Off-region Hosting with one Lambda@Edge route, beside (not under) `backend`. Returns every stack in the app. */
    const buildOffRegionEdgeHosting = (app: App, stack: Stack, backend: BlocksStackApi): Stack[] => {
      createNextjsBuildOutput(tmpDir);
      const edgeDir = path.join(tmpDir, '.hosting', 'compute', 'edge1');
      fs.mkdirSync(edgeDir, { recursive: true });
      fs.writeFileSync(path.join(edgeDir, 'index.mjs'), 'export const handler = async (e) => e.Records[0].cf.request;');
      const base = createNextjsFixtureAdapter(tmpDir);
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: backend,
        customAdapter: (dir: string) => {
          const manifest = base(dir);
          return {
            ...manifest,
            compute: {
              ...manifest.compute,
              edge1: { type: 'edge' as const, bundle: edgeDir, handler: 'index.handler', placement: 'global' as const },
            },
            routes: [{ pattern: '/edge/*', target: 'edge1' }, ...manifest.routes],
          };
        },
      });
      return app.node.children.filter((c): c is Stack => Stack.isStack(c));
    };

    const unboundedRoles = (stack: Stack) =>
      Object.entries(Template.fromStack(stack).findResources('AWS::IAM::Role'))
        .filter(([, r]) => r.Properties?.PermissionsBoundary !== BOUNDARY_ARN)
        .map(([id]) => id);

    it('caps SSR + Lambda@Edge roles, including the separate us-east-1 edge stack', () => {
      const app = new App();
      // Hosting sits beside (not under) the backend, as with an embedded BlocksBackend.
      const stack = new Stack(app, 'EdgeBoundaryStack', { env: { account: '123456789012', region: 'eu-west-1' } });
      const backend = makeBackend(stack, 'Blocks', BOUNDARY_ARN);
      // Outside us-east-1, Hosting adds two separate stacks: the Lambda@Edge
      // stack and the CloudFront monitoring stack (wired with cross-region refs).
      const stacks = buildOffRegionEdgeHosting(app, stack, backend);
      const edgeStack = stacks.find((c) => c.node.id.startsWith('edge-lambda-stack'));
      const monitoringStack = stacks.find((c) => c.node.id.includes('CfMonitoring'));
      assert.ok(edgeStack, 'cross-region Lambda@Edge should synthesize a separate edge stack');
      assert.ok(monitoringStack, 'off-region hosting should synthesize the us-east-1 monitoring stack');
      assert.ok(
        Object.keys(Template.fromStack(edgeStack).findResources('AWS::IAM::Role')).length > 0,
        'the edge stack should hold the Lambda@Edge role',
      );
      for (const s of stacks) {
        assert.deepStrictEqual(unboundedRoles(s), [], `every role in ${s.node.id} carries the boundary`);
      }
      // The cross-region export writer is added during prepare, after aspects run.
      assert.ok(
        Object.keys(Template.fromStack(stack).findResources('AWS::IAM::Role')).some((id) =>
          id.startsWith('CustomCrossRegionExportWriter'),
        ),
        'the cross-region export writer role is among the checked roles',
      );
    });

    it('a second role visitor (e.g. tenant tagging) reaches exactly the same roles, prepare-time ones included', () => {
      const app = new App();
      const stack = new Stack(app, 'EdgeVisitorStack', { env: { account: '123456789012', region: 'eu-west-1' } });
      const backend = makeBackend(stack, 'Blocks');
      // A test-only consumer of the shared role visitor: stamp a tag on every Blocks role.
      const visited = new Set<string>();
      forEachBlocksRole(backend as unknown as Construct, (role) => {
        visited.add(`${Stack.of(role).node.id}/${Stack.of(role).resolve(role.logicalId)}`);
        role.addPropertyOverride('Tags', [{ Key: 'app', Value: 'app-a' }]);
      });
      const stacks = buildOffRegionEdgeHosting(app, stack, backend);

      const inTemplates = new Set<string>();
      const untagged: string[] = [];
      for (const s of stacks) {
        for (const [id, r] of Object.entries(Template.fromStack(s).findResources('AWS::IAM::Role'))) {
          inTemplates.add(`${s.node.id}/${id}`);
          if (JSON.stringify(r.Properties?.Tags) !== JSON.stringify([{ Key: 'app', Value: 'app-a' }])) {
            untagged.push(`${s.node.id}/${id}`);
          }
        }
      }
      assert.deepStrictEqual(untagged, [], 'every role in every stack carries the visitor-applied tag');
      assert.deepStrictEqual([...visited].sort(), [...inTemplates].sort(), 'the visitor saw exactly the synthesized roles');
      assert.ok(
        [...visited].some((r) => r.includes('CustomCrossRegionExportWriter')),
        'the prepare-time cross-region provider role was visited',
      );
    });

    it('leaves Hosting roles untouched when the backend sets no boundary', () => {
      createNextjsBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'NoBoundaryHostingStack');
      new Hosting(stack, 'Hosting', { root: tmpDir, customAdapter: createNextjsFixtureAdapter(tmpDir), api: MOCK_API });

      const bounded = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Role')).filter(
        (r) => r.Properties?.PermissionsBoundary !== undefined,
      );
      assert.deepStrictEqual(bounded, []);
    });
  });

  describe("frontDoor: 'none' (served directly from S3 website — no front door)", () => {
    it('static SPA → an S3 website bucket and NO CloudFront distribution', () => {
      createSpaBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'NoneStaticStack', { env: { account: '111111111111', region: 'us-east-1' } });

      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: 'none' });

      const t = Template.fromStack(stack);
      // No front door: no CloudFront, no ALB — the bucket is served directly.
      t.resourceCountIs('AWS::CloudFront::Distribution', 0);
      t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
      // A public S3 website bucket (index + error documents for SPA fallback).
      t.hasResourceProperties('AWS::S3::Bucket', {
        WebsiteConfiguration: { IndexDocument: 'index.html', ErrorDocument: 'index.html' },
      });
    });

    it('publishes the resolved config.json to the website bucket root (.blocks-sandbox), and the build only there', () => {
      createSpaBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'NoneConfigStack', { env: { account: '111111111111', region: 'us-east-1' } });
      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: 'none' });
      const t = Template.fromStack(stack);
      const buckets = t.findResources('AWS::S3::Bucket');
      const website = Object.keys(buckets).find((id) => buckets[id].Properties?.WebsiteConfiguration);
      assert.ok(website, 'a website bucket');
      const deployments = Object.entries(t.findResources('Custom::CDKBucketDeployment'));
      const config = deployments.find(([id]) => id.includes('BlocksConfigDeployment'));
      assert.ok(config);
      assert.deepStrictEqual(config[1].Properties.DestinationBucketName, { Ref: website });
      assert.strictEqual(config[1].Properties.DestinationBucketKeyPrefix, '.blocks-sandbox');
      // The build is uploaded to the website bucket only: nothing reads a private copy.
      for (const [id, d] of deployments) {
        assert.deepStrictEqual(d.Properties.DestinationBucketName, { Ref: website }, `${id} writes to the website bucket`);
      }
    });

    it('SSR app → hard-fails at synth (no front door can run a server)', () => {
      createNextjsBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'NoneSsrStack', { env: { account: '111111111111', region: 'us-east-1' } });

      // 'none' serves static files only; the S3-website door refuses an app with
      // a server — never a silently broken deploy.
      assert.throws(
        () =>
          new Hosting(stack, 'Hosting', {
            root: tmpDir,
            customAdapter: createNextjsFixtureAdapter(tmpDir),
            api: MOCK_API,
            frontDoor: 'none',
          }),
        /RunServerRender|static|front door/i,
      );
    });
  });

  describe("frontDoor: { kind: 'custom', door } (bring-your-own free-form door)", () => {
    /** A door that wires the assets + API with the cf.* helpers and serves at a fixed literal address. */
    const edgeDoor = (seen: { input?: DoorInput } = {}) =>
      defineFrontDoor({
        service: 'my-edge',
        build(scope, input) {
          seen.input = input;
          new cdk.aws_cloudfront.Distribution(scope, 'Cdn', {
            defaultBehavior: { origin: cf.origin(input.origins.assets) },
            additionalBehaviors: cf.apiBehaviors(input.origins.api),
          });
          return { url: 'https://edge.example.com' };
        },
      });

    const configOf = (owner: unknown) =>
      (owner as Record<symbol, unknown>)[Symbol.for('BLOCKS_CONFIG_REGISTRY')] as
        | { entries: Map<string, unknown> }
        | undefined;

    it("the door's url becomes HostingUrl, Hosting.url, BLOCKS_PUBLIC_ORIGIN and CORS_HOSTING_ORIGINS", () => {
      createSpaBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'CustomDoorUrl', { env: { account: '111111111111', region: 'us-east-1' } });
      const hosting = new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'custom', door: edgeDoor() } });

      assert.strictEqual(hosting.url, 'https://edge.example.com');
      const outputs = Template.fromStack(stack).findOutputs('*');
      const hostingUrl = Object.entries(outputs).find(([k]) => k.includes('HostingUrl'))?.[1];
      assert.strictEqual(hostingUrl?.Value, 'https://edge.example.com');
      const entries = configOf(stack)?.entries;
      assert.strictEqual(entries?.get('BLOCKS_PUBLIC_ORIGIN'), 'https://edge.example.com');
      assert.strictEqual(entries?.get('CORS_HOSTING_ORIGINS'), 'https://edge.example.com');
      // A BYO door is not a built-in CloudFront door: Blocks adds no API behaviors
      // of its own, and `distribution` (still typed as before) is not available.
      assert.throws(() => hosting.distribution, /only available for a CloudFront front door/);
    });

    it("claims the API front-door role with the door's url (the managed API distribution stands down)", () => {
      createSpaBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'CustomDoorClaim', { env: { account: '111111111111', region: 'us-east-1' } });
      const claims: string[] = [];
      const api: BlocksStackApi = { apiUrl: MOCK_API.apiUrl, claimApiFrontDoor: (url) => claims.push(url) };
      new Hosting(stack, 'Hosting', { root: tmpDir, api, frontDoor: { kind: 'custom', door: edgeDoor() } });
      assert.deepStrictEqual(claims, ['https://edge.example.com']);
    });

    it("hands the door the backend's API, including its raw routes and the sign-in subset", () => {
      createSpaBuildOutput(tmpDir);
      registerRoute({ method: 'POST', path: '/webhooks/{id}', handler: async () => {} });
      const stack = new Stack(new App(), 'CustomDoorInput', { env: { account: '111111111111', region: 'us-east-1' } });
      const seen: { input?: DoorInput } = {};
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        waf: { enabled: true, rateLimit: 500 },
        frontDoor: { kind: 'custom', door: edgeDoor(seen) },
      });
      assert.deepStrictEqual(seen.input?.origins.api?.paths, ['/aws-blocks/*', '/webhooks/*']);
      assert.strictEqual(seen.input?.origins.api?.url, MOCK_API.apiUrl);
      assert.deepStrictEqual(
        seen.input?.features,
        { waf: { enabled: true, rateLimit: 500 }, skewProtection: { enabled: true, maxAge: 86400 } },
        'only what the app asked for (skew protection is on by default)',
      );
    });

    it('fails at synth when the door proxies none of the API paths (wiring check), unless turned off', () => {
      createSpaBuildOutput(tmpDir);
      const assetsOnly = defineFrontDoor({
        service: 'assets-only',
        build(scope, { origins }) {
          new cdk.aws_cloudfront.Distribution(scope, 'Cdn', { defaultBehavior: { origin: cf.origin(origins.assets) } });
          return { url: 'https://edge.example.com' };
        },
      });
      const synth = (id: string, wiringCheck?: boolean) =>
        new Hosting(new Stack(new App(), id, { env: { account: '111111111111', region: 'us-east-1' } }), 'Hosting', {
          root: tmpDir,
          api: MOCK_API,
          frontDoor: { kind: 'custom', door: assetsOnly, wiringCheck },
        });
      assert.throws(() => synth('CustomDoorUnwired'), /ProxySameOriginApi/);
      assert.doesNotThrow(() => synth('CustomDoorUnwiredOff', false));
    });

    it("onUpload's invalidation runs after the resolved config.json upload (BlocksConfigDeployment), not just the assets", () => {
      createSpaBuildOutput(tmpDir);
      const invalidatingDoor = defineFrontDoor({
        service: 'my-invalidating-cdn',
        build(scope, input) {
          const dist = new cdk.aws_cloudfront.Distribution(scope, 'Cdn', {
            defaultBehavior: { origin: cf.origin(input.origins.assets) },
            additionalBehaviors: cf.apiBehaviors(input.origins.api),
          });
          return {
            url: `https://${dist.distributionDomainName}`,
            onUpload: ({ uploads }) => {
              cf.invalidate(dist, { after: uploads });
            },
          };
        },
      });
      const stack = new Stack(new App(), 'CustomDoorInvalidationOrder', {
        env: { account: '111111111111', region: 'us-east-1' },
      });
      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'custom', door: invalidatingDoor } });
      const t = Template.fromStack(stack);
      const configIds = Object.keys(t.findResources('Custom::CDKBucketDeployment')).filter((id) =>
        id.includes('BlocksConfigDeployment'),
      );
      assert.strictEqual(configIds.length, 1, 'one resolved-config upload');
      const invalidations = Object.entries(t.findResources('Custom::AWS')).filter(([id]) => id.includes('BlocksInvalidation'));
      assert.strictEqual(invalidations.length, 1, 'one invalidation');
      const dependsOn = [invalidations[0][1].DependsOn ?? []].flat() as string[];
      assert.ok(
        dependsOn.includes(configIds[0]),
        `the invalidation depends on ${configIds[0]} (DependsOn: ${dependsOn.join(', ')})`,
      );
      // ...and still on every asset upload.
      const assetUploads = Object.keys(t.findResources('Custom::CDKBucketDeployment')).filter(
        (id) => !id.includes('BlocksConfigDeployment'),
      );
      assert.ok(assetUploads.length > 0);
      for (const id of assetUploads) assert.ok(dependsOn.includes(id), `the invalidation depends on ${id}`);
    });

    it('fails at synth when the door returns no url', () => {
      createSpaBuildOutput(tmpDir);
      const noUrl = defineFrontDoor({ service: 'no-url', build: () => ({ url: '' }) });
      const stack = new Stack(new App(), 'CustomDoorNoUrl', { env: { account: '111111111111', region: 'us-east-1' } });
      assert.throws(
        () => new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'custom', door: noUrl } }),
        /MissingFrontDoorUrlError|returned no `url`/,
      );
    });

    it('does not check features: a door that ignores a requested custom domain still synthesizes', () => {
      createSpaBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'CustomDoorNoFeatureCheck', { env: { account: '111111111111', region: 'us-east-1' } });
      assert.doesNotThrow(
        () =>
          new Hosting(stack, 'Hosting', {
            root: tmpDir,
            api: MOCK_API,
            domain: { domainName: 'app.example.com' },
            frontDoor: { kind: 'custom', door: edgeDoor() },
          }),
      );
    });
  });

  describe("every door's url is the app's public origin (HostingUrl, BLOCKS_PUBLIC_ORIGIN, CORS)", () => {
    // Each door's origin, resolved: the scheme and the resource attribute it is
    // built from — not `hosting.url` (the same variable), which would make the
    // check circular.
    const doors: Array<[string, HostingProps['frontDoor'], boolean, { scheme: string; type: string; attr: string; id?: RegExp }]> = [
      // A plain-HTTP door doesn't claim: native clients keep the backend's HTTPS API URL.
      ['alb', { kind: 'alb' }, false, { scheme: 'http://', type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', attr: 'DNSName' }],
      ['apiGateway', { kind: 'apiGateway' }, true, { scheme: '', type: 'AWS::ApiGatewayV2::Api', attr: 'ApiEndpoint' }],
      [
        'stacked',
        { kind: 'stacked', edge: 'cloudfront', router: 'alb' },
        true,
        { scheme: 'https://', type: 'AWS::CloudFront::Distribution', attr: 'DomainName', id: /CfOverAlb/ },
      ],
      ['none', 'none', false, { scheme: '', type: 'AWS::S3::Bucket', attr: 'WebsiteURL' }],
    ];
    for (const [label, frontDoor, claims, origin] of doors) {
      it(`${label}: registers the door url and ${claims ? 'claims' : 'does not claim'} the API front-door role`, () => {
        createSpaBuildOutput(tmpDir);
        const stack = new Stack(new App(), `PublicOrigin-${label}`, { env: { account: '111111111111', region: 'us-east-1' } });
        const claimed: string[] = [];
        const api: BlocksStackApi = { apiUrl: MOCK_API.apiUrl, claimApiFrontDoor: (url) => claimed.push(url) };
        const hosting = new Hosting(stack, 'Hosting', { root: tmpDir, api, frontDoor });
        const entries = (stack as unknown as Record<symbol, { entries: Map<string, unknown> } | undefined>)[
          Symbol.for('BLOCKS_CONFIG_REGISTRY')
        ]?.entries;
        const t = Template.fromStack(stack);
        const ids = Object.keys(t.findResources(origin.type)).filter((id) => !origin.id || origin.id.test(id));
        const expected = (resolved: unknown) => {
          const json = JSON.stringify(resolved);
          assert.ok(json.includes(origin.scheme), `${label}: ${json} starts with ${origin.scheme}`);
          assert.ok(
            ids.some((id) => json.includes(JSON.stringify({ 'Fn::GetAtt': [id, origin.attr] }))),
            `${label}: ${json} is built from ${origin.type}.${origin.attr}`,
          );
        };
        // The trusted origin is the door's only when it serves `/aws-blocks/*`:
        // an S3 website doesn't, so `'none'` publishes none.
        if (frontDoor === 'none') assert.strictEqual(entries?.has('BLOCKS_PUBLIC_ORIGIN'), false);
        else expected(stack.resolve(entries?.get('BLOCKS_PUBLIC_ORIGIN')));
        expected(stack.resolve(entries?.get('CORS_HOSTING_ORIGINS')));
        const outputs = t.findOutputs('*');
        expected(Object.entries(outputs).find(([k]) => k.includes('HostingUrl'))?.[1]?.Value);
        assert.deepStrictEqual(claimed, claims ? [hosting.url] : []);
        // `distribution` keeps its released type: the stacked door exposes its
        // CloudFront edge; a door with no CloudFront distribution throws on read.
        if (label === 'stacked') assert.ok(hosting.distribution.distributionId);
        else assert.throws(() => hosting.distribution, /only available for a CloudFront front door/);
      });
    }

    it('the REST door: the trusted and CORS origins are the bare domain, which a browser Origin matches', async () => {
      createSpaBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'PublicOrigin-rest', { env: { account: '111111111111', region: 'us-east-1' } });
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        frontDoor: {
          kind: 'apiGateway',
          api: 'rest',
          features: { domain: { domainName: 'app.example.com', hostedZone: 'example.com', hostedZoneId: 'Z123' } },
        },
      });
      const entries = (stack as unknown as Record<symbol, { entries: Map<string, unknown> } | undefined>)[
        Symbol.for('BLOCKS_CONFIG_REGISTRY')
      ]?.entries;
      assert.strictEqual(entries?.get('CORS_HOSTING_ORIGINS'), 'https://app.example.com');
      assert.strictEqual(entries?.get('BLOCKS_PUBLIC_ORIGIN'), 'https://app.example.com');
      const { _resetCorsPatterns, isOriginAllowed } = await import('./cors.js');
      const previous = process.env.CORS_HOSTING_ORIGINS;
      process.env.CORS_HOSTING_ORIGINS = String(entries?.get('CORS_HOSTING_ORIGINS'));
      _resetCorsPatterns();
      try {
        assert.strictEqual(isOriginAllowed('https://app.example.com'), true);
      } finally {
        if (previous === undefined) delete process.env.CORS_HOSTING_ORIGINS;
        else process.env.CORS_HOSTING_ORIGINS = previous;
        _resetCorsPatterns();
      }
    });

    it('the ALB door with a certificate and a custom domain: the origins are the domain', () => {
      createSpaBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'PublicOrigin-albdomain', { env: { account: '111111111111', region: 'us-east-1' } });
      const certificate = cdk.aws_certificatemanager.Certificate.fromCertificateArn(
        stack,
        'Cert',
        'arn:aws:acm:us-east-1:111111111111:certificate/c',
      );
      const claimed: string[] = [];
      const api: BlocksStackApi = { apiUrl: MOCK_API.apiUrl, claimApiFrontDoor: (url) => claimed.push(url) };
      const hosting = new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api,
        frontDoor: { kind: 'alb', certificate, features: { domain: { domainName: 'app.example.com', hostedZone: 'example.com', hostedZoneId: 'Z123' } } },
      });
      const entries = (stack as unknown as Record<symbol, { entries: Map<string, unknown> } | undefined>)[
        Symbol.for('BLOCKS_CONFIG_REGISTRY')
      ]?.entries;
      assert.strictEqual(hosting.url, 'https://app.example.com');
      assert.strictEqual(entries?.get('CORS_HOSTING_ORIGINS'), 'https://app.example.com');
      assert.deepStrictEqual(claimed, ['https://app.example.com'], 'an HTTPS ALB claims the API role');
    });
  });

  describe("frontDoor: { kind: 'apiGateway' } (API Gateway owns routing — no CloudFront)", () => {
    it('static SPA → a REGIONAL HTTP API v2 (default flavor — rootless $default stage), NO CloudFront, NO ALB', () => {
      createSpaBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'ApiGwStaticStack', { env: { account: '111111111111', region: 'us-east-1' } });

      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'apiGateway' } });

      const t = Template.fromStack(stack);
      t.resourceCountIs('AWS::CloudFront::Distribution', 0);
      t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
      // Default flavor is HTTP API v2 (rootless — a bare REST stage path would break
      // a SPA's root-absolute asset URLs); no REST API.
      t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
      t.resourceCountIs('AWS::ApiGateway::RestApi', 0);
      // Same-origin backend proxy (`/aws-blocks/*`) via a native HTTP proxy integration.
      t.hasResourceProperties('AWS::ApiGatewayV2::Integration', { IntegrationType: 'HTTP_PROXY' });
      // Private asset bucket read by the asset-proxy Lambda (no public website bucket).
      t.hasResourceProperties('AWS::Lambda::Function', {
        Environment: { Variables: { ASSET_KEY_PREFIX: Match.stringLikeRegexp('^builds/') } },
      });
    });

    it("api: 'rest' without a custom domain fails synth (its URL's `/prod` stage breaks root-relative links)", () => {
      createSpaBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'ApiGwRestStack', { env: { account: '111111111111', region: 'us-east-1' } });

      assert.throws(
        () => new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'apiGateway', api: 'rest' } }),
        (err: Error) => err.name === 'RestFrontDoorNeedsDomainError',
      );
    });

    it("api: 'rest' + a custom domain wires a regional cert + DomainName + Route 53 (root base-path mapping)", () => {
      createSpaBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'ApiGwDomainStack', { env: { account: '111111111111', region: 'us-east-1' } });

      // REST at a custom domain: the base-path mapping puts the app at the domain
      // root (no `/prod`). hostedZoneId avoids HostedZone.fromLookup() (needs context).
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        frontDoor: { kind: 'apiGateway', api: 'rest' },
        domain: { domainName: 'app.example.com', hostedZoneId: 'Z1234567890ABC' },
      });

      const t = Template.fromStack(stack);
      t.hasResourceProperties('AWS::ApiGateway::DomainName', {
        DomainName: 'app.example.com',
        EndpointConfiguration: { Types: ['REGIONAL'] },
      });
      t.resourceCountIs('AWS::ApiGateway::BasePathMapping', 1);
      t.resourceCountIs('AWS::CertificateManager::Certificate', 1);
      t.resourceCountIs('AWS::Route53::RecordSet', 2);
      t.resourceCountIs('AWS::CloudFront::Distribution', 0);
    });
  });

  describe("frontDoor: { kind: 'alb' } (regional ALB — no CloudFront)", () => {
    it('static SPA → an ALB + listener + Lambda target groups (asset-proxy + API-forwarder), NO CloudFront', () => {
      createSpaBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'AlbStaticStack', { env: { account: '111111111111', region: 'us-east-1' } });

      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'alb' } });

      const t = Template.fromStack(stack);
      t.resourceCountIs('AWS::CloudFront::Distribution', 0);
      t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
      t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
      // The ALB routes to Lambda targets (asset-proxy → S3, API-forwarder → backend).
      t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { TargetType: 'lambda' });
      // Private assets bucket read by the asset-proxy (no public website bucket).
      t.hasResourceProperties('AWS::Lambda::Function', {
        Environment: { Variables: { ASSET_KEY_PREFIX: Match.stringLikeRegexp('^builds/') } },
      });
    });
  });

  describe("every door routes the backend's raw routes same-origin (like the CloudFront default)", () => {
    /** Path values of every ALB listener rule. */
    const albPaths = (t: Template): string[] =>
      Object.values(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')).flatMap((r) =>
        (r.Properties.Conditions as Array<{ PathPatternConfig?: { Values: string[] } }>).flatMap(
          (c) => c.PathPatternConfig?.Values ?? [],
        ),
      );
    const cases: Array<[string, HostingProps['frontDoor'], (t: Template) => string[]]> = [
      ['alb', { kind: 'alb' }, albPaths],
      ['stacked', { kind: 'stacked', edge: 'cloudfront', router: 'alb' }, albPaths],
      [
        'apiGateway (http)',
        { kind: 'apiGateway' },
        (t) => Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map((r) => String(r.Properties.RouteKey)),
      ],
    ];
    for (const [label, frontDoor, routed] of cases) {
      it(`${label}: GET /hooks/door-probe and /users/{id} reach the backend`, () => {
        createSpaBuildOutput(tmpDir);
        registerRoute({ method: 'GET', path: '/hooks/door-probe', handler: async () => {} });
        registerRoute({ method: 'GET', path: '/users/{id}', handler: async () => {} });
        const stack = new Stack(new App(), `RawRoutes-${label.replace(/\W/g, '')}`, {
          env: { account: '111111111111', region: 'us-east-1' },
        });
        new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor });
        const paths = routed(Template.fromStack(stack)).join(' ');
        assert.match(paths, /\/hooks\/door-probe/, `${label} routes the raw route (got: ${paths})`);
        assert.match(paths, /\/users\/(\*|\{proxy\+\})/, `${label} routes the parameterized raw route`);
        assert.doesNotMatch(paths, /aws-blocks-auth/, 'no stale /aws-blocks-auth path');
      });
    }

    it('apiGateway (rest, custom domain): the raw route is a REST resource', () => {
      createSpaBuildOutput(tmpDir);
      registerRoute({ method: 'GET', path: '/hooks/door-probe', handler: async () => {} });
      const stack = new Stack(new App(), 'RawRoutesRest', { env: { account: '111111111111', region: 'us-east-1' } });
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        frontDoor: { kind: 'apiGateway', api: 'rest' },
        domain: { domainName: 'app.example.com', hostedZoneId: 'Z1234567890ABC' },
      });
      const parts = Object.values(Template.fromStack(stack).findResources('AWS::ApiGateway::Resource')).map((r) =>
        String(r.Properties.PathPart),
      );
      assert.ok(parts.includes('door-probe'), `REST resources: ${parts.join(', ')}`);
    });
  });

  describe('composed CF → ALB front door', () => {
    // The router is an ALB, which invokes the server without streaming.
    const BUFFERED = { streaming: false };
    it('stacks a CloudFront edge OVER a FULL ALB router (both exist), not one instead of the other', () => {
      createSpaBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'CfOverAlbStack', { env: { account: '111111111111', region: 'us-east-1' } });

      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' },
      });

      const t = Template.fromStack(stack);
      // The edge is a real (thin) CloudFront distribution (TLS, cache, WAF).
      t.resourceCountIs('AWS::CloudFront::Distribution', 1);
      // The router is a real regional ALB — the composition, not a swap.
      t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
      // Design B: the ALB routes to EVERYTHING via Lambda targets — the asset-proxy
      // (→ S3) and the API-forwarder (→ backend) for a SPA (no SSR/image compute).
      t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { TargetType: 'lambda' });
    });

    // ── Static routes from S3, dynamic ones through the ALB ──────────────────
    /** A manifest with the given routes over the Next.js fixture build (server compute `default`). */
    const routedAdapter =
      (root: string, routes: RouteBehavior[], extra: { redirects?: Array<{ source: string; destination: string; statusCode: 301 }> } = {}) =>
      (projectDir: string) => ({ ...createNextjsFixtureAdapter(root, BUFFERED)(projectDir), routes, ...extra });
    const edgeOf = (t: Template) => {
      const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0];
      const config = dist.Properties.DistributionConfig as {
        Origins: Array<{ Id: string; S3OriginConfig?: unknown; OriginAccessControlId?: unknown; CustomOriginConfig?: unknown }>;
        DefaultCacheBehavior: { TargetOriginId: string; FunctionAssociations?: Array<{ EventType: string }> };
        CacheBehaviors?: Array<{ PathPattern: string; TargetOriginId: string; FunctionAssociations?: Array<{ EventType: string }> }>;
      };
      const s3 = config.Origins.find((o) => o.S3OriginConfig);
      const alb = config.Origins.find((o) => o.CustomOriginConfig);
      const target = (id: string) => (id === s3?.Id ? 's3' : id === alb?.Id ? 'alb' : id);
      return {
        config,
        s3,
        alb,
        defaultTarget: target(config.DefaultCacheBehavior.TargetOriginId),
        behaviors: (config.CacheBehaviors ?? []).map((b) => [b.PathPattern, target(b.TargetOriginId)] as const),
      };
    };
    /** The edge's static viewer-request function, as a callable `handler(event)`. */
    const staticFunction = (t: Template): ((event: unknown) => { uri?: string; statusCode?: number; headers?: Record<string, { value: string }> }) => {
      const fns = Object.values(t.findResources('AWS::CloudFront::Function')).filter((f) =>
        String(f.Properties.FunctionCode).includes('resolveIndex'),
      );
      assert.strictEqual(fns.length, 1, 'one static viewer-request function');
      const handler = new Function(`${String(fns[0].Properties.FunctionCode)}\nreturn handler;`)();
      // CloudFront always hands the function the request's headers.
      return (event: unknown) => {
        const e = event as { request: { headers?: Record<string, { value: string }> } };
        return handler({ ...e, request: { headers: {}, ...e.request } });
      };
    };

    it('static SPA: the edge serves everything but the API straight from the private S3 bucket (OAC), the API through the ALB', () => {
      const t = stackedSynth('CfOverAlbS3Spa');
      const edge = edgeOf(t);
      assert.ok(edge.s3?.OriginAccessControlId, 'an S3 origin with origin access control');
      assert.strictEqual(edge.defaultTarget, 's3', 'the static catch-all is the S3 default behavior');
      assert.ok(
        edge.config.DefaultCacheBehavior.FunctionAssociations?.some((f) => f.EventType === 'viewer-request'),
        'the static path resolution runs at the edge',
      );
      assert.deepStrictEqual(
        edge.behaviors.find(([p]) => p === '/aws-blocks/*'),
        ['/aws-blocks/*', 'alb'],
        'the API goes through the ALB router',
      );
      // The edge distribution may read (and list, so a miss is a 404) the bucket.
      const policy = JSON.stringify(t.findResources('AWS::S3::BucketPolicy'));
      assert.match(policy, /s3:GetObject/);
      assert.match(policy, /s3:ListBucket/);
      assert.match(policy, /cloudfront\.amazonaws\.com/);
      // SPA fallback at the edge, as in the ALB asset proxy.
      const fn = staticFunction(t);
      // The build id is in the rewritten URI — the edge cache key — so a new
      // build is never served from the previous build's cached objects.
      assert.match(String(fn({ request: { uri: '/dashboard/settings' } }).uri), /^\/builds\/[^/]+\/index\.html$/);
      assert.match(String(fn({ request: { uri: '/assets/app-1.js' } }).uri), /^\/builds\/[^/]+\/assets\/app-1\.js$/);
      assert.match(String(fn({ request: { uri: '/.well-known/x' } }).uri), /^\/builds\/[^/]+\/\.well-known\/x$/);
      assert.ok(!('OriginPath' in (edge.s3 as Record<string, unknown>)) || (edge.s3 as Record<string, unknown>).OriginPath === '');
    });

    it('the static function (the build cutover at the edge) runs only after every asset upload of the build', () => {
      const t = stackedSynth('CfOverAlbS3Gate');
      const fnId = Object.entries(t.findResources('AWS::CloudFront::Function')).find(([, f]) =>
        String(f.Properties.FunctionCode).includes('resolveIndex'),
      )?.[0];
      assert.ok(fnId);
      const dependsOn = [t.findResources('AWS::CloudFront::Function')[fnId].DependsOn ?? []].flat() as string[];
      const uploads = Object.keys(t.findResources('Custom::CDKBucketDeployment')).filter(
        (id) => !id.includes('BlocksConfigDeployment'),
      );
      assert.ok(uploads.length > 0);
      for (const id of uploads) assert.ok(dependsOn.includes(id), `the function waits for ${id}`);
    });

    it('the static function also waits for the resolved config.json, and the config upload invalidates nothing on the stacked edge', () => {
      const t = stackedSynth('CfOverAlbConfigGate');
      const fns = t.findResources('AWS::CloudFront::Function');
      const fnId = Object.keys(fns).find((id) => String(fns[id].Properties.FunctionCode).includes('resolveIndex'));
      assert.ok(fnId);
      const config = Object.entries(t.findResources('Custom::CDKBucketDeployment')).find(([id]) => id.includes('BlocksConfigDeployment'));
      assert.ok(config);
      const dependsOn = [fns[fnId].DependsOn ?? []].flat() as string[];
      assert.ok(dependsOn.includes(config[0]), 'the cutover waits for the resolved config');
      // The new build's config key was never cached (the edge rewrites to /builds/<id>/…).
      assert.strictEqual(config[1].Properties.DistributionId, undefined);
    });

    it("the static function rewrites to this deploy's own build prefix, and strips the basePath first", () => {
      createSpaBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'CfOverAlbBuildId', { env: { account: '111111111111', region: 'us-east-1' } });
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        basePath: '/app',
        frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' },
      });
      const t = Template.fromStack(stack);
      const buildId = Object.entries(t.findOutputs('*')).find(([k]) => k.includes('HostingBuildId'))?.[1]?.Value;
      assert.ok(typeof buildId === 'string' && buildId.length > 0);
      const fn = staticFunction(t);
      assert.strictEqual(fn({ request: { uri: '/app/assets/a.js' } }).uri, `/builds/${buildId}/assets/a.js`);
      assert.strictEqual(fn({ request: { uri: '/app/dashboard' } }).uri, `/builds/${buildId}/index.html`);
    });

    it('security headers on the default behavior and every S3 behavior; the S3 default has index.html as root object', () => {
      const t = stackedSynth('CfOverAlbHeadersEverywhere');
      const edge = edgeOf(t);
      const policies = Object.keys(t.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
      assert.strictEqual(policies.length, 1);
      const ref = { Ref: policies[0] };
      const def = edge.config.DefaultCacheBehavior as unknown as { ResponseHeadersPolicyId?: unknown };
      assert.deepStrictEqual(def.ResponseHeadersPolicyId, ref, 'the S3 default behavior carries the security headers');
      const all = (edge.config.CacheBehaviors ?? []) as unknown as Array<{ PathPattern: string; ResponseHeadersPolicyId?: unknown }>;
      assert.ok(all.length > 0);
      for (const b of all) assert.deepStrictEqual(b.ResponseHeadersPolicyId, ref, `${b.PathPattern} carries the security headers`);
      assert.strictEqual((edge.config as unknown as { DefaultRootObject?: string }).DefaultRootObject, 'index.html');
    });

    it('router behaviors: the viewer host as x-forwarded-host; the API uncached; the SSR default keys cookies', () => {
      createNextjsBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'CfOverAlbRouterBehaviors', { env: { account: '111111111111', region: 'us-east-1' } });
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        customAdapter: createNextjsFixtureAdapter(tmpDir, BUFFERED),
        frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' },
      });
      const t = Template.fromStack(stack);
      const fns = t.findResources('AWS::CloudFront::Function');
      const hostFn = Object.keys(fns).find((id) => String(fns[id].Properties.FunctionCode).includes('x-forwarded-host'));
      assert.ok(hostFn, 'a function copies the viewer host');
      const run = new Function(`${String(fns[hostFn].Properties.FunctionCode)}\nreturn handler;`)() as (e: unknown) => {
        headers: Record<string, { value: string }>;
      };
      assert.strictEqual(run({ request: { headers: { host: { value: 'd1.cloudfront.net' } } } }).headers['x-forwarded-host']?.value, 'd1.cloudfront.net');
      const edge = edgeOf(t);
      type B = { PathPattern?: string; CachePolicyId?: unknown; FunctionAssociations?: Array<{ EventType: string; FunctionARN: unknown }> };
      const def = edge.config.DefaultCacheBehavior as unknown as B;
      const behaviors = (edge.config.CacheBehaviors ?? []) as unknown as B[];
      const api = behaviors.find((b) => b.PathPattern === '/aws-blocks/*');
      assert.ok(api);
      // CachingDisabled (the AWS-managed policy).
      assert.strictEqual(api.CachePolicyId, '4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
      const viewerRequest = (b: B) => JSON.stringify(b.FunctionAssociations?.filter((f) => f.EventType === 'viewer-request'));
      assert.ok(viewerRequest(api).includes(hostFn));
      assert.ok(viewerRequest(def).includes(hostFn), 'the SSR default sees the public host');
      const policies = t.findResources('AWS::CloudFront::CachePolicy');
      const policyOf = (b: B) => policies[(b.CachePolicyId as { Ref: string }).Ref]?.Properties.CachePolicyConfig;
      assert.strictEqual(policyOf(def).ParametersInCacheKeyAndForwardedToOrigin.CookiesConfig.CookieBehavior, 'all');
    });

    it('SSR: the edge is invalidated after the uploads, the resolved config, the cutover and the new server', () => {
      createNextjsBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'CfOverAlbInvalidate', { env: { account: '111111111111', region: 'us-east-1' } });
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        customAdapter: createNextjsFixtureAdapter(tmpDir, BUFFERED),
        frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' },
      });
      const t = Template.fromStack(stack);
      const invalidations = Object.entries(t.findResources('Custom::AWS')).filter(([, r]) =>
        JSON.stringify(r.Properties.Create ?? r.Properties.Update ?? '').includes('createInvalidation'),
      );
      assert.strictEqual(invalidations.length, 1, 'one deploy invalidation');
      const dependsOn = [invalidations[0][1].DependsOn ?? []].flat() as string[];
      for (const id of Object.keys(t.findResources('Custom::CDKBucketDeployment'))) {
        assert.ok(dependsOn.includes(id), `the invalidation waits for ${id}`);
      }
      const fns = t.findResources('AWS::CloudFront::Function');
      const staticFn = Object.keys(fns).find((id) => String(fns[id].Properties.FunctionCode).includes('resolveIndex'));
      assert.ok(staticFn && dependsOn.includes(staticFn), 'after the cutover');
      // …and after the new server, so the edge never re-caches the previous build's pages.
      const serverFn = Object.keys(t.findResources('AWS::Lambda::Function')).find((id) => /Computedefault/.test(id));
      assert.ok(serverFn && dependsOn.includes(serverFn), `after the server function (${serverFn})`);
      // The post-deploy liveness poll waits on this invalidation, as on the CloudFront door.
      const out = Object.entries(t.findOutputs('*')).filter(([k]) => k.includes('HostingInvalidationId'));
      assert.strictEqual(out.length, 1, 'the stacked edge emits HostingInvalidationId');
      const value = JSON.stringify(out[0][1].Value);
      assert.ok(value.includes(invalidations[0][0]), 'it names the edge invalidation');
      // A static site has no server, so nothing at the edge can be stale.
      const spa = stackedSynth('CfOverAlbNoInvalidate');
      assert.strictEqual(
        Object.values(spa.findResources('Custom::AWS')).filter((r) => JSON.stringify(r.Properties.Create ?? r.Properties.Update ?? '').includes('createInvalidation')).length,
        0,
      );
      assert.strictEqual(Object.keys(spa.findOutputs('*')).filter((k) => k.includes('HostingInvalidationId')).length, 0);
    });

    it('a stacked SPA whose static routes reach the router warns about files over the ALB 1 MB limit', () => {
      createSpaBuildOutput(tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'dist', 'big.js'), crypto.randomBytes(1_200_000));
      for (let i = 0; i < 30; i++) registerRoute({ method: 'POST', path: `/hook${i}`, handler: async () => {} });
      const stack = new Stack(new App(), 'CfOverAlbBig', { env: { account: '111111111111', region: 'us-east-1' } });
      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' } });
      const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('AssetExceedsProxyLimit'));
      assert.strictEqual(warnings.length, 1);
      assert.match(String(warnings[0]?.entry.data), /big\.js/);
      // With the API within the budget, the SPA is served from S3: no warning.
      clearRouteRegistry();
      const small = new Stack(new App(), 'CfOverAlbSmall', { env: { account: '111111111111', region: 'us-east-1' } });
      new Hosting(small, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' } });
      assert.strictEqual(Annotations.fromStack(small).findWarning('*', Match.stringLikeRegexp('AssetExceedsProxyLimit')).length, 0);
    });

    it('SSR: a static route is an S3 behavior; the server catch-all and the API stay on the ALB', () => {
      createNextjsBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'CfOverAlbS3Ssr', { env: { account: '111111111111', region: 'us-east-1' } });
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        customAdapter: createNextjsFixtureAdapter(tmpDir, BUFFERED),
        frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' },
      });
      const edge = edgeOf(Template.fromStack(stack));
      assert.strictEqual(edge.defaultTarget, 'alb');
      const order = edge.behaviors.map(([p, to]) => `${p}→${to}`);
      assert.ok(order.includes('/_next/static/*→s3'), order.join(', '));
      assert.ok(order.includes('/aws-blocks/*→alb'), order.join(', '));
      assert.ok(order.indexOf('/aws-blocks/*→alb') < order.indexOf('/_next/static/*→s3'), 'the API keeps precedence');
    });

    it("keeps the router's precedence: a dynamic route listed before an overlapping static one shadows it at the edge", () => {
      createNextjsBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'CfOverAlbS3Order', { env: { account: '111111111111', region: 'us-east-1' } });
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        customAdapter: routedAdapter(tmpDir, [
          { pattern: '/blog/admin', target: 'default' },
          { pattern: '/blog/*', target: 'static' },
          { pattern: '/*', target: 'default' },
        ]),
        frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' },
      });
      const order = edgeOf(Template.fromStack(stack)).behaviors.map(([p, to]) => `${p}→${to}`);
      const admin = order.indexOf('/blog/admin→alb');
      const blog = order.indexOf('/blog/*→s3');
      assert.ok(admin >= 0 && blog > admin, `the dynamic /blog/admin precedes the static /blog/* (got ${order.join(', ')})`);
    });

    it('the static function resolves the directory index and answers redirects the S3 behaviors would otherwise swallow', () => {
      createNextjsBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'CfOverAlbS3Fn', { env: { account: '111111111111', region: 'us-east-1' } });
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        customAdapter: routedAdapter(
          tmpDir,
          [
            { pattern: '/docs/*', target: 'static' },
            { pattern: '/*', target: 'default' },
          ],
          { redirects: [{ source: '/docs/old/*', destination: '/docs/new/*', statusCode: 301 }] },
        ),
        frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' },
      });
      const fn = staticFunction(Template.fromStack(stack));
      assert.match(String(fn({ request: { uri: '/docs/intro' } }).uri), /^\/builds\/[^/]+\/docs\/intro\/index\.html$/);
      assert.match(String(fn({ request: { uri: '/docs/' } }).uri), /^\/builds\/[^/]+\/docs\/index\.html$/);
      const redirect = fn({ request: { uri: '/docs/old/a/b' } });
      assert.strictEqual(redirect.statusCode, 301);
      assert.strictEqual(redirect.headers?.location.value, '/docs/new/a/b');
    });

    it("more routes than CloudFront's 25 behaviors: the edge keeps a correct prefix and warns; the rest go through the ALB", () => {
      createNextjsBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'CfOverAlbS3Cap', { env: { account: '111111111111', region: 'us-east-1' } });
      const routes: RouteBehavior[] = [
        ...Array.from({ length: 40 }, (_, i) => ({ pattern: `/static${i}/*`, target: 'static' as const })),
        { pattern: '/*', target: 'default' },
      ];
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        customAdapter: routedAdapter(tmpDir, routes),
        frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' },
      });
      const edge = edgeOf(Template.fromStack(stack));
      // 25 behaviors per distribution, the default included.
      assert.strictEqual(edge.behaviors.length, 24, `24 behaviors besides the default (got ${edge.behaviors.length})`);
      // The budget goes to S3: the API paths no static route can shadow are left
      // to the router default (which reaches them), not given behaviors.
      assert.ok(!edge.behaviors.some(([p]) => p === '/aws-blocks/*'));
      assert.strictEqual(edge.behaviors[0][0], '/.blocks-sandbox/*');
      const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('StackedEdgeBehaviorLimit'));
      assert.strictEqual(warnings.length, 1);
      assert.doesNotMatch(String(warnings[0]?.entry.data), /raise the quota/);
    });

    it('the thin edge stamps security headers (HSTS / frame / content-type) — parity with the default CloudFront door', () => {
      createSpaBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'CfOverAlbSecHeadersStack', { env: { account: '111111111111', region: 'us-east-1' } });

      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' } });

      const t = Template.fromStack(stack);
      // A ResponseHeadersPolicy with the security headers, attached to the edge's
      // default behavior — the ALB can't inject these, so CloudFront owns them.
      t.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            StrictTransportSecurity: Match.objectLike({ Override: true }),
          }),
        }),
      });
    });

    // ── The router is reachable only through the edge ──────────────────────
    const ORIGIN_VERIFY = 'x-blocks-origin-verify';
    const stackedSynth = (name: string, internal?: boolean) => {
      createSpaBuildOutput(tmpDir);
      const stack = new Stack(new App(), name, { env: { account: '111111111111', region: 'us-east-1' } });
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb', ...(internal ? { internal } : {}) },
      });
      return Template.fromStack(stack);
    };
    /** Every ingress rule on the ALB's security group (inline and standalone). */
    const albIngress = (t: Template): Array<Record<string, unknown>> => {
      const lbSgRefs = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer')).flatMap(
        (r) => r.Properties.SecurityGroups as Array<{ 'Fn::GetAtt': [string, string] }>,
      );
      const sgIds = lbSgRefs.map((ref) => ref['Fn::GetAtt'][0]);
      const sgs = t.findResources('AWS::EC2::SecurityGroup');
      const inline = sgIds.flatMap((id) => (sgs[id]?.Properties.SecurityGroupIngress as Array<Record<string, unknown>>) ?? []);
      const standalone = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress'))
        .map((r) => r.Properties as Record<string, unknown>)
        .filter((p) => sgIds.includes((p.GroupId as { 'Fn::GetAtt': [string, string] })?.['Fn::GetAtt']?.[0]));
      return [...inline, ...standalone];
    };
    const secretOf = (t: Template): unknown => {
      const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0];
      const origins = dist.Properties.DistributionConfig.Origins as Array<{
        OriginCustomHeaders?: Array<{ HeaderName: string; HeaderValue: unknown }>;
      }>;
      const header = origins.flatMap((o) => o.OriginCustomHeaders ?? []).find((h) => h.HeaderName === ORIGIN_VERIFY);
      assert.ok(header, 'the edge sends the origin-verify header to the ALB');
      // A dynamic reference to a generated secret — never a value in the template.
      const secrets = t.findResources('AWS::SecretsManager::Secret');
      const ids = Object.keys(secrets);
      assert.strictEqual(ids.length, 1, 'one generated origin-verify secret');
      assert.deepStrictEqual(secrets[ids[0]].Properties.GenerateSecretString, {
        ExcludePunctuation: true,
        IncludeSpace: false,
        PasswordLength: 64,
      });
      assert.deepStrictEqual(header.HeaderValue, {
        'Fn::Join': ['', ['{{resolve:secretsmanager:', { Ref: ids[0] }, ':SecretString:::}}']],
      });
      return header.HeaderValue;
    };
    const assertListenerRequiresSecret = (t: Template, secret: unknown) => {
      const listeners = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::Listener'));
      assert.strictEqual(listeners.length, 1);
      assert.deepStrictEqual(listeners[0].Properties.DefaultActions, [
        {
          Type: 'fixed-response',
          FixedResponseConfig: { ContentType: 'text/plain', MessageBody: 'Forbidden', StatusCode: '403' },
        },
      ]);
      const rules = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'));
      assert.ok(rules.length > 0);
      for (const rule of rules) {
        const conditions = rule.Properties.Conditions as Array<{
          Field: string;
          HttpHeaderConfig?: { HttpHeaderName: string; Values: string[] };
          PathPatternConfig?: { Values: string[] };
        }>;
        const header = conditions.find((c) => c.Field === 'http-header');
        assert.deepStrictEqual(header?.HttpHeaderConfig, { HttpHeaderName: ORIGIN_VERIFY, Values: [secret] });
        // ALB: at most 5 condition values per rule, the header included.
        const values = conditions.reduce(
          (n, c) => n + (c.PathPatternConfig?.Values.length ?? 0) + (c.HttpHeaderConfig?.Values.length ?? 0),
          0,
        );
        assert.ok(values <= 5, `at most 5 condition values per rule (got ${values})`);
      }
      // The catch-all forward is a rule too (the default action is the 403).
      assert.ok(
        rules.some((r) => (r.Properties.Conditions as Array<{ Field: string }>).every((c) => c.Field === 'http-header')),
        'a header-only catch-all rule forwards to the default target',
      );
    };

    it('public router: the ALB security group admits only the CloudFront origin-facing prefix list', () => {
      const t = stackedSynth('CfOverAlbLockedPublic');
      const ingress = albIngress(t);
      assert.ok(ingress.length > 0, 'the listener port is open to something');
      for (const rule of ingress) {
        assert.strictEqual(rule.CidrIp, undefined, `no CIDR ingress (got ${JSON.stringify(rule)})`);
        assert.strictEqual(rule.CidrIpv6, undefined);
        assert.ok(rule.SourcePrefixListId, 'ingress from a prefix list');
      }
      // The prefix list id is looked up per region at deploy time (no synth context).
      const lookups = Object.values(t.findResources('Custom::AWS')).filter((r) =>
        JSON.stringify(r.Properties).includes('com.amazonaws.global.cloudfront.origin-facing'),
      );
      assert.strictEqual(lookups.length, 1, 'one prefix-list lookup');
      assert.match(JSON.stringify(lookups[0].Properties), /describeManagedPrefixLists/i);
      t.resourceCountIs('AWS::CloudFront::VpcOrigin', 0);
    });

    it('public router: the listener answers 403 unless the edge sent the generated origin-verify secret', () => {
      const t = stackedSynth('CfOverAlbLockedHeader');
      assertListenerRequiresSecret(t, secretOf(t));
    });

    it('internal router: CloudFront reaches the internal ALB through a VPC origin, admitted by its service security group', () => {
      const t = stackedSynth('CfOverAlbInternal', true);
      t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
      t.resourceCountIs('AWS::CloudFront::VpcOrigin', 1);
      const dist = Object.entries(t.findResources('AWS::CloudFront::Distribution'));
      assert.strictEqual(dist.length, 1);
      const origins = dist[0][1].Properties.DistributionConfig.Origins as Array<Record<string, unknown>>;
      assert.ok(origins.some((o) => o.VpcOriginConfig), 'the ALB is a VPC origin');
      assert.ok(origins.every((o) => !o.CustomOriginConfig), 'no internet (custom) origin for the ALB');
      // The VPC origin's service security group (named by CloudFront, looked up
      // after the distribution) is the only source the ALB admits.
      const lookup = Object.entries(t.findResources('Custom::AWS')).find(([, r]) =>
        JSON.stringify(r.Properties).includes('CloudFront-VPCOrigins-Service-SG'),
      );
      assert.ok(lookup, 'the VPC origins service security group is looked up');
      assert.ok([lookup[1].DependsOn ?? []].flat().includes(dist[0][0]), 'looked up after the distribution');
      const ingress = albIngress(t);
      assert.ok(ingress.length > 0);
      for (const rule of ingress) {
        assert.strictEqual(rule.CidrIp, undefined);
        assert.match(JSON.stringify(rule.SourceSecurityGroupId), new RegExp(lookup[0]));
      }
      assertListenerRequiresSecret(t, secretOf(t));
    });

    it('a router certificate and domain: the edge reaches the router over HTTPS :443 at that name', () => {
      createSpaBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'StackedTls', { env: { account: '111111111111', region: 'us-east-1' } });
      const certificate = cdk.aws_certificatemanager.Certificate.fromCertificateArn(
        stack,
        'RouterCert',
        'arn:aws:acm:us-east-1:111111111111:certificate/r',
      );
      new Hosting(stack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        frontDoor: {
          kind: 'stacked',
          edge: 'cloudfront',
          router: 'alb',
          certificate,
          features: { router: { domain: { domainName: 'router.example.com', hostedZone: 'example.com', hostedZoneId: 'Z1' } } },
        },
      });
      const t = Template.fromStack(stack);
      const listeners = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::Listener'));
      assert.strictEqual(listeners.length, 1, 'no :80 redirect on a router only the edge reaches');
      assert.strictEqual(listeners[0].Properties.Port, 443);
      assert.strictEqual(listeners[0].Properties.Protocol, 'HTTPS');
      const dist = Object.values(t.findResources('AWS::CloudFront::Distribution'))[0];
      const router = (dist.Properties.DistributionConfig.Origins as Array<{
        DomainName: unknown;
        CustomOriginConfig?: { OriginProtocolPolicy: string };
      }>).find((o) => o.CustomOriginConfig);
      assert.strictEqual(router?.CustomOriginConfig?.OriginProtocolPolicy, 'https-only');
      assert.strictEqual(router?.DomainName, 'router.example.com');
      t.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'router.example.com.', Type: 'A' });
      assert.strictEqual(
        Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('StackedRouterPlainHttp')).length,
        0,
      );
      // The router isn't the app's address: the edge is.
      const outputs = t.findOutputs('*');
      const hostingUrl = Object.entries(outputs).find(([k]) => k.includes('HostingUrl'))?.[1]?.Value;
      assert.match(JSON.stringify(hostingUrl), /https:\/\//);
      assert.doesNotMatch(JSON.stringify(hostingUrl), /router\.example\.com/);
    });

    it('without a certificate the hop is HTTP :80; an internet-facing router warns, an internal one does not', () => {
      const warns = (internal: boolean) => {
        createSpaBuildOutput(tmpDir);
        const stack = new Stack(new App(), `StackedHttp${internal}`, { env: { account: '111111111111', region: 'us-east-1' } });
        new Hosting(stack, 'Hosting', {
          root: tmpDir,
          api: MOCK_API,
          frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb', internal },
        });
        const listener = Object.values(Template.fromStack(stack).findResources('AWS::ElasticLoadBalancingV2::Listener'))[0];
        assert.strictEqual(listener?.Properties.Port, 80);
        return Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('StackedRouterPlainHttp')).length;
      };
      assert.strictEqual(warns(false), 1);
      assert.strictEqual(warns(true), 0);
    });

    it('a router certificate without a router domain fails synth', () => {
      createSpaBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'StackedCertNoDomain', { env: { account: '111111111111', region: 'us-east-1' } });
      const certificate = cdk.aws_certificatemanager.Certificate.fromCertificateArn(stack, 'C', 'arn:aws:acm:us-east-1:111111111111:certificate/r');
      assert.throws(
        () =>
          new Hosting(stack, 'Hosting', {
            root: tmpDir,
            api: MOCK_API,
            frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb', certificate },
          }),
        (e: Error) => e.name === 'StackedRouterCertificateNeedsDomainError',
      );
    });

    it('the standalone ALB door stays public by design (open listener, plain forward)', () => {
      createSpaBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'AlbStaysPublic', { env: { account: '111111111111', region: 'us-east-1' } });
      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'alb' } });
      const t = Template.fromStack(stack);
      assert.ok(albIngress(t).some((r) => r.CidrIp === '0.0.0.0/0'));
      const listener = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::Listener'))[0];
      assert.strictEqual((listener.Properties.DefaultActions as Array<{ Type: string }>)[0].Type, 'forward');
      // No rule checks the origin-verify header (the API forwarder only strips it).
      const rules = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'));
      assert.ok(rules.length > 0);
      assert.ok(!rules.some((r) => JSON.stringify(r.Properties.Conditions).includes(ORIGIN_VERIFY)));
    });

    it("stacked + compute.type 'web-function' fails synth naming the stacked door", () => {
      createSpaBuildOutput(tmpDir);
      const stack = new Stack(new App(), 'StackedWebFunction', { env: { account: '111111111111', region: 'us-east-1' } });
      assert.throws(
        () =>
          new Hosting(stack, 'Hosting', {
            root: tmpDir,
            api: MOCK_API,
            compute: { type: 'web-function' },
            frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' },
          }),
        (e: Error) => e.name === 'UnsupportedComputeFrontDoorError' && e.message.includes("'stacked'"),
      );
    });

    it('the default CloudFront door still fronts API Gateway directly (no ALB)', () => {
      createSpaBuildOutput(tmpDir);
      const app = new App();
      const stack = new Stack(app, 'DefaultNoAlbStack', { env: { account: '111111111111', region: 'us-east-1' } });

      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API });

      const t = Template.fromStack(stack);
      t.resourceCountIs('AWS::CloudFront::Distribution', 1);
      t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
    });
  });
});

// ================================================================
// frontDoor.features on Hosting: each kind's settings reach its door, the
// deprecated top-level props merge into them, and the stacked door scopes its
// settings per layer.
// ================================================================
describe('Hosting — frontDoor.features', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-hosting-features-'));
    createSpaBuildOutput(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearRouteRegistry();
  });

  const EDGE_ACL = 'arn:aws:wafv2:us-east-1:111111111111:global/webacl/edge/1';
  const REGIONAL_ACL = 'arn:aws:wafv2:us-east-1:111111111111:regional/webacl/router/1';
  const newStack = (id: string) => new Stack(new App(), id, { env: { account: '111111111111', region: 'us-east-1' } });

  // The released top-level props never rejected an unknown key (it was
  // ignored); the merge into `frontDoor.features` keeps that, and the
  // template is the one without the key.
  it('a deprecated top-level prop with an unknown inner key still synthesizes, as released', () => {
    const synth = (id: string, props: Partial<HostingProps>) => {
      const stack = newStack(id);
      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, ...props } as HostingProps);
      return Template.fromStack(stack);
    };
    // JavaScript callers (or a TS variable) can pass extra keys: no excess-property check there.
    const extra = (o: object) => o as never;
    synth('ExtraWaf', { waf: extra({ enabled: true, enable: true }) }).resourceCountIs('AWS::WAFv2::WebACL', 1);
    synth('ExtraMonitoring', { monitoring: extra({ enabled: false, alarms: 1 }) }).resourceCountIs('AWS::CloudWatch::Alarm', 0);
    assert.doesNotThrow(() => synth('ExtraLogging', { logging: extra({ enabled: true, retention: 7 }) }));
    assert.doesNotThrow(() => synth('ExtraSkew', { skewProtection: extra({ enabled: true, ttl: 1 }) }));
    // The app's own `frontDoor.features` is still checked.
    assert.throws(
      () => synth('ExplicitExtra', { frontDoor: { features: { waf: extra({ enabled: true, enable: true }) } } }),
      (e: Error) => e.name === 'InvalidFrontDoorSettingError' && /frontDoor\.features\.waf\.enable/.test(e.message),
    );
  });

  it('frontDoor: null is the default CloudFront door (as on HostingConstruct)', () => {
    const stack = newStack('NullDoor');
    new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: null as never });
    Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  it('the CloudFront default with settings: { features } reaches the distribution', () => {
    const stack = newStack('FeatCf');
    new Hosting(stack, 'Hosting', {
      root: tmpDir,
      api: MOCK_API,
      frontDoor: {
        features: {
          priceClass: cdk.aws_cloudfront.PriceClass.PRICE_CLASS_ALL,
          waf: { enabled: false, webAclArn: EDGE_ACL },
          geoRestriction: { type: 'whitelist', countries: ['US'] },
        },
      },
    });
    Template.fromStack(stack).hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        PriceClass: 'PriceClass_All',
        WebACLId: EDGE_ACL,
        Restrictions: { GeoRestriction: { RestrictionType: 'whitelist', Locations: ['US'] } },
      }),
    });
  });

  it('the released top-level props and the same settings in frontDoor.features synthesize the same template', () => {
    const settings = {
      waf: { enabled: true, rateLimit: 500 },
      logging: { enabled: true, retentionDays: 30 },
      monitoring: { enabled: true },
      skewProtection: { enabled: true, maxAge: 3600 },
      priceClass: cdk.aws_cloudfront.PriceClass.PRICE_CLASS_200,
      contentSecurityPolicy: "default-src 'self'",
      domain: { domainName: 'app.example.com', hostedZone: 'example.com', hostedZoneId: 'Z123' },
    };
    // A fixed build id (it feeds the asset hashes), the same root dir and the
    // same stack name (in two Apps), so the whole template is compared.
    const customAdapter = () => ({
      version: 1 as const,
      buildId: 'feat-eq',
      compute: {},
      staticAssets: { directory: path.join(tmpDir, 'dist'), spaFallback: true },
      routes: [{ pattern: '/*', target: 'static' as const }],
    });
    const aliased = newStack('FeatEq');
    new Hosting(aliased, 'Hosting', { root: tmpDir, api: MOCK_API, customAdapter, ...settings });
    const migrated = newStack('FeatEq');
    new Hosting(migrated, 'Hosting', { root: tmpDir, api: MOCK_API, customAdapter, frontDoor: { features: settings } });
    assert.deepEqual(Template.fromStack(migrated).toJSON(), Template.fromStack(aliased).toJSON());
  });

  it('an SSR app: the released cache-key, TTL, geo and quota props equal the same settings in frontDoor.features', () => {
    createNextjsBuildOutput(tmpDir);
    const settings = {
      cacheKeyCookies: ['sid'],
      cacheKeyHeaders: ['authorization'],
      ssrDefaultTtl: cdk.Duration.seconds(5),
      geoRestriction: { type: 'whitelist' as const, countries: ['US'] },
      quotas: { cacheBehaviors: 30 },
    };
    const customAdapter = (projectDir: string) => ({ ...createNextjsFixtureAdapter(tmpDir)(projectDir), buildId: 'feat-ssr-eq' });
    const aliased = newStack('FeatSsrEq');
    new Hosting(aliased, 'Hosting', { root: tmpDir, api: MOCK_API, customAdapter, ...settings });
    const migrated = newStack('FeatSsrEq');
    new Hosting(migrated, 'Hosting', { root: tmpDir, api: MOCK_API, customAdapter, frontDoor: { features: settings } });
    const json = Template.fromStack(aliased).toJSON();
    assert.deepEqual(Template.fromStack(migrated).toJSON(), json);
    // The header alias took effect: `authorization` is in the SSR cache key.
    assert.match(JSON.stringify(json), /"authorization"/);
    // And the quota reaches the L3 either way: a budget below what an SSR
    // distribution needs fails synth, through the alias and through features.
    for (const props of [{ quotas: { cacheBehaviors: 1 } }, { frontDoor: { features: { quotas: { cacheBehaviors: 1 } } } }]) {
      assert.throws(
        () => new Hosting(newStack('FeatSsrQuota'), 'Hosting', { root: tmpDir, api: MOCK_API, customAdapter, ...props }),
        (e: Error) => e.name === 'TooManyCacheBehaviorsError',
      );
    }
  });

  it('ALB: features (and a supported alias) reach the router', () => {
    const stack = newStack('FeatAlb');
    new Hosting(stack, 'Hosting', {
      root: tmpDir,
      api: MOCK_API,
      frontDoor: { kind: 'alb', features: { waf: { enabled: true } } },
      logging: { enabled: true },
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'REGIONAL' });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([{ Key: 'access_logs.s3.enabled', Value: 'true' }]),
    });
  });

  it('stacked: features.edge reaches the edge and features.router the ALB — each its own WAF', () => {
    const stack = newStack('FeatStacked');
    new Hosting(stack, 'Hosting', {
      root: tmpDir,
      api: MOCK_API,
      frontDoor: {
        kind: 'stacked',
        edge: 'cloudfront',
        router: 'alb',
        features: {
          edge: { waf: { webAclArn: EDGE_ACL }, contentSecurityPolicy: "default-src 'self'" },
          router: { waf: { enabled: true, webAclArn: REGIONAL_ACL }, monitoring: { enabled: true } },
        },
      },
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({ WebACLId: EDGE_ACL }) });
    t.hasResourceProperties('AWS::WAFv2::WebACLAssociation', { WebACLArn: REGIONAL_ACL });
    t.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: { ContentSecurityPolicy: "default-src 'self'", Override: true },
        }),
      }),
    });
    // The ALB's own alarms (5xx + latency).
    t.resourceCountIs('AWS::CloudWatch::Alarm', 2);
  });

  it('stacked: a top-level prop fails synth (the door takes its settings per layer)', () => {
    for (const extra of [{ waf: { enabled: true } }, { contentSecurityPolicy: "default-src 'self'" }, { logging: { enabled: true } }]) {
      assert.throws(
        () =>
          new Hosting(newStack(`FeatStackedAlias${Object.keys(extra)[0]}`), 'Hosting', {
            root: tmpDir,
            api: MOCK_API,
            frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' },
            ...extra,
          }),
        (e: Error) =>
          e.name === 'UnsupportedFrontDoorSettingError' &&
          e.message.includes("'stacked'") &&
          e.message.includes(`\`${Object.keys(extra)[0]}\``),
      );
    }
  });

  it('a setting set both top-level and in frontDoor.features fails synth, naming both (core names)', () => {
    assert.throws(
      () =>
        new Hosting(newStack('FeatConflict'), 'Hosting', {
          root: tmpDir,
          priceClass: cdk.aws_cloudfront.PriceClass.PRICE_CLASS_100,
          frontDoor: { features: { priceClass: cdk.aws_cloudfront.PriceClass.PRICE_CLASS_ALL } },
        }),
      (e: Error) =>
        e.name === 'FrontDoorSettingConflictError' &&
        e.message.includes('`priceClass`') &&
        e.message.includes('`frontDoor.features.priceClass`'),
    );
  });

  it('a top-level prop the kind does not implement fails synth, naming the kind and the prop', () => {
    assert.throws(
      () =>
        new Hosting(newStack('FeatUnsupported'), 'Hosting', {
          root: tmpDir,
          api: MOCK_API,
          frontDoor: { kind: 'alb' },
          geoRestriction: { type: 'whitelist', countries: ['US'] },
        }),
      (e: Error) =>
        e.name === 'UnsupportedFrontDoorSettingError' && e.message.includes("'alb'") && e.message.includes('`geoRestriction`'),
    );
  });

  it('a BYO door receives frontDoor.features (merged with aliases) as DoorInput.features', () => {
    let seen: DoorInput | undefined;
    const door = defineFrontDoor({
      service: 'recorder',
      build(scope, input) {
        seen = input;
        const dist = new cdk.aws_cloudfront.Distribution(scope, 'Cdn', {
          defaultBehavior: { origin: cf.origin(input.origins.assets) },
          additionalBehaviors: cf.apiBehaviors(input.origins.api),
        });
        return { url: `https://${dist.distributionDomainName}` };
      },
    });
    new Hosting(newStack('FeatByo'), 'Hosting', {
      root: tmpDir,
      api: MOCK_API,
      frontDoor: { kind: 'custom', door, features: { waf: { enabled: true, rateLimit: 100 } } },
      geoRestriction: { type: 'blacklist', countries: ['KP'] },
    });
    assert.deepEqual(seen?.features.waf, { enabled: true, rateLimit: 100 });
    // The legacy spelling reaches the door as the inclusive one.
    assert.deepEqual(seen?.features.geoRestriction, { type: 'denylist', countries: ['KP'] });
  });

  it('a config() domain in frontDoor.features needs Hosting.create(), like the top-level domain', () => {
    assert.throws(
      () =>
        new Hosting(newStack('FeatDomainMarker'), 'Hosting', {
          root: tmpDir,
          api: MOCK_API,
          frontDoor: { features: { domain: { domainName: config('DOMAIN_PROD') } } },
        }),
      /requires async resolution/,
    );
  });

  it('Hosting.create() resolves a config() domain in frontDoor.features (CloudFront aliases; the ALB door\'s URL)', async () => {
    _setSynthSecretFetcher(async () => 'app.example.com');
    try {
      const cfStack = newStack('FeatDomainCreateCf');
      await Hosting.create(cfStack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        frontDoor: { features: { domain: { domainName: config('DOMAIN_PROD'), hostedZone: 'example.com', hostedZoneId: 'Z1' } } },
      });
      Template.fromStack(cfStack).hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({ Aliases: ['app.example.com'] }),
      });
      const albStack = newStack('FeatDomainCreateAlb');
      const certificate = cdk.aws_certificatemanager.Certificate.fromCertificateArn(
        albStack,
        'Cert',
        'arn:aws:acm:us-east-1:111111111111:certificate/c',
      );
      const alb = await Hosting.create(albStack, 'Hosting', {
        root: tmpDir,
        api: MOCK_API,
        frontDoor: { kind: 'alb', certificate, features: { domain: { domainName: config('DOMAIN_PROD') } } },
      });
      assert.strictEqual(alb.url, 'https://app.example.com');
    } finally {
      _setSynthSecretFetcher(null);
    }
  });
});

// Compile-time contract on the Blocks `Hosting`: each kind accepts exactly the
// settings its door implements (this file is typechecked by the build).
const _blocksFrontDoorTypes: Array<HostingProps['frontDoor']> = [
  { features: { domain: { domainName: config('DOMAIN_PROD') }, priceClass: cdk.aws_cloudfront.PriceClass.PRICE_CLASS_ALL } },
  { kind: 'apiGateway', api: 'rest', features: { domain: { domainName: config('DOMAIN_PROD') } } },
  { kind: 'stacked', edge: 'cloudfront', router: 'alb', features: { router: { logging: { enabled: true } } } },
  // @ts-expect-error — the stacked edge has no access logs.
  { kind: 'stacked', edge: 'cloudfront', router: 'alb', features: { edge: { logging: { enabled: true } } } },
  // @ts-expect-error — the stacked door takes its settings per layer, not flat.
  { kind: 'stacked', edge: 'cloudfront', router: 'alb', features: { waf: { enabled: true } } },
  // @ts-expect-error — the ALB has no geo restriction.
  { kind: 'alb', features: { geoRestriction: { type: 'whitelist', countries: ['US'] } } },
  // @ts-expect-error — API Gateway has no WAF.
  { kind: 'apiGateway', features: { waf: { enabled: true } } },
];
void _blocksFrontDoorTypes;
