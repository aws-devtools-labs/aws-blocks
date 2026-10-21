/**
 * `cf.redirects`, `cf.headers`, `cf.errorPages`: a bring-your-own door wires
 * the app's redirects, per-pattern headers and error pages the way the built-in
 * CloudFront door does (the same matcher code, the same error responses), the
 * wiring check warns about rules a door left unwired, and the origin
 * verification secret is confined to the built-in door's own SSR REST API.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Distribution, FunctionEventType } from 'aws-cdk-lib/aws-cloudfront';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { DeployManifest } from '../manifest/types.js';
import type { HostingPlan } from '../plan/types.js';
import { cf } from './cf_helpers.js';
import { buildDoorInput } from './door_input.js';
import { customErrorResponses } from './error_responses.js';
import { type DoorInput, defineFrontDoor } from './front_door.js';
import { HostingConstruct } from './hosting_construct.js';
import { CF_MATCH_HELPERS, generateKvsRouterRequestCode, generateKvsRouterResponseCode, headerRowsJs, redirectRowsJs } from './kvs_router.js';

type CfEvent = { request: { uri: string; headers: Record<string, unknown> }; response?: { headers: Record<string, { value: string }> } };
type Handler = (event: CfEvent) => unknown;

/** Load a generated CloudFront Function's `handler` (the code is plain JS 2.0). */
const loadHandler = (code: string): Handler => new Function(`${code}\nreturn handler;`)() as Handler;
/** The inline code of the one CloudFront Function in a stack. */
const functionCode = (stack: Stack): string => {
  const fns = Object.values(Template.fromStack(stack).findResources('AWS::CloudFront::Function'));
  assert.equal(fns.length, 1);
  return String(fns[0]?.Properties.FunctionCode);
};

const plan = (extra: Partial<HostingPlan['routes']> = {}, hasServer = false): HostingPlan => ({
  origins: [{ id: 'blocks-s3', kind: 'static' }],
  routes: { entries: [{ pattern: '/*', kind: 'static' }], redirects: [], headers: [], ...extra },
  policies: { spaFallback: true, hasServer, skewEnabled: false },
  release: { buildId: 'r1' },
});
const newStack = () => new Stack(new App(), 'Rules', { env: { account: '111111111111', region: 'us-east-1' } });

describe('cf.redirects', () => {
  it('[] when the app has no redirects (spreadable)', () => {
    const stack = newStack();
    assert.deepEqual(cf.redirects(stack, []), []);
    Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Function', 0);
  });

  it('a viewer-request function: first match wins, a wildcard tail is spliced, no match passes the request', () => {
    const stack = newStack();
    const assoc = cf.redirects(stack, [
      { source: '/old', destination: '/new', statusCode: 301 },
      { source: '/blog/*', destination: '/posts/*', statusCode: 308 },
      { source: '/blog/a', destination: '/never', statusCode: 302 },
    ]);
    assert.equal(assoc.length, 1);
    assert.equal(assoc[0]?.eventType, FunctionEventType.VIEWER_REQUEST);
    const handler = loadHandler(functionCode(stack));
    const go = (uri: string) => handler({ request: { uri, headers: {} } }) as { statusCode?: number; headers?: { location: { value: string } }; uri?: string };
    assert.deepEqual([go('/old').statusCode, go('/old').headers?.location.value], [301, '/new']);
    assert.deepEqual([go('/blog/a').statusCode, go('/blog/a').headers?.location.value], [308, '/posts/a']);
    assert.equal(go('/blog/').headers?.location.value, '/posts/', 'an empty tail never leaks a literal *');
    assert.equal(go('/other').uri, '/other', 'no match: the request passes through');
  });

  it('a spliced root-relative target keeps one leading slash (no protocol-relative Location off-site)', () => {
    const stack = newStack();
    cf.redirects(stack, [{ source: '/old/*', destination: '/*', statusCode: 301 }]);
    const handler = loadHandler(functionCode(stack));
    const go = (uri: string) => (handler({ request: { uri, headers: {} } }) as { headers: { location: { value: string } } }).headers.location.value;
    assert.equal(go('/old//evil.example'), '/evil.example');
    assert.equal(go('/old/\\\\evil.example'), '/evil.example');
    assert.equal(go('/old/docs/a'), '/docs/a');
  });

  it('ships the same matcher and redirect loop as the built-in CloudFront door', () => {
    const stack = newStack();
    cf.redirects(stack, [{ source: '/a', destination: '/b', statusCode: 301 }]);
    const code = functionCode(stack);
    assert.ok(code.includes(CF_MATCH_HELPERS));
    // The same loop, plus the same-site guard on a spliced target.
    assert.ok(code.includes(redirectRowsJs('REDIRECTS', '  ', { sameSite: true })));
    assert.ok(generateKvsRouterRequestCode().includes(CF_MATCH_HELPERS));
    assert.ok(generateKvsRouterRequestCode().includes(redirectRowsJs('drows', '    ')));
  });

  it('fails synth when the rules exceed the 10 KB CloudFront Function limit', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      source: `/legacy/page-${i}`,
      destination: `/new/page-${i}`,
      statusCode: 301 as const,
    }));
    assert.throws(() => cf.redirects(newStack(), many), /over CloudFront's 10240-byte limit/);
  });
});

