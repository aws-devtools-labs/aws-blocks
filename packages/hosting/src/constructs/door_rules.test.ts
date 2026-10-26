// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The app's redirects, per-pattern response headers and error pages on the
 * regional doors (ALB, API Gateway HTTP and REST), through `HostingConstruct`:
 *
 * - each redirect source reaches the asset proxy, which answers it with the
 *   CloudFront door's semantics (`asset_proxy.test.ts` runs that behavior);
 * - the proxies carry the app's rules and error pages;
 * - synth warns (`@aws-blocks/hosting:DoorRulesNotApplied`) naming exactly
 *   what the proxies can't reach: responses routed straight to the server, the
 *   image function or (on API Gateway) the backend.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import type { DeployManifest } from '../manifest/types.js';
import { doorCapabilitiesFor, HostingConstruct, type HostingConstructProps } from './hosting_construct.js';

const API_URL = 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api';
const WARNING = '@aws-blocks/hosting:DoorRulesNotApplied';

describe("regional doors apply the app's redirects, header rules and error pages", () => {
  let tmpDir: string;
  let bundleDir: string;
  let notFoundPage: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-door-rules-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
    bundleDir = path.join(tmpDir, 'server');
    fs.mkdirSync(bundleDir);
    fs.writeFileSync(path.join(bundleDir, 'run.sh'), '#!/bin/sh\nnode server.js');
    notFoundPage = path.join(tmpDir, 'my-404.html');
    fs.writeFileSync(notFoundPage, '<!DOCTYPE html><html><body>custom 404</body></html>');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const rules = {
    redirects: [
      { source: '/old/*', destination: '/new/*', statusCode: 301 as const },
      { source: '/legacy', destination: '/', statusCode: 302 as const },
    ],
    headers: [{ source: '/assets/*', headers: { 'X-Asset-Rule': 'assets' } }],
  };
  const spa = (): DeployManifest => ({
    version: 1,
    buildId: 'rules1',
    compute: {},
    staticAssets: { directory: tmpDir, spaFallback: true },
    routes: [
      { pattern: '/assets/*', target: 'static' },
      { pattern: '/*', target: 'static' },
    ],
    ...rules,
  });
  const ssr = (): DeployManifest => ({
    version: 1,
    buildId: 'rules2',
    compute: {
      server: { type: 'http-server', bundle: bundleDir, entrypoint: 'run.sh', port: 3000, placement: 'regional' },
    },
    staticAssets: { directory: tmpDir },
    routes: [
      { pattern: '/assets/*', target: 'static' },
      { pattern: '/*', target: 'server' },
    ],
    ...rules,
  });
  const synth = (manifest: DeployManifest, frontDoor: HostingConstructProps['frontDoor'], extra: Partial<HostingConstructProps> = {}) => {
    const stack = new Stack(new App(), 'S', { env: { account: '111111111111', region: 'us-west-2' } });
    new HostingConstruct(stack, 'Hosting', {
      manifest,
      frontDoor,
      errorPages: { notFound: notFoundPage },
      ...extra,
    });
    return { t: Template.fromStack(stack), warnings: Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp(WARNING)) };
  };
  const assetProxySource = (t: Template): string => {
    const fn = Object.values(t.findResources('AWS::Lambda::Function')).find((f) =>
      String(f.Properties.Code?.ZipFile ?? '').includes('BLOCKS_REDIRECTS'),
    );
    assert.ok(fn, 'an asset proxy with the rules');
    return String(fn.Properties.Code.ZipFile);
  };
  const warningText = (warnings: Array<{ entry: { data?: unknown } }>): string =>
    warnings.map((w) => String(w.entry.data)).join('\n');

  it('ALB: the asset proxy carries the redirects, header rules and the 404 page', () => {
    const { t } = synth(spa(), { kind: 'alb' }, { backendApi: { url: API_URL } });
    const source = assetProxySource(t);
    assert.ok(source.includes('["/old/*","/new/*",301]'));
    assert.ok(source.includes('["/legacy","/",302]'));
    assert.ok(source.includes('"x-asset-rule"') || source.includes('"X-Asset-Rule"'));
    assert.match(source, /NOT_FOUND_PAGE = "404\.html"/);
    // The API forwarder carries the header rules too.
    const forwarder = Object.values(t.findResources('AWS::Lambda::Function')).find((f) =>
      String(f.Properties.Code?.ZipFile ?? '').includes('API_GW_BASE'),
    );
    assert.ok(String(forwarder?.Properties.Code.ZipFile).includes('BLOCKS_HEADER_RULES = [["/assets/*"'));
  });

  it('ALB SPA (no server): every response passes through a proxy, so no warning', () => {
    const { warnings } = synth(spa(), { kind: 'alb' }, { backendApi: { url: API_URL }, errorPages: undefined });
    assert.deepEqual(warnings, []);
  });

  it('ALB SSR: warns that SSR responses get no header rules and server/API errors pass through', () => {
    const { warnings } = synth(ssr(), { kind: 'alb' }, { backendApi: { url: API_URL } });
    assert.equal(warnings.length, 1);
    const text = warningText(warnings);
    assert.match(text, /ALB front door/);
    assert.match(text, /server-rendered \(SSR\) responses/);
    assert.doesNotMatch(text, /API responses/, 'the ALB forwarder applies the header rules to the API');
    assert.match(text, /error responses from the server and the API pass through unchanged/);
  });

  it("stacked router (CloudFront-only ALB): no warning — the edge applies the rules to every response", () => {
    const { warnings } = synth(ssr(), { kind: 'stackedRouter' }, { backendApi: { url: API_URL } });
    assert.deepEqual(warnings, []);
  });

  it('API Gateway (HTTP): each redirect source routes to the asset proxy; warns about API and SSR responses', () => {
    const { t, warnings } = synth(ssr(), { kind: 'apiGateway' }, { backendApi: { url: API_URL } });
    const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route'));
    const integrations = t.findResources('AWS::ApiGatewayV2::Integration');
    const assetIntegrationIds = Object.entries(integrations)
      .filter(([, r]) => JSON.stringify(r.Properties.IntegrationUri).includes('AssetProxy'))
      .map(([id]) => id);
    for (const key of ['ANY /old/{proxy+}', 'ANY /legacy']) {
      const route = routes.find((r) => r.Properties.RouteKey === key);
      assert.ok(route, `route ${key}`);
      assert.ok(
        assetIntegrationIds.some((id) => JSON.stringify(route.Properties.Target).includes(id)),
        `${key} → the asset proxy`,
      );
    }
    assert.ok(assetProxySource(t).includes('["/old/*","/new/*",301]'));
    const text = warningText(warnings);
    assert.match(text, /API Gateway front door/);
    assert.match(text, /server-rendered \(SSR\) responses, API responses/);
  });

  it('API Gateway (REST): each redirect source is a resource on the asset proxy', () => {
    const { t } = synth(ssr(), { kind: 'apiGateway', api: 'rest' }, { backendApi: { url: API_URL }, 
      domain: { domainName: 'app.example.com', hostedZoneId: 'Z1234567890ABC', hostedZone: 'example.com' },
    });
    const parts = Object.values(t.findResources('AWS::ApiGateway::Resource')).map((r) => String(r.Properties.PathPart));
    assert.ok(parts.includes('old') && parts.includes('legacy'), `resources: ${parts.join(', ')}`);
    assert.ok(assetProxySource(t).includes('["/legacy","/",302]'));
  });

  it('API Gateway (HTTP and REST): a redirect source with an inner wildcard warns that the server answers it', () => {
    const inner = (): DeployManifest => ({
      ...ssr(),
      redirects: [...rules.redirects, { source: '/docs/*.html', destination: '/guide/*', statusCode: 301 }],
    });
    const redirectWarnings = (frontDoor: HostingConstructProps['frontDoor'], manifest: DeployManifest, extra = {}) => {
      const stack = new Stack(new App(), 'R', { env: { account: '111111111111', region: 'us-west-2' } });
      new HostingConstruct(stack, 'Hosting', { manifest, frontDoor, ...extra });
      return Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('RedirectNotExpressible'));
    };
    const domain = { domainName: 'app.example.com', hostedZoneId: 'Z1234567890ABC', hostedZone: 'example.com' };
    for (const [frontDoor, extra] of [
      [{ kind: 'apiGateway' }, {}],
      [{ kind: 'apiGateway', api: 'rest' }, { domain }],
    ] as const) {
      const warnings = redirectWarnings(frontDoor, inner(), extra);
      assert.equal(warnings.length, 1, JSON.stringify(frontDoor));
      assert.match(warningText(warnings), /\/docs\/\*\.html/);
      assert.doesNotMatch(warningText(warnings), /\/old\/\*/, 'a routable source is not named');
    }
    // A SPA's default is the asset proxy, which applies every redirect: no warning.
    const spaInner: DeployManifest = { ...spa(), redirects: inner().redirects };
    assert.deepEqual(redirectWarnings({ kind: 'apiGateway' }, spaInner), []);
  });

  it("each door's declared capabilities match what synth reports (wildcardRoutes, appliesRules)", () => {
    const domain = { domainName: 'app.example.com', hostedZoneId: 'Z1234567890ABC', hostedZone: 'example.com' };
    const innerWildcard = (): DeployManifest => ({
      ...ssr(),
      routes: [{ pattern: '/assets/*.js', target: 'static' }, ...ssr().routes],
    });
    const warned = (manifest: DeployManifest, frontDoor: HostingConstructProps['frontDoor'], id: string, extra = {}) => {
      const stack = new Stack(new App(), 'Caps', { env: { account: '111111111111', region: 'us-west-2' } });
      new HostingConstruct(stack, 'Hosting', { manifest, frontDoor, backendApi: { url: API_URL }, ...extra });
      return Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp(id)).length > 0;
    };
    for (const [frontDoor, extra] of [
      [undefined, {}],
      [{ kind: 'alb' }, {}],
      [{ kind: 'stackedRouter' }, {}],
      [{ kind: 'apiGateway' }, {}],
      [{ kind: 'apiGateway', api: 'rest' }, { domain }],
    ] as const) {
      const caps = doorCapabilitiesFor(frontDoor);
      const label = JSON.stringify(frontDoor ?? 'cloudfront');
      assert.equal(warned(innerWildcard(), frontDoor, 'RouteNotExpressible', extra), caps.wildcardRoutes === false, `${label} wildcardRoutes`);
      assert.equal(warned(ssr(), frontDoor, 'DoorRulesNotApplied', extra), caps.appliesRules === false, `${label} appliesRules`);
    }
  });
});

