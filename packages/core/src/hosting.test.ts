// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as cdk from 'aws-cdk-lib';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BLOCKS_RPC_PREFIX } from './constants.js';
import { Hosting, type BlocksStackApi } from './hosting.js';
import { clearRouteRegistry, registerRoute } from './raw-route.js';

// ================================================================
// Hosting construct tests
//
// These validate that the Blocks wrapper around HostingConstruct
// produces the expected CloudFormation resources for SPA and SSR.
// ================================================================

const MOCK_API: BlocksStackApi = {
  apiUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks',
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
function createNextjsFixtureAdapter(root: string) {
  return (_projectDir: string) => ({
    version: 1 as const,
    compute: {
      default: {
        type: 'handler' as const,
        bundle: path.join(root, '.hosting', 'compute', 'default'),
        handler: 'index.handler',
        placement: 'regional' as const,
        streaming: true,
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
        const props = (customResources[key] as Record<string, unknown>).Properties as Record<string, unknown> | undefined;
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
          assert.ok(err.message.includes('Build output directory not found'), `Expected build dir error, got: ${err.message}`);
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
      assert.strictEqual(apiPattern, undefined, `Should NOT have ${BLOCKS_RPC_PREFIX}/* behavior when api is omitted`);
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

      assert.strictEqual(
        apiExact,
        undefined,
        '/api must not be claimed by Blocks (framework SSR API namespace)',
      );
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
      assert.ok(
        Object.keys(customResources).length >= 1,
        'Should have BucketDeployment even without api',
      );
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

      assert.strictEqual(webhookPatterns.length, 1, 'Should have exactly one /webhooks/* behavior despite two routes');
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
      assert.ok(!patterns.includes('/proxy/{version}/*'), 'Should NOT have literal {version} in CloudFront pattern');
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

      // The L3 construct should create an SsrCachePolicy with these values
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
      const has404 = errorResponses.some(
        (r: any) => r.ErrorCode === 404,
      );
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
      const error404Responses = errorResponses.filter(
        (r: any) => r.ErrorCode === 404,
      );
      assert.strictEqual(
        error404Responses.length, 1,
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
    it('exposes monitoringTopic when monitoring is enabled', () => {
      createNextjsBuildOutput(tmpDir);

      const app = new App();
      const stack = new Stack(app, 'MonitoringStack');

      const hosting = new Hosting(stack, 'Hosting', {
        root: tmpDir,
        customAdapter: createNextjsFixtureAdapter(tmpDir),
        api: MOCK_API,
        monitoring: { enabled: true },
      });

      // The L3 should create an SNS topic for alarms
      assert.ok(hosting.monitoringTopic, 'Should expose monitoringTopic when enabled');
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
        ([id, r]) =>
          r.Type === 'AWS::CloudFormation::CustomResource' &&
          /RouteStoreKeys/.test(id),
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
    });
  });

  // ── #173: stale placeholder config.json never served long-term ──
  describe('config.json stale-placeholder guard (#173)', () => {
    // Helper: pull every BucketDeployment custom resource's Properties.
    const bucketDeployments = (stack: Stack) => {
      const crs = Template.fromStack(stack).findResources(
        'Custom::CDKBucketDeployment',
      );
      return Object.values(crs).map(
        (cr) => (cr as { Properties: Record<string, unknown> }).Properties,
      );
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
      const includes = (p: Record<string, unknown>) =>
        (p.Include as string[] | undefined) ?? [];
      const excludes = (p: Record<string, unknown>) =>
        (p.Exclude as string[] | undefined) ?? [];

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
        'no mutable-tier deployment may apply s-maxage=31536000 to ' +
          '.blocks-sandbox/config.json',
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

      const deployments = bucketDeployments(stack);
      // The BlocksConfigDeployment is the one targeting the .blocks-sandbox
      // key prefix with an invalidation configured.
      const configDeploy = deployments.find(
        (p) =>
          typeof p.DestinationBucketKeyPrefix === 'string' &&
          (p.DestinationBucketKeyPrefix as string).endsWith('.blocks-sandbox') &&
          Array.isArray(p.DistributionPaths),
      );
      assert.ok(
        configDeploy,
        'expected a BlocksConfigDeployment with distributionPaths',
      );

      const paths = configDeploy.DistributionPaths as string[];
      const matchesRewrittenKey = paths.some((p) =>
        /^\/builds\/.+\/\.blocks-sandbox\/\*$/.test(p),
      );
      assert.ok(
        matchesRewrittenKey,
        `distributionPaths must invalidate the post-rewrite cache key ` +
          `(/builds/<id>/.blocks-sandbox/*); found ${JSON.stringify(paths)}`,
      );
    });
  });
});