describe('cf.headers', () => {
  it('a viewer-response function applying every matching rule, as on the built-in door', () => {
    const stack = newStack();
    const assoc = cf.headers(stack, [
      { pattern: '/assets/*', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } },
      { pattern: '/*', headers: { 'X-Frame-Options': 'DENY' } },
    ]);
    assert.equal(assoc[0]?.eventType, FunctionEventType.VIEWER_RESPONSE);
    const code = functionCode(stack);
    assert.ok(code.includes(headerRowsJs('HEADERS', '  ')));
    assert.ok(generateKvsRouterResponseCode(0).includes(headerRowsJs('hrows', '    ')));
    const response = { headers: {} as Record<string, { value: string }> };
    loadHandler(code)({ request: { uri: '/assets/app.js', headers: {} }, response });
    assert.deepEqual(response.headers, {
      'cache-control': { value: 'public, max-age=31536000, immutable' },
      'x-frame-options': { value: 'DENY' },
    });
  });

  it('[] when the app has no header rules', () => {
    assert.deepEqual(cf.headers(newStack(), []), []);
  });
});

describe('cf.errorPages', () => {
  it('a static app: 404 + 500/502/503/504 served from the assets origin', () => {
    const stack = newStack();
    const input = buildDoorInput({
      plan: plan(),
      bucket: new Bucket(stack, 'A'),
      staticDir: '.',
      errorPages: { notFound: './404.html', serverError: './500.html' },
    });
    const pages = cf.errorPages(input.app.errorPages, input.origins);
    assert.deepEqual(
      pages.errorResponses.map((r) => [r.httpStatus, r.responsePagePath]),
      [
        [404, '/404.html'],
        [500, '/500.html'],
        [502, '/500.html'],
        [503, '/500.html'],
        [504, '/500.html'],
      ],
    );
    assert.deepEqual(Object.keys(pages.behaviors), ['/404.html', '/500.html']);
    assert.equal(pages.behaviors['/404.html']?.origin, cf.origin(input.origins.assets));
  });

  it('the same responses as the built-in door, at the asset origin root', () => {
    const pages = { notFound: '404.html', serverError: '500.html' };
    const builtIn = customErrorResponses(pages, { pathPrefix: '/builds/r1', hasCompute: true });
    const byo = customErrorResponses(pages, { pathPrefix: '', hasCompute: true });
    assert.deepEqual(
      byo.map((r) => r.httpStatus),
      [404, 500],
    );
    assert.deepEqual(
      builtIn.map((r) => r.responsePagePath),
      byo.map((r) => `/builds/r1${r.responsePagePath}`),
    );
  });

  it('empty when the app has no error pages', () => {
    const stack = newStack();
    const input = buildDoorInput({ plan: plan(), bucket: new Bucket(stack, 'A'), staticDir: '.' });
    assert.deepEqual(cf.errorPages(input.app.errorPages, input.origins), { errorResponses: [], behaviors: {} });
  });
});

