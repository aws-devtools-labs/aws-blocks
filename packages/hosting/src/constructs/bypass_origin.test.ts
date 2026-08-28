// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { BypassOriginConstruct } from './bypass_origin.js';
import type { DeployManifest } from '../manifest/types.js';

const baseManifest = (over: Partial<DeployManifest> = {}): DeployManifest => ({
  version: 1,
  compute: {},
  staticAssets: { directory: '/tmp/assets', immutablePaths: [] },
  routes: [],
  ...over,
});

type Opts = { server?: boolean; backendApiUrl?: string };

const synth = (manifest: DeployManifest, opts: Opts = {}): Template => {
  const stack = new Stack(new App(), 'T');
  const bucket = new Bucket(stack, 'Bucket');
  const computeFunctions = new Map<string, LambdaFunction>();
  let serverComputeName: string | undefined;
  if (opts.server) {
    computeFunctions.set(
      'default',
      new LambdaFunction(stack, 'Ssr', {
        runtime: Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: Code.fromInline('exports.handler = async () => ({});'),
      }),
    );
    serverComputeName = 'default';
  }
  new BypassOriginConstruct(stack, 'Bypass', {
    manifest,
    buildId: 'preview',
    bucket,
    computeFunctions,
    serverComputeName,
    backendApiUrl: opts.backendApiUrl,
  });
  return Template.fromStack(stack);
};

// All HTTP API v2 route keys ("METHOD /path" or "$default") in the template.
const routeKeys = (t: Template): string[] =>
  Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map(
    (r) => (r.Properties as { RouteKey: string }).RouteKey,
  );

describe('BypassOriginConstruct', () => {
  it('creates one HTTP API v2 origin + an asset-proxy Lambda', () => {
    const t = synth(baseManifest({ staticAssets: { directory: '/tmp', immutablePaths: ['assets/*'] } }));
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    // asset-proxy Lambda (inline) is always created
    t.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs22.x' });
  });

  it('static/SPA site: has a $default route + a Lambda invoke permission (the $default fix)', () => {
    const t = synth(
      baseManifest({
        staticAssets: { directory: '/tmp', immutablePaths: ['assets/*'], spaFallback: true },
        routes: [{ pattern: '/*', target: 'static' }],
      }),
    );
    assert.ok(routeKeys(t).includes('$default'), 'expected a $default route');
    // scopePermissionToRoute:false grant + the explicit `*/*` grant that covers
    // $default — at least one Lambda invoke permission must exist.
    assert.ok(
      Object.keys(t.findResources('AWS::Lambda::Permission')).length >= 1,
      'expected an api-scoped Lambda invoke permission',
    );
  });

  it('static prefixes answer GET/HEAD/OPTIONS (module-loader fix), bare + greedy', () => {
    const keys = routeKeys(synth(baseManifest({ staticAssets: { directory: '/tmp', immutablePaths: ['_next/static/*'] } })));
    for (const m of ['GET', 'HEAD', 'OPTIONS']) {
      assert.ok(keys.includes(`${m} /_next/{proxy+}`), `expected ${m} /_next/{proxy+}`);
    }
  });

  it('mounts a bare route only for a prerendered bare page, greedy for nested subtrees', () => {
    const keys = routeKeys(
      synth(
        baseManifest({
          routes: [
            { pattern: '/about/*', target: 'static' }, // prerendered bare page → bare route
            { pattern: '/products/p1/*', target: 'static' }, // nested only → NO bare route
            { pattern: '/*', target: 'default' },
          ],
        }),
        { server: true },
      ),
    );
    assert.ok(keys.includes('GET /about'), 'bare /about should be routed (prerendered bare page)');
    assert.ok(keys.includes('GET /about/{proxy+}'), 'greedy /about subtree should be routed');
    assert.ok(!keys.includes('GET /products'), 'bare /products must NOT be captured (dynamic index → SSR)');
    assert.ok(keys.includes('GET /products/{proxy+}'), 'greedy /products subtree should be routed');
  });

  it('mounts image endpoints at basePath (NOT assetPrefix)', () => {
    // Next-style: assetPrefix differs from basePath (root). Static `_next` lives
    // under the asset prefix, but `/_next/image` must be at the root.
    const keys = routeKeys(
      synth(
        baseManifest({
          assetPrefix: '/cdn-assets',
          staticAssets: { directory: '/tmp', immutablePaths: ['_next/static/*'] },
        }),
        { server: true },
      ),
    );
    assert.ok(keys.includes('GET /cdn-assets/_next/{proxy+}'), 'static _next under assetPrefix');
    assert.ok(keys.includes('GET /_next/image'), '_next/image at root basePath, not under assetPrefix');
    assert.ok(keys.includes('GET /_ipx/{proxy+}'), '_ipx at root');
    assert.ok(keys.includes('GET /_image'), '_image (query form) at root');
  });

  it('prefixes image endpoints with basePath when set', () => {
    const keys = routeKeys(
      synth(baseManifest({ basePath: '/myapp' }), { server: true }),
    );
    assert.ok(keys.includes('GET /myapp/_ipx/{proxy+}'), '_ipx under basePath');
    assert.ok(keys.includes('GET /myapp/_next/image'), '_next/image under basePath');
  });

  it('proxies /aws-blocks/* and /auth/* to the backend when backendApiUrl is set', () => {
    const keys = routeKeys(
      synth(baseManifest(), { server: true, backendApiUrl: 'https://h.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api' }),
    );
    assert.ok(keys.includes('ANY /aws-blocks/{proxy+}'), 'aws-blocks proxy route');
    assert.ok(keys.includes('ANY /auth/{proxy+}'), 'auth proxy route');
  });
});
