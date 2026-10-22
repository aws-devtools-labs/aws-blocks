// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type BuildProfile, buildProfile } from '@aws-blocks/hosting/adapters';
import type { DeployManifest } from '@aws-blocks/hosting/constructs';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { type BlocksStackApi, Hosting, type HostingProps, HostingPresets } from './hosting.js';
import { clearRouteRegistry } from './raw-route.js';

const MOCK_API: BlocksStackApi = {
  apiUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks',
};

/** A minimal SPA build output (`dist/index.html`). */
function createSpaBuildOutput(root: string): void {
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!DOCTYPE html><html><body>Hello</body></html>');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'test-spa', dependencies: { react: '^18' } }));
}

/**
 * A server-rendered fixture: a `default` server, an `edge1` regional function
 * serving `/api/edge`, and an image function. Records the build profile the
 * adapter ran with.
 */
function ssrFixture(root: string, seen: { profile?: BuildProfile }) {
  const bundle = (name: string) => {
    const dir = path.join(root, '.hosting', 'compute', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const handler = async () => ({})');
    return dir;
  };
  const staticDir = path.join(root, '.hosting', 'static');
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ssr' }));
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  return (_projectDir: string): DeployManifest => {
    seen.profile = buildProfile();
    return {
      version: 1,
      compute: {
        default: { type: 'handler', bundle: bundle('default'), handler: 'index.handler', placement: 'regional', streaming: false },
        edge1: { type: 'handler', bundle: bundle('edge1'), handler: 'index.handler', placement: 'regional', streaming: false },
      },
      staticAssets: { directory: staticDir },
      routes: [
        { pattern: '/_next/static/*', target: 'static' },
        { pattern: '/api/edge', target: 'edge1' },
        { pattern: '/_next/image', target: 'image-optimization' },
        { pattern: '/*', target: 'default' },
      ],
      imageOptimization: {
        bundle: bundle('image'),
        handler: 'index.handler',
        formats: ['webp'],
        sizes: [640],
        remotePatterns: [{ hostname: 'images.example.com' }],
      },
      buildId: 'random-build',
    };
  };
}

const newStack = (name: string) =>
  new Stack(new App(), name, { env: { account: '111111111111', region: 'us-east-1' } });

describe('HostingPresets', () => {
  it('production sets nothing: the full shape is the default', () => {
    assert.deepStrictEqual(HostingPresets.production, {});
  });

  it('preview picks the HTTP API door and every trim, as plain props', () => {
    assert.deepStrictEqual(HostingPresets.preview, {
      frontDoor: { kind: 'apiGateway' },
      imageOptimization: false,
      incrementalRegeneration: false,
      edgeRoutes: 'regional',
      buildId: 'fixed',
    });
  });
});

describe('Hosting with HostingPresets.preview', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-hosting-preview-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearRouteRegistry();
  });

  it('is served by the API Gateway HTTP API door: no CloudFront distribution', () => {
    createSpaBuildOutput(tmpDir);
    const stack = newStack('PreviewSpa');
    const hosting = new Hosting(stack, 'Hosting', { ...HostingPresets.preview, root: tmpDir, api: MOCK_API });

    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::CloudFront::Distribution', 0);
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    // The API is proxied same-origin.
    t.hasResourceProperties('AWS::ApiGatewayV2::Integration', { IntegrationType: 'HTTP_PROXY' });
    assert.throws(() => hosting.distribution, /only available for a CloudFront front door/);
  });

  it('without preview, the same app deploys the CloudFront door', () => {
    createSpaBuildOutput(tmpDir);
    const stack = newStack('NoPreviewSpa');
    new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API });

    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::CloudFront::Distribution', 1);
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
  });

  it('uses the fixed build id', () => {
    const seen: { profile?: BuildProfile } = {};
    const stack = newStack('PreviewBuildId');
    new Hosting(stack, 'Hosting', {
      root: tmpDir,
      buildOutputDir: 'dist',
      api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, seen),
      ...HostingPresets.preview,
    });

    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { ASSET_KEY_PREFIX: 'builds/fixed' } },
    });
  });

  it('builds the adapter for the HTTP API and with every preview trim', () => {
    const seen: { profile?: BuildProfile } = {};
    new Hosting(newStack('PreviewProfile'), 'Hosting', {
      root: tmpDir,
      buildOutputDir: 'dist',
      api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, seen),
      ...HostingPresets.preview,
    });

    assert.deepStrictEqual(seen.profile, {
      serverInvoke: 'http-api',
      edgeToRegional: true,
      skipIsr: true,
      skipImageOptimization: true,
      deterministicBuildId: 'fixed',
    });
  });

  it('the HTTP API door builds the server for the HTTP API without preview too', () => {
    const seen: { profile?: BuildProfile } = {};
    new Hosting(newStack('HttpDoorProfile'), 'Hosting', {
      root: tmpDir,
      buildOutputDir: 'dist',
      api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, seen),
      frontDoor: { kind: 'apiGateway' },
    });

    assert.deepStrictEqual(seen.profile, { serverInvoke: 'http-api' });
  });

  it('the CloudFront door keeps the default build', () => {
    const seen: { profile?: BuildProfile } = {};
    new Hosting(newStack('CloudFrontProfile'), 'Hosting', {
      root: tmpDir,
      buildOutputDir: 'dist',
      api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, seen),
    });

    assert.deepStrictEqual(seen.profile, { serverInvoke: 'default' });
  });

  it('builds no image function; the image endpoint goes to the asset proxy with the app allowlist', () => {
    const seen: { profile?: BuildProfile } = {};
    const stack = newStack('PreviewImage');
    new Hosting(stack, 'Hosting', {
      root: tmpDir,
      buildOutputDir: 'dist',
      api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, seen),
      ...HostingPresets.preview,
    });

    const t = Template.fromStack(stack);
    const fns = t.findResources('AWS::Lambda::Function');
    const imageFns = Object.keys(fns).filter((id) => id.includes('ImageOptimization'));
    assert.deepStrictEqual(imageFns, []);
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'ANY /_next/image' });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'ANY /_ipx/{proxy+}' });
    // The asset proxy carries the remote-source allowlist.
    t.hasResourceProperties('AWS::Lambda::Function', {
      Code: { ZipFile: Match.stringLikeRegexp('IMAGE_REMOTE_HOSTS = \\["images\\.example\\.com"\\]') },
    });
  });

  it('a custom IPX endpoint from the manifest is routed to the asset proxy, which matches it', () => {
    const seen: { profile?: BuildProfile } = {};
    const fixture = ssrFixture(tmpDir, seen);
    const stack = newStack('PreviewCustomIpx');
    new Hosting(stack, 'Hosting', {
      ...HostingPresets.preview,
      root: tmpDir,
      buildOutputDir: 'dist',
      api: MOCK_API,
      customAdapter: (dir) => {
        const manifest = fixture(dir);
        // What the Nitro adapter emits for `runtimeConfig.ipx.baseURL: '/img'` with no image function.
        manifest.routes.unshift({ pattern: '/img/*', target: 'image-optimization' });
        delete manifest.imageOptimization;
        return manifest;
      },
    });

    const t = Template.fromStack(stack);
    const [route] = Object.values(t.findResources('AWS::ApiGatewayV2::Route', { Properties: { RouteKey: 'ANY /img/{proxy+}' } }));
    assert.ok(route, 'the custom endpoint has its own API route');
    assert.match(JSON.stringify(route.Properties.Target), /AssetInt/);
    t.hasResourceProperties('AWS::Lambda::Function', {
      Code: { ZipFile: Match.stringLikeRegexp('IMAGE_PATH_PREFIXES = \\["/_ipx","/img"\\]') },
    });
  });

  it('`imageOptimization: true` after the spread keeps the image function', () => {
    const seen: { profile?: BuildProfile } = {};
    const stack = newStack('PreviewKeepImage');
    new Hosting(stack, 'Hosting', {
      root: tmpDir,
      buildOutputDir: 'dist',
      api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, seen),
      ...HostingPresets.preview,
      imageOptimization: true,
    });

    assert.strictEqual(seen.profile?.skipImageOptimization, undefined);
    const fns = Template.fromStack(stack).findResources('AWS::Lambda::Function');
    assert.ok(Object.keys(fns).some((id) => id.includes('ImageOptimization')));
  });

  it('routes a regional edge function straight to it, not to the server', () => {
    const seen: { profile?: BuildProfile } = {};
    const stack = newStack('PreviewEdgeRoute');
    new Hosting(stack, 'Hosting', {
      root: tmpDir,
      buildOutputDir: 'dist',
      api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, seen),
      ...HostingPresets.preview,
    });

    const t = Template.fromStack(stack);
    const routes = t.findResources('AWS::ApiGatewayV2::Route', { Properties: { RouteKey: 'ANY /api/edge' } });
    const [route] = Object.values(routes);
    assert.ok(route, 'the edge route has its own API route');
    const target = JSON.stringify(route.Properties.Target);
    assert.match(target, /ComputeIntedge1/);
  });

  it('an override after the spread wins: a custom-domain API Gateway door', () => {
    createSpaBuildOutput(tmpDir);
    const stack = newStack('PreviewExplicitDoor');
    new Hosting(stack, 'Hosting', { ...HostingPresets.preview, frontDoor: { kind: 'apiGateway' }, root: tmpDir, api: MOCK_API });

    Template.fromStack(stack).resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  it('without a preset, the same app deploys the CloudFront door', () => {
    createSpaBuildOutput(tmpDir);
    const stack = newStack('ProductionPreset');
    new Hosting(stack, 'Hosting', { ...HostingPresets.production, root: tmpDir, api: MOCK_API });

    const t = Template.fromStack(stack);
    t.resourceCountIs('AWS::CloudFront::Distribution', 1);
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
  });
});