describe('HostingConstruct — a BYO door and the app rules', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-rules-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(tmpDir, '404.html'), '<html>404</html>');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const manifest = (): DeployManifest => ({
    version: 1,
    buildId: 'rules1',
    compute: {},
    staticAssets: { directory: tmpDir, spaFallback: true },
    routes: [{ pattern: '/*', target: 'static' }],
    redirects: [{ source: '/old', destination: '/new', statusCode: 301 }],
    headers: [{ source: '/*', headers: { 'X-Frame-Options': 'DENY' } }],
  });

  const door = (wire: (scope: import('constructs').Construct, input: DoorInput) => Partial<import('aws-cdk-lib/aws-cloudfront').DistributionProps>) =>
    defineFrontDoor({
      service: 'rules',
      build(scope, input) {
        const extra = wire(scope, input);
        const dist = new Distribution(scope, 'Cdn', {
          defaultBehavior: { origin: cf.origin(input.origins.assets), ...extra.defaultBehavior },
          ...(extra.errorResponses ? { errorResponses: extra.errorResponses } : {}),
          additionalBehaviors: extra.additionalBehaviors,
        });
        return { url: `https://${dist.distributionDomainName}` };
      },
    });

  const synth = (d: ReturnType<typeof door>) => {
    const stack = newStack();
    new HostingConstruct(stack, 'Hosting', {
      manifest: manifest(),
      errorPages: { notFound: path.join(tmpDir, '404.html') },
      frontDoor: { kind: 'custom', door: d },
    });
    return stack;
  };
  const unwiredWarnings = (stack: Stack) =>
    Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('did not wire the app'));

  it('warns about the redirects, headers and error pages a door left unwired', () => {
    const warnings = unwiredWarnings(synth(door(() => ({}))));
    assert.equal(warnings.length, 1);
    const text = String(warnings[0]?.entry.data);
    for (const rule of ['app.redirects', 'app.headers', 'app.errorPages']) assert.ok(text.includes(rule), rule);
  });

  it('no warning when the helpers wire them', () => {
    const stack = synth(
      door((scope, { app, origins }) => {
        const pages = cf.errorPages(app.errorPages, origins);
        return {
          defaultBehavior: {
            origin: cf.origin(origins.assets),
            functionAssociations: [...cf.redirects(scope, app.redirects), ...cf.headers(scope, app.headers)],
          },
          errorResponses: pages.errorResponses,
          additionalBehaviors: pages.behaviors,
        };
      }),
    );
    assert.equal(unwiredWarnings(stack).length, 0);
    Template.fromStack(stack).resourceCountIs('AWS::CloudFront::Function', 2);
  });

  it('no warning when hand-wired rules are declared with cf.recordWired', () => {
    const stack = synth(
      door((_scope, { app }) => {
        cf.recordWired(app.redirects);
        cf.recordWired(app.headers);
        if (app.errorPages) cf.recordWired(app.errorPages);
        return {};
      }),
    );
    assert.equal(unwiredWarnings(stack).length, 0);
  });
});

describe('origin verification secret — only on the built-in CloudFront door', () => {
  let tmpDir: string;
  let bundleDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosting-verify-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html></html>');
    bundleDir = path.join(tmpDir, 'server');
    fs.mkdirSync(bundleDir);
    fs.writeFileSync(path.join(bundleDir, 'run.sh'), '#!/bin/sh\nnode server.js');
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const ssr = (): DeployManifest => ({
    version: 1,
    buildId: 'verify1',
    compute: {
      server: { type: 'http-server', bundle: bundleDir, entrypoint: 'run.sh', port: 3000, placement: 'regional', streaming: true },
    },
    staticAssets: { directory: tmpDir },
    routes: [{ pattern: '/*', target: 'server' }],
  });
  /** REST APIs whose resource policy denies requests without the `Referer` secret. */
  const refererGatedApis = (stack: Stack) =>
    Object.values(Template.fromStack(stack).findResources('AWS::ApiGateway::RestApi')).filter((r) =>
      JSON.stringify(r.Properties.Policy ?? {}).includes('aws:Referer'),
    );

  it('the CloudFront door gates its own SSR REST API with it', () => {
    const stack = newStack();
    new HostingConstruct(stack, 'Hosting', { manifest: ssr() });
    assert.equal(refererGatedApis(stack).length, 1);
  });

  it('a BYO door reaches the server by its IAM-auth Function URL: no secret-gated origin exists', () => {
    const stack = newStack();
    let seen: DoorInput | undefined;
    new HostingConstruct(stack, 'Hosting', {
      manifest: ssr(),
      frontDoor: {
        kind: 'custom',
        door: defineFrontDoor({
          service: 'byo-ssr',
          build(scope, input) {
            seen = input;
            const server = input.origins.server;
            assert.ok(server);
            const dist = new Distribution(scope, 'Cdn', {
              defaultBehavior: { origin: cf.origin(server) },
              additionalBehaviors: cf.behaviors(input.app.routes),
            });
            return { url: `https://${dist.distributionDomainName}` };
          },
        }),
        wiringCheck: false,
      },
    });
    assert.ok(seen?.origins.server);
    assert.equal(refererGatedApis(stack).length, 0, 'no REST API needs the Referer secret');
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  });
});
