// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The built-in non-CloudFront doors (ALB, API Gateway HTTP and REST, and the
 * ALB router of the stacked door), end to end through `HostingConstruct`:
 *
 * - every path in `DoorInput.origins.api.paths` (`/aws-blocks/*` plus the
 *   backend's raw routes) reaches the backend, as on the CloudFront door;
 * - the server compute answers in the mode the door can carry (buffered behind
 *   a door that invokes it without streaming), and `origins.server.streaming`
 *   says so;
 * - a bare REST door (no custom domain) fails synth instead of deploying an
 *   app whose root-relative links miss the `/prod` stage.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { DeployManifest } from '../manifest/types.js';
import type { HostingPlan } from '../plan/types.js';
import { AlbConstruct } from './alb_construct.js';
import { cf } from './cf_helpers.js';
import { type DoorInput, defineFrontDoor } from './front_door.js';
import { HostingConstruct, type HostingConstructProps } from './hosting_construct.js';

const API_URL = 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/aws-blocks/api';
const RAW_ROUTES = ['/hooks/door-probe', '/users/*'];

type Template_ = ReturnType<typeof Template.fromStack>;

/** All ALB listener-rule path values, flattened. */
const albRulePaths = (t: Template_): string[] =>
  Object.values(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule')).flatMap((r) =>
    (r.Properties.Conditions as Array<{ Field: string; PathPatternConfig?: { Values: string[] } }>).flatMap(
      (c) => c.PathPatternConfig?.Values ?? [],
    ),
  );

/** All HTTP API route keys. */
const httpRouteKeys = (t: Template_): string[] =>
  Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map((r) => String(r.Properties.RouteKey));

/** All REST resource path parts. */
const restPathParts = (t: Template_): string[] =>
  Object.values(t.findResources('AWS::ApiGateway::Resource')).map((r) => String(r.Properties.PathPart));

/** The LWA invoke mode on the server function. */
const lwaModes = (t: Template_): string[] =>
  Object.values(t.findResources('AWS::Lambda::Function'))
    .map((r) => r.Properties.Environment?.Variables?.AWS_LWA_INVOKE_MODE)
    .filter((v): v is string => typeof v === 'string');

describe('built-in doors — raw routes, server response mode, REST addressability', () => {
  let tmpDir: string;
  let bundleDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-doors-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
    bundleDir = path.join(tmpDir, 'server');
    fs.mkdirSync(bundleDir);
    fs.writeFileSync(path.join(bundleDir, 'run.sh'), '#!/bin/sh\nnode server.js');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const spaManifest = (): DeployManifest => ({
    version: 1,
    buildId: 'doors1',
    compute: {},
    staticAssets: { directory: tmpDir, spaFallback: true },
    routes: [{ pattern: '/*', target: 'static' }],
  });

  /** An SSR app on the Lambda Web Adapter (Astro / Nuxt / SvelteKit shape). */
  const ssrManifest = (): DeployManifest => ({
    version: 1,
    buildId: 'doors2',
    compute: {
      server: {
        type: 'http-server',
        bundle: bundleDir,
        entrypoint: 'run.sh',
        port: 3000,
        placement: 'regional',
        streaming: true,
      },
    },
    staticAssets: { directory: tmpDir },
    routes: [
      { pattern: '/_astro/*', target: 'static' },
      { pattern: '/*', target: 'server' },
    ],
  });

  const synth = (
    manifest: DeployManifest,
    frontDoor: HostingConstructProps['frontDoor'],
    extra: Partial<HostingConstructProps> = {},
  ) => {
    const stack = new Stack(new App(), 'S', { env: { account: '111111111111', region: 'us-west-2' } });
    const hosting = new HostingConstruct(stack, 'Hosting', { manifest, frontDoor, ...extra });
    return { t: Template.fromStack(stack), hosting };
  };

  const DOMAIN = { domainName: 'app.example.com', hostedZoneId: 'Z1234567890ABC', hostedZone: 'example.com' };

  // ── A. Raw routes reach the backend ──────────────────────────────────────

  describe('A — every origins.api.paths entry reaches the backend', () => {
    it('ALB: one rule carries /aws-blocks/* plus each raw route; no stale /aws-blocks-auth/*', () => {
      const { t } = synth(spaManifest(), { kind: 'alb' }, { backendApi: { url: API_URL, paths: RAW_ROUTES } });
      const paths = albRulePaths(t);
      for (const p of ['/aws-blocks/*', ...RAW_ROUTES]) assert.ok(paths.includes(p), `ALB routes ${p}`);
      assert.ok(!paths.includes('/aws-blocks-auth/*'), 'no stale /aws-blocks-auth/* rule');
    });

    it('ALB: more paths than one rule can hold (5 path values) are split across rules', () => {
      const many = Array.from({ length: 11 }, (_, i) => `/raw${i}`);
      const { t } = synth(spaManifest(), { kind: 'alb' }, { backendApi: { url: API_URL, paths: many } });
      const rules = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'));
      for (const r of rules) {
        for (const c of r.Properties.Conditions as Array<{ PathPatternConfig?: { Values: string[] } }>) {
          assert.ok((c.PathPatternConfig?.Values.length ?? 0) <= 5, 'at most 5 path values per rule');
        }
      }
      const paths = albRulePaths(t);
      for (const p of ['/aws-blocks/*', ...many]) assert.ok(paths.includes(p), `ALB routes ${p}`);
    });

    it('ALB: too many API paths for the reserved priority band fails synth with a clear error', () => {
      const tooMany = Array.from({ length: 500 }, (_, i) => `/raw${i}`);
      assert.throws(
        () => synth(spaManifest(), { kind: 'alb' }, { backendApi: { url: API_URL, paths: tooMany } }),
        /TooManyApiPathsError|listener rule/,
      );
    });

    it('stacked (the ALB router): the raw routes reach the backend', () => {
      // The Blocks layer builds the stacked door's router as `{ kind: 'alb' }`.
      const { t } = synth(spaManifest(), { kind: 'alb' }, { backendApi: { url: API_URL, paths: RAW_ROUTES } });
      assert.ok(albRulePaths(t).includes('/hooks/door-probe'));
    });

    it('API Gateway HTTP: a route per raw route, proxied to the same path on the backend', () => {
      const { t } = synth(spaManifest(), { kind: 'apiGateway' }, { backendApi: { url: API_URL, paths: RAW_ROUTES } });
      const keys = httpRouteKeys(t);
      assert.ok(keys.includes('ANY /aws-blocks/{proxy+}'));
      assert.ok(keys.includes('ANY /hooks/door-probe'), `routes: ${keys.join(', ')}`);
      assert.ok(keys.includes('ANY /users/{proxy+}'));
      assert.ok(!keys.some((k) => k.includes('/aws-blocks-auth')), 'no stale /aws-blocks-auth route');
      t.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
        IntegrationType: 'HTTP_PROXY',
        // Proxied to the same path on the backend's stage (API_URL minus `/aws-blocks/api`).
        IntegrationUri: 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/hooks/door-probe',
      });
    });

    it('API Gateway REST: a resource per raw route with an HTTP_PROXY method', () => {
      const { t } = synth(
        spaManifest(),
        { kind: 'apiGateway', api: 'rest' },
        { domain: DOMAIN, backendApi: { url: API_URL, paths: RAW_ROUTES } },
      );
      const parts = restPathParts(t);
      for (const p of ['hooks', 'door-probe', 'users']) assert.ok(parts.includes(p), `REST resource ${p}`);
      assert.ok(!parts.includes('aws-blocks-auth'), 'no stale /aws-blocks-auth resource');
    });

    it('the door input lists the same paths the door routes', () => {
      const { hosting } = synth(spaManifest(), { kind: 'apiGateway' }, { backendApi: { url: API_URL, paths: RAW_ROUTES } });
      assert.deepEqual(hosting.doorInput?.origins.api?.paths, ['/aws-blocks/*', ...RAW_ROUTES]);
    });

    it('construct default (no paths given): the single-compute backend gets /aws-blocks/* only', () => {
      const plan: HostingPlan = {
        origins: [{ id: 'blocks-s3', kind: 'static' }],
        routes: { entries: [], redirects: [], headers: [] },
        policies: { spaFallback: true, hasServer: false, skewEnabled: false },
        release: { buildId: 'b' },
        backend: { origins: [{ namespace: '*', ingress: { kind: 'url', url: API_URL } }] },
      };
      const stack = new Stack(new App(), 'C', { env: { account: '111111111111', region: 'us-west-2' } });
      new AlbConstruct(stack, 'Alb', { plan, bucket: new Bucket(stack, 'B') });
      assert.deepEqual(albRulePaths(Template.fromStack(stack)), ['/aws-blocks/*']);
    });
  });

  // ── B. Server response mode follows the door ─────────────────────────────

  describe('B — the server answers in the mode the door can carry', () => {
    const cases: Array<[string, HostingConstructProps['frontDoor'], 'buffered' | 'response_stream']> = [
      ['CloudFront (default)', undefined, 'response_stream'],
      ['ALB', { kind: 'alb' }, 'buffered'],
      ['API Gateway HTTP', { kind: 'apiGateway' }, 'buffered'],
      ['API Gateway REST', { kind: 'apiGateway', api: 'rest' }, 'response_stream'],
    ];
    for (const [label, frontDoor, mode] of cases) {
      it(`${label}: AWS_LWA_INVOKE_MODE=${mode}`, () => {
        const extra = label === 'API Gateway REST' ? { domain: DOMAIN } : {};
        const { t, hosting } = synth(ssrManifest(), frontDoor, extra);
        assert.deepEqual(lwaModes(t), [mode]);
        if (hosting.doorInput) {
          assert.equal(hosting.doorInput.origins.server?.streaming, mode === 'response_stream');
        }
      });
    }

    it('API Gateway REST streams the SSR integration (ResponseTransferMode STREAM), like the CloudFront door', () => {
      const { t } = synth(ssrManifest(), { kind: 'apiGateway', api: 'rest' }, { domain: DOMAIN });
      t.hasResourceProperties('AWS::ApiGateway::Method', {
        Integration: Match.objectLike({ Type: 'AWS_PROXY', ResponseTransferMode: 'STREAM' }),
      });
    });

    const customDoor = (serverResponse?: 'streaming' | 'buffered', seen: { input?: DoorInput } = {}) =>
      defineFrontDoor({
        service: 'my-door',
        ...(serverResponse ? { serverResponse } : {}),
        build(_scope, input) {
          seen.input = input;
          // Reading the Function URL creates it, in the server's invoke mode.
          void input.origins.server?.url;
          cf.recordWired(input.origins.assets);
          return { url: 'https://door.example.com' };
        },
      });

    it('custom door: streams by default', () => {
      const seen: { input?: DoorInput } = {};
      const { t } = synth(ssrManifest(), { kind: 'custom', door: customDoor(undefined, seen) });
      assert.deepEqual(lwaModes(t), ['response_stream']);
      assert.equal(seen.input?.origins.server?.streaming, true);
      t.hasResourceProperties('AWS::Lambda::Url', { InvokeMode: 'RESPONSE_STREAM' });
    });

    it("custom door: serverResponse 'buffered' → buffered server, streaming: false, BUFFERED Function URL", () => {
      const seen: { input?: DoorInput } = {};
      const { t } = synth(ssrManifest(), { kind: 'custom', door: customDoor('buffered', seen) });
      assert.deepEqual(lwaModes(t), ['buffered']);
      assert.equal(seen.input?.origins.server?.streaming, false);
      t.hasResourceProperties('AWS::Lambda::Url', { InvokeMode: 'BUFFERED' });
    });
  });

  // ── D. A bare REST door is not addressable from the root ─────────────────

  describe('D — REST door without a custom domain', () => {
    it('fails synth with an actionable error', () => {
      assert.throws(
        () => synth(spaManifest(), { kind: 'apiGateway', api: 'rest' }, { backendApi: { url: API_URL } }),
        (err: Error) =>
          err.name === 'RestFrontDoorNeedsDomainError' && /\/prod/.test(err.message) && /domain/.test(err.message),
      );
    });

    it('builds with a custom domain mapped to the stage (the URL is the domain root)', () => {
      const { hosting } = synth(spaManifest(), { kind: 'apiGateway', api: 'rest' }, { backendApi: { url: API_URL }, domain: DOMAIN });
      // A bare origin: the browser's Origin header has no trailing slash, and the
      // URL becomes BLOCKS_PUBLIC_ORIGIN and the CORS hosting origin.
      assert.equal(hosting.distributionUrl, 'https://app.example.com');
    });
  });

  // ── E. The build cutover waits for the uploads ───────────────────────────

  describe('E — the asset proxy switches to the new build only after every upload', () => {
    /** The asset-proxy function's logical id and its `DependsOn`. */
    const proxyDependsOn = (t: Template_): string[] => {
      const json = t.toJSON().Resources as Record<string, { Type: string; DependsOn?: string[]; Properties?: { Environment?: { Variables?: Record<string, unknown> } } }>;
      const proxy = Object.values(json).find(
        (r) => r.Type === 'AWS::Lambda::Function' && r.Properties?.Environment?.Variables?.ASSET_KEY_PREFIX !== undefined,
      );
      assert.ok(proxy, 'an asset proxy');
      return proxy.DependsOn ?? [];
    };
    const uploads = (t: Template_): string[] => Object.keys(t.findResources('Custom::CDKBucketDeployment'));

    const cases: Array<[string, HostingConstructProps['frontDoor'], Partial<HostingConstructProps>]> = [
      ['ALB', { kind: 'alb' }, {}],
      ['API Gateway HTTP', { kind: 'apiGateway' }, {}],
      ['API Gateway REST', { kind: 'apiGateway', api: 'rest' }, { domain: DOMAIN }],
      ['the stacked router', { kind: 'stackedRouter' }, {}],
    ];
    for (const [label, frontDoor, extra] of cases) {
      it(`${label}: the proxy (whose environment names the build) depends on every Custom::CDKBucketDeployment`, () => {
        const { t } = synth(spaManifest(), frontDoor, { errorPages: undefined, ...extra });
        const deps = proxyDependsOn(t);
        const all = uploads(t);
        assert.ok(all.length >= 2);
        for (const u of all) assert.ok(deps.includes(u), `${label}: proxy waits for ${u}`);
      });
    }

    it('an upload declared later (the runtime config) is ordered before the proxy too', () => {
      const stack = new Stack(new App(), 'Later', { env: { account: '111111111111', region: 'us-west-2' } });
      const hosting = new HostingConstruct(stack, 'Hosting', { manifest: spaManifest(), frontDoor: { kind: 'alb' } });
      const later = new Bucket(stack, 'Later');
      hosting.addBuildAssetDependency(later);
      const deps = proxyDependsOn(Template.fromStack(stack));
      assert.ok(deps.some((d) => d.startsWith('Later')), 'the proxy waits for the later dependency');
    });
  });

  // ── F. API Gateway route shapes and resource policies ────────────────────

  describe('F — API Gateway routes and permissions', () => {
    it('a wildcard prefix route also gets its bare path (`/users/*` serves `/users` and `/users/`)', () => {
      const { t } = synth(spaManifest(), { kind: 'apiGateway' }, { backendApi: { url: API_URL, paths: RAW_ROUTES } });
      const keys = httpRouteKeys(t);
      assert.ok(keys.includes('ANY /users/{proxy+}'));
      assert.ok(keys.includes('ANY /users'));
    });

    it('a backend route with a wildcard inside a segment fails with a named error on both flavors', () => {
      for (const [door, extra] of [
        [{ kind: 'apiGateway' }, {}],
        [{ kind: 'apiGateway', api: 'rest' }, { domain: DOMAIN }],
      ] as const) {
        assert.throws(
          () => synth(spaManifest(), door, { ...extra, backendApi: { url: API_URL, paths: ['/files*'] } }),
          (e: Error) => e.name === 'UnsupportedRoutePatternError' && /\/files\*/.test(e.message),
        );
      }
    });

    it('one API-scoped invoke permission per function, however many routes (HTTP and REST)', () => {
      const routes = Array.from({ length: 40 }, (_, i) => ({ pattern: `/s${i}/*`, target: 'static' }));
      const many = (): DeployManifest => ({ ...spaManifest(), routes: [...routes, { pattern: '/*', target: 'static' }] });
      for (const [door, extra] of [
        [{ kind: 'apiGateway' }, {}],
        [{ kind: 'apiGateway', api: 'rest' }, { domain: DOMAIN }],
      ] as const) {
        const { t } = synth(many(), door, extra);
        const perms = Object.values(t.findResources('AWS::Lambda::Permission')).filter(
          (p) => p.Properties.Principal === 'apigateway.amazonaws.com',
        );
        assert.equal(perms.length, 1, `${JSON.stringify(door)}: one permission for the asset proxy`);
      }
    });

    it('the REST door counts resources (every segment), not methods, against the 300 quota', () => {
      const deep = Array.from({ length: 100 }, (_, i) => ({ pattern: `/a${i}/b/c`, target: 'static' }));
      const stack = new Stack(new App(), 'Deep', { env: { account: '111111111111', region: 'us-west-2' } });
      new HostingConstruct(stack, 'Hosting', {
        manifest: { ...spaManifest(), routes: [...deep, { pattern: '/*', target: 'static' }] },
        frontDoor: { kind: 'apiGateway', api: 'rest' },
        domain: DOMAIN,
      });
      const warnings = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('defines \\d+ resources'));
      assert.equal(warnings.length, 1);
      // 100 × 3 segments, the greedy `{proxy+}` and the root; only 102 methods.
      assert.match(String(warnings[0]?.entry.data), /defines 302 resources/);
    });
  });

  // ── G. The door's kind, address and transport ────────────────────────────

  describe("G — frontDoorKind, loadBalancerDnsName, plain HTTP", () => {
    const namedCloudFront = defineFrontDoor({
      service: 'cloudfront',
      build(scope, input: DoorInput) {
        const bucket = new Bucket(scope, 'Unused');
        cf.recordWired(input.origins.assets);
        return { url: `https://${bucket.bucketDomainName}` };
      },
    });

    it('a custom door may be called `cloudfront`: its kind is still custom, and it has no distribution or ALB name', () => {
      const { hosting } = synth(spaManifest(), { kind: 'custom', door: namedCloudFront });
      assert.equal(hosting.frontDoorKind, 'custom');
      assert.equal(hosting.frontDoor.service, 'cloudfront');
      assert.equal(hosting.loadBalancerDnsName, undefined);
      assert.throws(() => hosting.distribution, (e: Error) => e.name === 'FrontDoorNotCloudFrontError');
    });

    it('the built-in kinds', () => {
      assert.equal(synth(spaManifest(), undefined).hosting.frontDoorKind, 'cloudfront');
      assert.equal(synth(spaManifest(), 'none').hosting.frontDoorKind, 'none');
      const alb = synth(spaManifest(), { kind: 'alb' }).hosting;
      assert.equal(alb.frontDoorKind, 'alb');
      assert.ok(alb.loadBalancerDnsName);
      assert.equal(synth(spaManifest(), { kind: 'stackedRouter' }).hosting.frontDoorKind, 'alb');
      assert.equal(synth(spaManifest(), { kind: 'apiGateway' }).hosting.loadBalancerDnsName, undefined);
    });

    it('a plain-HTTP door with an API warns that sign-in and cookies travel unencrypted', () => {
      const warn = (frontDoor: HostingConstructProps['frontDoor'], extra: Partial<HostingConstructProps> = {}) => {
        const stack = new Stack(new App(), 'Http', { env: { account: '111111111111', region: 'us-west-2' } });
        new HostingConstruct(stack, 'Hosting', { manifest: spaManifest(), frontDoor, ...extra });
        return Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('PlainHttpFrontDoor'));
      };
      const alb = warn({ kind: 'alb' }, { backendApi: { url: API_URL } });
      assert.equal(alb.length, 1);
      assert.match(JSON.stringify(alb[0].entry.data), /AuthCognito and AuthOIDC keep it/);
      assert.equal(warn({ kind: 'alb' }).length, 0, 'no API: nothing sensitive');
      assert.equal(warn({ kind: 'apiGateway' }, { backendApi: { url: API_URL } }).length, 0, 'HTTPS');
      // The S3 website's URL is a token at synth; its handle says it is plain HTTP.
      const none = warn('none', { backendApi: { url: API_URL } });
      assert.equal(none.length, 1);
      assert.match(JSON.stringify(none[0].entry.data), /an S3 website has no TLS/);
    });

    it('the ALB door with a custom domain: the URL, the trusted origin and the CORS origin are the domain', () => {
      const certificate = Certificate.fromCertificateArn(
        new Stack(new App(), 'CertScope', { env: { account: '111111111111', region: 'us-west-2' } }),
        'C',
        'arn:aws:acm:us-west-2:111111111111:certificate/c',
      );
      const { hosting } = synth(spaManifest(), { kind: 'alb', certificate, features: { domain: DOMAIN } });
      assert.equal(hosting.distributionUrl, 'https://app.example.com');
      // The load balancer's own name, which the domain's alias records point at — never the domain itself.
      const dns = JSON.stringify(Stack.of(hosting).resolve(hosting.loadBalancerDnsName));
      assert.match(dns, /"Fn::GetAtt":\["[A-Za-z0-9]+","DNSName"\]/);
      assert.doesNotMatch(dns, /app\.example\.com/);
    });
  });
});