describe('the trim settings on their own', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-hosting-settings-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearRouteRegistry();
  });

  it('`incrementalRegeneration: false` works behind the CloudFront door', () => {
    const seen: { profile?: BuildProfile } = {};
    new Hosting(newStack('IsrOffCloudFront'), 'Hosting', {
      root: tmpDir,
      buildOutputDir: 'dist',
      api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, seen),
      incrementalRegeneration: false,
    });
    assert.deepStrictEqual(seen.profile, { serverInvoke: 'default', skipIsr: true });
  });

  it("`buildId: 'fixed'` works behind the ALB (no edge cache)", () => {
    createSpaBuildOutput(tmpDir);
    const stack = newStack('FixedAlb');
    new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'alb' }, buildId: 'fixed' });
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { ASSET_KEY_PREFIX: 'builds/fixed' } },
    });
  });

  const rejected: Array<[string, Partial<HostingProps>, RegExp]> = [
    ['imageOptimization: false behind CloudFront', { imageOptimization: false }, /imageOptimization: false.*'cloudfront' \(the default\)/],
    ['imageOptimization: false behind the ALB', { imageOptimization: false, frontDoor: { kind: 'alb' } }, /imageOptimization: false.*kind: 'alb'/],
    ["edgeRoutes: 'regional' behind CloudFront", { edgeRoutes: 'regional' }, /edgeRoutes: 'regional'/],
    ["buildId: 'fixed' behind CloudFront", { buildId: 'fixed' }, /buildId: 'fixed'.*edge cache/],
    ["buildId: 'fixed' behind the stacked door", { buildId: 'fixed', frontDoor: { kind: 'stacked', edge: 'cloudfront', router: 'alb' } }, /buildId: 'fixed'/],
    ['the preview preset with a CloudFront door override', { ...HostingPresets.preview, frontDoor: 'cloudfront' }, /UnsupportedHostingSettingError|not available/],
  ];
  for (const [label, settings, message] of rejected) {
    it(`fails synth: ${label}`, () => {
      createSpaBuildOutput(tmpDir);
      assert.throws(
        () => new Hosting(newStack(`Rejected${label.replace(/\W/g, '')}`), 'Hosting', { ...settings, root: tmpDir, api: MOCK_API }),
        (err: Error) => err.name === 'UnsupportedHostingSettingError' && message.test(`${err.name} ${err.message}`),
      );
    });
  }
});
