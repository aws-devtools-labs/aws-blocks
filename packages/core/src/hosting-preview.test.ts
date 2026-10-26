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

type CfnResourceJson = {
  Type: string;
  DependsOn?: string[];
  Properties?: { Environment?: { Variables?: Record<string, unknown> } };
};

/**
 * The upload resources (`Custom::CDKBucketDeployment` and the AWS CLI layers
 * that come with each) the asset proxy — the function whose environment names
 * the build (`ASSET_KEY_PREFIX`) — or its role and policy depend on.
 */
function deployResourcesTheProxyWaitsOn(resources: Record<string, CfnResourceJson>): string[] {
  const [proxyId] = Object.keys(resources).filter(
    (id) => resources[id].Type === 'AWS::Lambda::Function' && resources[id].Properties?.Environment?.Variables?.ASSET_KEY_PREFIX !== undefined,
  );
  assert.ok(proxyId, 'an asset proxy');
  const proxyResources = Object.keys(resources).filter((id) => id === proxyId || id.startsWith(`${proxyId.replace(/[0-9A-F]{8}$/, '')}ServiceRole`));
  const deps = new Set(proxyResources.flatMap((id) => resources[id].DependsOn ?? []));
  return [...deps].filter((id) => resources[id]?.Type === 'Custom::CDKBucketDeployment' || resources[id]?.Type === 'AWS::Lambda::LayerVersion').sort();
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

  it('keys the fixed build id on the content: unchanged keeps it, an edit or a deleted file changes it', () => {
    createSpaBuildOutput(tmpDir);
    const prefixOf = (name: string) => {
      const stack = newStack(name);
      new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'alb' }, buildId: 'fixed' });
      const fns = Template.fromStack(stack).findResources('AWS::Lambda::Function', {
        Properties: { Environment: { Variables: { ASSET_KEY_PREFIX: Match.anyValue() } } },
      });
      const prefixes = Object.values(fns).map((fn) => fn.Properties.Environment.Variables.ASSET_KEY_PREFIX);
      assert.strictEqual(new Set(prefixes).size, 1);
      return prefixes[0];
    };
    const first = prefixOf('ContentIdA');
    assert.strictEqual(prefixOf('ContentIdB'), first, 'an unchanged build keeps its id');
    fs.writeFileSync(path.join(tmpDir, 'dist', 'old.txt'), 'old');
    const withOld = prefixOf('ContentIdC');
    assert.notStrictEqual(withOld, first, 'an added file changes the id');
    fs.rmSync(path.join(tmpDir, 'dist', 'old.txt'));
    assert.strictEqual(prefixOf('ContentIdD'), first, 'deleting the file changes it again (back to the old content)');
    fs.writeFileSync(path.join(tmpDir, 'dist', 'index.html'), '<!DOCTYPE html><html><body>Changed</body></html>');
    assert.notStrictEqual(prefixOf('ContentIdE'), first, 'an edited file changes the id');
  });

  it("the fixed build id ignores a framework's per-build manifest files, and covers custom error pages", () => {
    createSpaBuildOutput(tmpDir);
    const notFound = path.join(tmpDir, 'my-404.html');
    fs.writeFileSync(notFound, '<!DOCTYPE html><html><body>Not here</body></html>');
    const prefixOf = (name: string) => {
      const stack = newStack(name);
      new Hosting(stack, 'Hosting', {
        root: tmpDir, api: MOCK_API, frontDoor: { kind: 'alb' }, buildId: 'fixed', errorPages: { notFound },
      });
      const fns = Template.fromStack(stack).findResources('AWS::Lambda::Function', {
        Properties: { Environment: { Variables: { ASSET_KEY_PREFIX: Match.anyValue() } } },
      });
      return Object.values(fns)[0].Properties.Environment.Variables.ASSET_KEY_PREFIX;
    };
    const first = prefixOf('VolatileA');
    // Nuxt and SvelteKit rewrite these with a fresh id on every build.
    fs.mkdirSync(path.join(tmpDir, 'dist', '_nuxt', 'builds', 'meta'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'dist', '_nuxt', 'builds', 'latest.json'), `{"id":"${Date.now()}"}`);
    fs.writeFileSync(path.join(tmpDir, 'dist', '_nuxt', 'builds', 'meta', 'abc.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, 'dist', '_app'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'dist', '_app', 'version.json'), `{"version":"${Date.now()}"}`);
    assert.strictEqual(prefixOf('VolatileB'), first, 'per-build manifest files keep the id');
    fs.writeFileSync(notFound, '<!DOCTYPE html><html><body>Gone</body></html>');
    assert.notStrictEqual(prefixOf('VolatileC'), first, 'an edited custom error page changes the id');
  });

  it('uses a content-keyed fixed build id', () => {
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
      Environment: { Variables: { ASSET_KEY_PREFIX: Match.stringLikeRegexp('^builds/fixed-[0-9a-f]{16}$') } },
    });
  });

  it('the asset proxy is not ordered after the uploads: a fixed build has no switch-over to gate', () => {
    createSpaBuildOutput(tmpDir);
    const stack = newStack('PreviewParallelProxy');
    new Hosting(stack, 'Hosting', { ...HostingPresets.preview, root: tmpDir, api: MOCK_API });

    const resources = Template.fromStack(stack).toJSON().Resources as Record<string, CfnResourceJson>;
    const waitsOn = deployResourcesTheProxyWaitsOn(resources);
    // Neither the asset uploads nor the resolved runtime config (whose
    // deployment is ordered after the uploads), nor their layers.
    assert.deepStrictEqual(waitsOn, []);
  });

  it("per-deploy builds behind the same door keep the proxy after every upload and the runtime config", () => {
    createSpaBuildOutput(tmpDir);
    const stack = newStack('PerDeployProxy');
    new Hosting(stack, 'Hosting', { ...HostingPresets.preview, buildId: 'per-deploy', root: tmpDir, api: MOCK_API });

    const resources = Template.fromStack(stack).toJSON().Resources as Record<string, CfnResourceJson>;
    const waitsOn = deployResourcesTheProxyWaitsOn(resources);
    const uploads = Object.keys(resources).filter((id) => resources[id].Type === 'Custom::CDKBucketDeployment');
    assert.ok(uploads.some((id) => id.includes('BlocksConfigDeployment')), 'the runtime config is one of the uploads');
    for (const u of uploads) assert.ok(waitsOn.includes(u), `the proxy waits for ${u}`);
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

  it('the HTTP API door builds the server for the HTTP API without preview too, with edge routes regional', () => {
    const seen: { profile?: BuildProfile } = {};
    new Hosting(newStack('HttpDoorProfile'), 'Hosting', {
      root: tmpDir,
      buildOutputDir: 'dist',
      api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, seen),
      frontDoor: { kind: 'apiGateway' },
    });

    assert.deepStrictEqual(seen.profile, { serverInvoke: 'http-api', edgeToRegional: true });
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

  it("the allowlist an adapter records with no image function (imageRemoteSources) reaches the asset proxy", () => {
    const seen: { profile?: BuildProfile } = {};
    const fixture = ssrFixture(tmpDir, seen);
    const stack = newStack('PreviewRemoteSources');
    new Hosting(stack, 'Hosting', {
      ...HostingPresets.preview,
      root: tmpDir,
      buildOutputDir: 'dist',
      api: MOCK_API,
      customAdapter: (dir) => {
        const manifest = fixture(dir);
        // What the Nitro and Astro adapters emit under skipImageOptimization.
        delete manifest.imageOptimization;
        manifest.imageRemoteSources = { domains: ['images.example.com'], remotePatterns: [{ hostname: '**.cdn.example.com' }] };
        return manifest;
      },
    });
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
      Code: { ZipFile: Match.stringLikeRegexp('IMAGE_REMOTE_HOSTS = \\["images\\.example\\.com","\\*\\*\\.cdn\\.example\\.com"\\]') },
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

/** The template's AWS CLI layers, split by whether a Lambda function references them. */
function awsCliLayers(t: Template): { used: string[]; unused: string[] } {
  const referenced = new Set<string>();
  for (const fn of Object.values(t.findResources('AWS::Lambda::Function'))) {
    for (const layer of (fn.Properties?.Layers ?? []) as unknown[]) {
      if (layer && typeof layer === 'object' && 'Ref' in layer) referenced.add(String(layer.Ref));
    }
  }
  const layers = Object.keys(t.findResources('AWS::Lambda::LayerVersion')).filter((id) => id.includes('AwsCliLayer'));
  return { used: layers.filter((id) => referenced.has(id)), unused: layers.filter((id) => !referenced.has(id)) };
}

/** Every bucket-upload custom resource's handler function carries a layer. */
function everyUploadHandlerHasALayer(t: Template): boolean {
  const fns = t.findResources('AWS::Lambda::Function');
  return Object.values(t.findResources('Custom::CDKBucketDeployment')).every((cr) => {
    const target = JSON.stringify(cr.Properties?.ServiceToken);
    const handlerId = Object.keys(fns).find((id) => target.includes(`"${id}"`));
    return Boolean(handlerId && (fns[handlerId].Properties?.Layers ?? []).length > 0);
  });
}

describe('AWS CLI layers: only an in-place (preview) build drops the unused ones', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-hosting-layers-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearRouteRegistry();
  });

  it('the default (CloudFront) build keeps every layer, including the unused ones', () => {
    createSpaBuildOutput(tmpDir);
    const stack = newStack('LayersDefault');
    new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API });
    const t = Template.fromStack(stack);
    const { used, unused } = awsCliLayers(t);
    // One layer per upload: the shared handler uses one, the others stay in the template.
    assert.ok(unused.length > 0, `expected the default build to keep its unused layers (used: ${used.join(', ')})`);
    assert.strictEqual(used.length + unused.length, Object.keys(t.findResources('Custom::CDKBucketDeployment')).length);
  });

  it('HostingPresets.production keeps every layer too', () => {
    createSpaBuildOutput(tmpDir);
    const stack = newStack('LayersProduction');
    new Hosting(stack, 'Hosting', { ...HostingPresets.production, root: tmpDir, api: MOCK_API });
    assert.ok(awsCliLayers(Template.fromStack(stack)).unused.length > 0);
  });

  it("buildId: 'fixed' behind the ALB (no preset) also drops them", () => {
    createSpaBuildOutput(tmpDir);
    const stack = newStack('LayersFixedAlb');
    new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'alb' }, buildId: 'fixed' });
    const t = Template.fromStack(stack);
    assert.deepStrictEqual(awsCliLayers(t).unused, []);
    assert.ok(everyUploadHandlerHasALayer(t));
  });

  it('HostingPresets.preview keeps only the layers a handler uses, and every upload still has one', () => {
    createSpaBuildOutput(tmpDir);
    const stack = newStack('LayersPreview');
    new Hosting(stack, 'Hosting', { ...HostingPresets.preview, root: tmpDir, api: MOCK_API });
    const t = Template.fromStack(stack);
    const { used, unused } = awsCliLayers(t);
    assert.deepStrictEqual(unused, []);
    assert.ok(used.length > 0);
    assert.ok(everyUploadHandlerHasALayer(t), 'every upload handler keeps its layer');
    // The runtime config upload is still in the template.
    assert.ok(Object.keys(t.findResources('Custom::CDKBucketDeployment')).some((id) => id.startsWith('HostingBlocksConfigDeployment')));
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

  it("edgeRoutes defaults to 'regional' behind the HTTP API door, and stays 'edge' elsewhere", () => {
    const httpSeen: { profile?: BuildProfile } = {};
    new Hosting(newStack('EdgeDefaultHttp'), 'Hosting', {
      root: tmpDir, buildOutputDir: 'dist', api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, httpSeen),
      frontDoor: { kind: 'apiGateway' },
    });
    assert.strictEqual(httpSeen.profile?.edgeToRegional, true);
    const cfSeen: { profile?: BuildProfile } = {};
    new Hosting(newStack('EdgeDefaultCf'), 'Hosting', {
      root: tmpDir, buildOutputDir: 'dist', api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, cfSeen),
    });
    assert.strictEqual(cfSeen.profile?.edgeToRegional, undefined);
  });

  it("a Lambda@Edge route behind a door other than CloudFront fails synth (explicit edgeRoutes: 'edge' on the HTTP API door)", () => {
    const seen: { profile?: BuildProfile } = {};
    const fixture = ssrFixture(tmpDir, seen);
    assert.throws(
      () =>
        new Hosting(newStack('EdgeExplicitHttp'), 'Hosting', {
          root: tmpDir, buildOutputDir: 'dist', api: MOCK_API,
          frontDoor: { kind: 'apiGateway' },
          edgeRoutes: 'edge',
          customAdapter: (dir) => {
            const manifest = fixture(dir);
            const edge = manifest.compute.edge1;
            manifest.compute.edge1 = { ...edge, type: 'edge', placement: 'global' };
            return manifest;
          },
        }),
      (err: Error) => err.name === 'EdgeRouteNeedsCloudFrontDoorError' && /only the CloudFront door invokes/.test(err.message),
    );
  });

  it('a region with no Lambda Web Adapter layer tells the adapters so', () => {
    const seen: { profile?: BuildProfile } = {};
    const stack = new Stack(new App(), 'NoWebAdapterRegion', { env: { account: '111111111111', region: 'il-central-1' } });
    new Hosting(stack, 'Hosting', {
      root: tmpDir, buildOutputDir: 'dist', api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, seen),
      frontDoor: { kind: 'apiGateway' },
    });
    assert.strictEqual(seen.profile?.lambdaWebAdapter, false);
    const supported: { profile?: BuildProfile } = {};
    new Hosting(newStack('WebAdapterRegion'), 'Hosting', {
      root: tmpDir, buildOutputDir: 'dist', api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, supported),
      frontDoor: { kind: 'apiGateway' },
    });
    assert.strictEqual(supported.profile?.lambdaWebAdapter, undefined);
  });

  it('a stack with no env (region unknown at synth) counts as one without the layer', () => {
    const seen: { profile?: BuildProfile } = {};
    new Hosting(new Stack(new App(), 'EnvAgnostic'), 'Hosting', {
      root: tmpDir, buildOutputDir: 'dist', api: MOCK_API,
      customAdapter: ssrFixture(tmpDir, seen),
      frontDoor: { kind: 'apiGateway' },
    });
    assert.strictEqual(seen.profile?.lambdaWebAdapter, false);
  });

  it("`buildId: 'fixed'` works behind the ALB (no edge cache)", () => {
    createSpaBuildOutput(tmpDir);
    const stack = newStack('FixedAlb');
    new Hosting(stack, 'Hosting', { root: tmpDir, api: MOCK_API, frontDoor: { kind: 'alb' }, buildId: 'fixed' });
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: { ASSET_KEY_PREFIX: Match.stringLikeRegexp('^builds/fixed-[0-9a-f]{16}$') } },
    });
  });

  const rejected: Array<[string, Partial<HostingProps>, RegExp]> = [
    ['imageOptimization: false behind CloudFront', { imageOptimization: false }, /imageOptimization: false.*'cloudfront' \(the default\)/],
    ['imageOptimization: false behind the ALB', { imageOptimization: false, frontDoor: { kind: 'alb' } }, /imageOptimization: false.*kind: 'alb'/],
    ["edgeRoutes: 'regional' behind CloudFront", { edgeRoutes: 'regional' }, /edgeRoutes: 'regional'/],
    ["buildId: 'fixed' behind CloudFront", { buildId: 'fixed' }, /buildId: 'fixed'.*edge cache/],
    ["buildId: 'fixed' behind frontDoor: null (the default door)", { buildId: 'fixed', frontDoor: null as never }, /buildId: 'fixed'.*'cloudfront' \(the default\)/],
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
