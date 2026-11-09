// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral conformance across the built-in doors: one fixed table of
 * (plan, request) cases, each run through the request handling every built-in
 * door generates for that plan, asserting the same status, `Location`, app
 * header rules and served page on every door.
 *
 * Each door is fed the plan the way production feeds it: `HostingConstruct` is
 * synthesized for the plan behind that door (the stacked door's edge is built
 * from the construct's `doorInput`, as `@aws-blocks/core` `Hosting` does), and
 * the handlers are pulled out of the template and executed:
 *
 * - CloudFront: the KVS router's viewer-request / viewer-response functions,
 *   against the KVS entries the `RouteStoreKeys` custom resource writes, then
 *   S3 at the selected origin, then the distribution's custom error responses;
 * - stacked (CloudFront edge over the ALB router): the edge behavior's
 *   viewer-request / viewer-response functions, S3 at its origin, and its
 *   custom error responses (a static-only plan never reaches the router);
 * - ALB, API Gateway HTTP, API Gateway REST: the inline asset-proxy Lambda,
 *   with its environment, against an in-memory bucket, in each door's event
 *   envelope.
 *
 * CloudFront is modelled as documented: a viewer-response function is not
 * invoked when the origin answers 400 or higher, nor for a response the
 * viewer-request function generated; the viewer-response function sees the
 * request as the viewer-request function left it (the URI rewritten to the
 * build prefix, as observed on a deployed distribution); S3 (listable through
 * the origin access control) answers a missing key with 404.
 *
 * Out of scope: the door's routing layer in front of the handler (ALB listener
 * rules, API Gateway routes, CloudFront behaviors for non-static origins), SSR
 * and API origins, and the security-header policies (compared elsewhere).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import * as zlib from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { DeployManifest } from '../manifest/types.js';
import { cloudFrontEdgeDoor } from './cloudfront_edge_door.js';
import { buildFrontDoor } from './custom_door.js';
import { HostingConstruct, type HostingConstructProps } from './hosting_construct.js';

// ── The shared plans ────────────────────────────────────────────────────────

const BUILD_ID = 'conf1';
const PREFIX = `builds/${BUILD_ID}`;

/** The build's files (served from `builds/<buildId>/`), by key under the prefix. */
const FILES: Record<string, { body: string; contentType: string }> = {
  'index.html': { body: '<!doctype html><html><body>spa shell</body></html>', contentType: 'text/html' },
  'about/index.html': { body: '<!doctype html><html><body>about</body></html>', contentType: 'text/html' },
  'assets/app.js': { body: 'console.log("app")', contentType: 'text/javascript' },
  'robots.txt': { body: 'User-agent: *', contentType: 'text/plain' },
};

/** The app's not-found page: the user's (`errorPages.notFound`) or the framework's (`manifest.errorPages[404]`). */
const NOT_FOUND = { key: '404.html', body: '<!doctype html><html><body>not found page</body></html>' };

const REDIRECTS: NonNullable<DeployManifest['redirects']> = [
  { source: '/old', destination: '/new', statusCode: 308 },
  { source: '/legacy/*', destination: '/modern/*', statusCode: 308 },
  { source: '/go/*', destination: '/*', statusCode: 308 },
  { source: '/temp', destination: '/elsewhere', statusCode: 302 },
  { source: '/moved', destination: 'https://example.org/moved', statusCode: 301 },
  { source: '/keep', destination: '/kept', statusCode: 307 },
];

const HEADERS: NonNullable<DeployManifest['headers']> = [
  { source: '/assets/*', headers: { 'X-Rule': 'a' } },
  { source: '/assets/app.js', headers: { 'X-Exact': 'b' } },
];

/** The response headers a case compares (the app's header rules); `location` is compared on its own. */
const COMPARED_HEADERS = ['x-rule', 'x-exact'];

type PlanId = 'spa' | 'mpa' | 'basePath';

type PlanDef = {
  /** Single-page-app fallback. */
  spa: boolean;
  /** Where the not-found page comes from. */
  notFound: 'user' | 'framework';
  basePath?: string;
};

const PLANS: Record<PlanId, PlanDef> = {
  spa: { spa: true, notFound: 'user' },
  mpa: { spa: false, notFound: 'framework' },
  basePath: { spa: true, notFound: 'user', basePath: '/app' },
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'door-conformance-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** The manifest and the `HostingConstruct` props of a plan (its files written to a temp dir). */
const planInputs = (id: PlanId): { manifest: DeployManifest; props: Partial<HostingConstructProps> } => {
  const def = PLANS[id];
  const dir = path.join(tmpRoot, id);
  const staticDir = path.join(dir, 'static');
  const files = def.notFound === 'framework' ? { ...FILES, [NOT_FOUND.key]: NOT_FOUND } : FILES;
  for (const [key, file] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(staticDir, key)), { recursive: true });
    fs.writeFileSync(path.join(staticDir, key), file.body);
  }
  const userPage = path.join(dir, 'user-404.html');
  fs.writeFileSync(userPage, NOT_FOUND.body);
  const manifest: DeployManifest = {
    version: 1,
    buildId: BUILD_ID,
    compute: {},
    staticAssets: { directory: staticDir, spaFallback: def.spa },
    routes: [{ pattern: '/*', target: 'static' }],
    redirects: REDIRECTS,
    headers: HEADERS,
    ...(def.basePath ? { basePath: def.basePath } : {}),
    ...(def.notFound === 'framework' ? { errorPages: { 404: `/${NOT_FOUND.key}` } } : {}),
  };
  return { manifest, props: def.notFound === 'user' ? { errorPages: { notFound: userPage } } : {} };
};

/** The bucket the plan deploys: every file, and the not-found page, under the build prefix. */
const bucketObjects = (): Record<string, { body: string; contentType: string }> => {
  const objects: Record<string, { body: string; contentType: string }> = {};
  for (const [key, file] of Object.entries({ ...FILES, [NOT_FOUND.key]: { body: NOT_FOUND.body, contentType: 'text/html' } })) {
    objects[`${PREFIX}/${key}`] = file;
  }
  return objects;
};

/** The served body, as the name of the build file it is (`null` for anything else: a redirect, a plain error). */
const bodyName = (text: string | undefined): string | null => {
  if (text === undefined || text === '') return null;
  if (text === NOT_FOUND.body) return NOT_FOUND.key;
  for (const [key, file] of Object.entries(FILES)) if (file.body === text) return key;
  return null;
};

// ── The normalized row every door is compared on ───────────────────────────

type Row = {
  status: number;
  location?: string;
  /** The app header rules on the response (lower-case names, see {@link COMPARED_HEADERS}). */
  headers: Record<string, string>;
  /** Which build file the body is, or `null`. */
  body: string | null;
};

/** Normalize a response's headers (any case, plain or `{ value }`, single- or multi-value) into a row. */
const toRow = (status: number, rawHeaders: Record<string, unknown>, body: string | undefined): Row => {
  const headers: Record<string, string> = {};
  let location: string | undefined;
  for (const [name, raw] of Object.entries(rawHeaders)) {
    const first = Array.isArray(raw) ? raw[0] : raw;
    const value =
      typeof first === 'object' && first !== null && 'value' in first ? String((first as { value: unknown }).value) : String(first);
    const lower = name.toLowerCase();
    if (lower === 'location') location = value;
    else if (COMPARED_HEADERS.includes(lower)) headers[lower] = value;
  }
  return { status, ...(location !== undefined ? { location } : {}), headers, body: bodyName(body) };
};

// ── Template access ─────────────────────────────────────────────────────────

type CfnResource = { Type: string; Properties?: Record<string, unknown> };
type FnAssociation = { EventType: string; FunctionARN: { 'Fn::GetAtt': [string, string] } };
type CacheBehavior = { PathPattern?: string; TargetOriginId: string; FunctionAssociations?: FnAssociation[] };
type DistributionConfig = {
  DefaultCacheBehavior: CacheBehavior;
  CacheBehaviors?: CacheBehavior[];
  Origins: Array<{ Id: string; OriginPath?: string; S3OriginConfig?: unknown }>;
  CustomErrorResponses?: Array<{ ErrorCode: number; ResponseCode?: number; ResponsePagePath?: string }>;
};

const resources = (t: Template): Record<string, CfnResource> => t.toJSON().Resources as Record<string, CfnResource>;

const ofType = (t: Template, type: string): Array<[string, Record<string, unknown>]> =>
  Object.entries(resources(t))
    .filter(([, r]) => r.Type === type)
    .map(([id, r]): [string, Record<string, unknown>] => [id, r.Properties ?? {}]);

const functionCode = (t: Template, assoc: FnAssociation | undefined): string | undefined => {
  if (!assoc) return undefined;
  const props = resources(t)[assoc.FunctionARN['Fn::GetAtt'][0]]?.Properties;
  const code = props?.FunctionCode;
  if (typeof code !== 'string') throw new Error(`function ${assoc.FunctionARN['Fn::GetAtt'][0]} has no inline code`);
  return code;
};

/** The single distribution of a door. */
const distribution = (t: Template, idPart: string): DistributionConfig => {
  const dists = ofType(t, 'AWS::CloudFront::Distribution').filter(([id]) => id.includes(idPart));
  assert.equal(dists.length, 1, `one ${idPart} distribution`);
  return dists[0][1].DistributionConfig as DistributionConfig;
};

/** CloudFront path-pattern match (`*` any run, `?` one character). */
const behaviorMatches = (pattern: string, uri: string): boolean =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(uri);

/** The behavior CloudFront picks for a path: the first matching cache behavior, else the default. */
const behaviorFor = (config: DistributionConfig, uri: string): CacheBehavior =>
  (config.CacheBehaviors ?? []).find((b) => b.PathPattern !== undefined && behaviorMatches(b.PathPattern, uri)) ??
  config.DefaultCacheBehavior;

// ── CloudFront execution ────────────────────────────────────────────────────

type CfValue = { value: string };
type CfRequest = {
  uri: string;
  method: string;
  headers: Record<string, CfValue>;
  cookies: Record<string, CfValue>;
  querystring: Record<string, CfValue>;
};
type CfResponse = { statusCode: number; headers: Record<string, CfValue>; cookies: Record<string, CfValue> };
type CfHandler = (event: { request: CfRequest; response?: CfResponse }) => CfRequest | CfResponse | Promise<CfRequest | CfResponse>;

/** A CloudFront Function's handler, with a fake `cloudfront` module (KVS reads from `kvs`). */
const loadCfFunction = (
  code: string,
  kvs: Record<string, string>,
  selected: { origin: string | null },
): CfHandler => {
  const cf = {
    kvs: () => ({
      get: async (key: string) => {
        if (!(key in kvs)) throw new Error('NoSuchKey');
        return kvs[key];
      },
    }),
    selectRequestOriginById: (id: string) => {
      selected.origin = id;
    },
  };
  const body = code.replace(/^import cf from 'cloudfront';\n?/, '');
  // The source is the repo's own generated function code, read from the synthesized template.
  return new Function('cf', `${body}\nreturn handler;`)(cf) as CfHandler;
};

const isResponse = (out: CfRequest | CfResponse): out is CfResponse => 'statusCode' in out;

/**
 * One request through a CloudFront distribution serving static files from S3:
 * the behavior's viewer-request function, S3 at the (selected) origin, the
 * custom error responses, then the viewer-response function on a success.
 */
const runCloudFront = async (
  t: Template,
  config: DistributionConfig,
  kvs: Record<string, string>,
  uri: string,
): Promise<Row> => {
  const behavior = behaviorFor(config, uri);
  const assoc = (type: string) => behavior.FunctionAssociations?.find((a) => a.EventType === type);
  const requestCode = functionCode(t, assoc('viewer-request'));
  const responseCode = functionCode(t, assoc('viewer-response'));
  const viewerRequest = (): CfRequest => ({
    uri,
    method: 'GET',
    headers: { host: { value: 'app.example.com' } },
    cookies: {},
    querystring: {},
  });
  const selected: { origin: string | null } = { origin: null };
  let request = viewerRequest();
  if (requestCode) {
    const out = await loadCfFunction(requestCode, kvs, selected)({ request: viewerRequest() });
    // A generated response goes straight back to the viewer.
    if (isResponse(out)) return toRow(out.statusCode, out.headers, undefined);
    request = out;
  }
  const originId = selected.origin ?? behavior.TargetOriginId;
  const origin = config.Origins.find((o) => o.Id === originId);
  if (!origin?.S3OriginConfig) throw new Error(`${uri} reached origin ${originId}, not S3 (not simulated)`);
  const objects = bucketObjects();
  const key = `${origin.OriginPath ?? ''}${request.uri}`.replace(/^\/+/, '');
  const hit = objects[key];
  if (!hit) {
    // S3 answers 404 (listable); the distribution's error response for it, if any, serves its page.
    const mapped = (config.CustomErrorResponses ?? []).find((r) => r.ErrorCode === 404 && r.ResponsePagePath);
    if (!mapped?.ResponsePagePath) return toRow(404, {}, undefined);
    const page = objects[mapped.ResponsePagePath.replace(/^\/+/, '')];
    return toRow(mapped.ResponseCode ?? 404, {}, page?.body);
  }
  let response: CfResponse = { statusCode: 200, headers: { 'content-type': { value: hit.contentType } }, cookies: {} };
  if (responseCode) {
    // The viewer-response function sees the request as the viewer-request function left it.
    const out = await loadCfFunction(responseCode, kvs, selected)({ request, response });
    if (isResponse(out)) response = out;
  }
  return toRow(response.statusCode, response.headers, hit.body);
};

// ── Asset-proxy execution ───────────────────────────────────────────────────

type ProxyResponse = {
  statusCode: number;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  body: string;
  isBase64Encoded: boolean;
};
type ProxyHandler = (event: Record<string, unknown>) => Promise<ProxyResponse>;

/** An inline asset-proxy handler with `@aws-sdk/client-s3` replaced by the in-memory bucket. */
const loadProxy = (code: string, env: Record<string, string>): ProxyHandler => {
  const objects = bucketObjects();
  type GetInput = { Bucket: string; Key: string };
  class GetObjectCommand {
    constructor(readonly input: GetInput) {}
  }
  class S3Client {
    async send(cmd: GetObjectCommand) {
      const obj = objects[cmd.input.Key];
      if (!obj) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      return { Body: [Buffer.from(obj.body)], ContentType: obj.contentType };
    }
  }
  const mod: { exports: { handler?: ProxyHandler } } = { exports: {} };
  const fakeRequire = (id: string) => {
    if (id === '@aws-sdk/client-s3') return { S3Client, GetObjectCommand };
    if (id === 'node:zlib') return zlib;
    throw new Error(`unexpected require: ${id}`);
  };
  new Function('require', 'exports', 'module', 'process', code)(fakeRequire, mod.exports, mod, { env });
  const handler = mod.exports.handler;
  if (!handler) throw new Error('generated code exports no handler');
  return handler;
};

/** The asset-proxy Lambda of a door's template: its inline code and its environment. */
const assetProxy = (t: Template): ProxyHandler => {
  const fns = ofType(t, 'AWS::Lambda::Function').filter(([id, p]) => {
    const code = p.Code as { ZipFile?: unknown } | undefined;
    return id.includes('AssetProxy') && typeof code?.ZipFile === 'string';
  });
  assert.equal(fns.length, 1, 'one asset-proxy Lambda');
  const props = fns[0][1];
  const vars = ((props.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {}) as Record<
    string,
    unknown
  >;
  const env: Record<string, string> = { ASSET_BUCKET: 'bucket' };
  if (typeof vars.ASSET_KEY_PREFIX === 'string') env.ASSET_KEY_PREFIX = vars.ASSET_KEY_PREFIX;
  return loadProxy((props.Code as { ZipFile: string }).ZipFile, env);
};

const runProxy = async (handler: ProxyHandler, event: Record<string, unknown>): Promise<Row> => {
  const res = await handler(event);
  const text = res.isBase64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
  return toRow(res.statusCode, { ...(res.multiValueHeaders ?? {}), ...(res.headers ?? {}) }, text);
};

// ── The doors ───────────────────────────────────────────────────────────────

type DoorId = 'cloudfront' | 'stacked' | 'alb' | 'apigw-http' | 'apigw-rest';
const DOORS: DoorId[] = ['cloudfront', 'stacked', 'alb', 'apigw-http', 'apigw-rest'];

const DOMAIN = { domainName: 'app.example.com', hostedZoneId: 'Z1234567890ABC', hostedZone: 'example.com' };

type DoorRunner = (uri: string) => Promise<Row>;

const synth = (plan: PlanId, door: DoorId): Template => {
  const { manifest, props } = planInputs(plan);
  const frontDoor: HostingConstructProps['frontDoor'] =
    door === 'cloudfront'
      ? undefined
      : door === 'stacked'
        ? { kind: 'stackedRouter' }
        : door === 'alb'
          ? { kind: 'alb' }
          : { kind: 'apiGateway', api: door === 'apigw-rest' ? 'rest' : 'http' };
  const stack = new Stack(new App(), `Conf-${plan}-${door}`, { env: { account: '111111111111', region: 'us-west-2' } });
  const hosting = new HostingConstruct(stack, 'Hosting', {
    manifest,
    frontDoor,
    ...props,
    ...(door === 'apigw-rest' ? { domain: DOMAIN } : {}),
  });
  if (door === 'stacked') {
    // The edge, built from the construct's door input with the ALB router upstream (as `Hosting` does).
    buildFrontDoor(
      stack,
      cloudFrontEdgeDoor,
      {
        ...hosting.doorInput,
        upstream: { service: hosting.frontDoor.service, url: hosting.frontDoor.url, originHandle: hosting.frontDoor.originHandle },
      },
      { wiringCheck: false },
    );
  }
  return Template.fromStack(stack);
};

/** The KVS entries the CloudFront door writes (`RouteStoreKeys`). */
const kvsEntries = (t: Template): Record<string, string> => {
  const keys = Object.entries(resources(t)).filter(([id, r]) => id.includes('RouteStoreKeys') && r.Properties?.Entries);
  assert.equal(keys.length, 1, 'one RouteStoreKeys resource');
  const entries = keys[0][1].Properties?.Entries;
  return typeof entries === 'string' ? (JSON.parse(entries) as Record<string, string>) : (entries as Record<string, string>);
};

const runners = new Map<string, DoorRunner>();

const runnerFor = (plan: PlanId, door: DoorId): DoorRunner => {
  const id = `${plan}/${door}`;
  const cached = runners.get(id);
  if (cached) return cached;
  const t = synth(plan, door);
  let runner: DoorRunner;
  switch (door) {
    case 'cloudfront': {
      const config = distribution(t, 'HostingDistribution');
      const kvs = kvsEntries(t);
      runner = (uri) => runCloudFront(t, config, kvs, uri);
      break;
    }
    case 'stacked': {
      const config = distribution(t, 'CfOverAlb');
      runner = (uri) => runCloudFront(t, config, {}, uri);
      break;
    }
    case 'alb': {
      const handler = assetProxy(t);
      runner = (uri) => runProxy(handler, { path: uri, httpMethod: 'GET', headers: { host: 'app.example.com' } });
      break;
    }
    case 'apigw-http': {
      const handler = assetProxy(t);
      runner = (uri) =>
        runProxy(handler, {
          version: '2.0',
          rawPath: uri,
          headers: { host: 'app.example.com' },
          requestContext: { http: { method: 'GET', path: uri } },
        });
      break;
    }
    case 'apigw-rest': {
      const handler = assetProxy(t);
      // Payload 1.0: the header names as the client sent them.
      runner = (uri) => runProxy(handler, { path: uri, httpMethod: 'GET', headers: { Host: 'app.example.com' } });
      break;
    }
  }
  runners.set(id, runner);
  return runner;
};

// ── The table ───────────────────────────────────────────────────────────────

type Case = {
  name: string;
  plan: PlanId;
  path: string;
  expect: Row;
  /** A known divergence: `'<door>: <what differs>'`. */
};

const redirect = (status: number, location: string): Row => ({ status, location, headers: {}, body: null });
const served = (body: string, headers: Record<string, string> = {}): Row => ({ status: 200, headers, body });
const notFoundPage: Row = { status: 404, headers: {}, body: NOT_FOUND.key };

const CASES: Case[] = [
  // 1. exact redirect
  { name: 'exact redirect /old → /new (308)', plan: 'spa', path: '/old', expect: redirect(308, '/new') },
  // 2. wildcard splice
  { name: 'wildcard splice /legacy/a/b → /modern/a/b', plan: 'spa', path: '/legacy/a/b', expect: redirect(308, '/modern/a/b') },
  { name: 'wildcard splice with an empty tail /legacy/ → /modern/', plan: 'spa', path: '/legacy/', expect: redirect(308, '/modern/') },
  // 3. root splice: never a protocol-relative Location
  { name: 'root splice /go//evil.example keeps one leading slash', plan: 'spa', path: '/go//evil.example', expect: redirect(308, '/evil.example') },
  { name: 'root splice /go/\\evil.example keeps one leading slash', plan: 'spa', path: '/go/\\evil.example', expect: redirect(308, '/evil.example') },
  { name: 'root splice /go/x → /x', plan: 'spa', path: '/go/x', expect: redirect(308, '/x') },
  // 4. status preserved
  { name: '302 status preserved', plan: 'spa', path: '/temp', expect: redirect(302, '/elsewhere') },
  { name: '307 status preserved', plan: 'spa', path: '/keep', expect: redirect(307, '/kept') },
  { name: '301 to an absolute URL', plan: 'spa', path: '/moved', expect: redirect(301, 'https://example.org/moved') },
  // 5. header rules on a 200, not on a 404
  {
    name: 'header rules apply to a served static asset (every matching rule)',
    plan: 'spa',
    path: '/assets/app.js',
    expect: served('assets/app.js', { 'x-rule': 'a', 'x-exact': 'b' }),
  },
  { name: 'header rule not applied to a 404 under its pattern', plan: 'spa', path: '/assets/missing.js', expect: notFoundPage },
  { name: 'no header rule outside its pattern', plan: 'spa', path: '/robots.txt', expect: served('robots.txt') },
  // 6. a missing file with an extension → 404 with the app's page
  { name: 'missing file with an extension → 404 page (no SPA fallback)', plan: 'spa', path: '/missing.css', expect: notFoundPage },
  { name: 'missing dotfile → 404 page', plan: 'spa', path: '/.env', expect: notFoundPage },
  { name: 'missing /.well-known/ path → 404 page (no SPA fallback)', plan: 'spa', path: '/.well-known/x', expect: notFoundPage },
  // 7. SPA fallback
  { name: 'SPA: an extensionless deep link serves index.html', plan: 'spa', path: '/dashboard/settings', expect: served('index.html') },
  { name: 'SPA: / serves index.html', plan: 'spa', path: '/', expect: served('index.html') },
  // 8. no redirect matches → passes through
  { name: 'near-miss of an exact redirect passes through (/old/)', plan: 'spa', path: '/old/', expect: served('index.html') },
  { name: 'near-miss of a wildcard source passes through (/legacy)', plan: 'spa', path: '/legacy', expect: served('index.html') },
  { name: 'false prefix of a wildcard source passes through (/legacyx/y)', plan: 'spa', path: '/legacyx/y', expect: served('index.html') },

  // Multi-page site, the framework's own 404 page (`manifest.errorPages`).
  { name: 'MPA: directory index /about → about/index.html', plan: 'mpa', path: '/about', expect: served('about/index.html') },
  { name: 'MPA: directory index /about/ → about/index.html', plan: 'mpa', path: '/about/', expect: served('about/index.html') },
  { name: 'MPA: / → index.html', plan: 'mpa', path: '/', expect: served('index.html') },
  {
    name: "MPA: an unknown extensionless path → 404 with the framework's page",
    plan: 'mpa',
    path: '/nope',
    expect: notFoundPage,
  },
  {
    name: "MPA: a missing asset → 404 with the framework's page",
    plan: 'mpa',
    path: '/assets/missing.js',
    expect: notFoundPage,
  },
  { name: 'MPA: redirect /old → /new', plan: 'mpa', path: '/old', expect: redirect(308, '/new') },
  { name: 'MPA: header rules on a served asset', plan: 'mpa', path: '/assets/app.js', expect: served('assets/app.js', { 'x-rule': 'a', 'x-exact': 'b' }) },

  // basePath `/app`: rules basePath-resolved, the prefix stripped before the lookup.
  { name: 'basePath: exact redirect /app/old → /app/new', plan: 'basePath', path: '/app/old', expect: redirect(308, '/app/new') },
  {
    name: 'basePath: wildcard splice /app/legacy/a → /app/modern/a',
    plan: 'basePath',
    path: '/app/legacy/a',
    expect: redirect(308, '/app/modern/a'),
  },
  {
    name: 'basePath: header rules on a served asset',
    plan: 'basePath',
    path: '/app/assets/app.js',
    expect: served('assets/app.js', { 'x-rule': 'a', 'x-exact': 'b' }),
  },
  { name: 'basePath: a missing asset → 404 page', plan: 'basePath', path: '/app/assets/missing.js', expect: notFoundPage },
  { name: 'basePath: SPA deep link serves index.html', plan: 'basePath', path: '/app/dashboard', expect: served('index.html') },
  { name: 'basePath: the bare basePath serves index.html', plan: 'basePath', path: '/app', expect: served('index.html') },
];


/** Run a case through every door and assert one expected row on each. */
const runCase = async (c: Case): Promise<void> => {
  const actual: Record<string, Row> = {};
  const errors: string[] = [];
  for (const door of DOORS) {
    try {
      actual[door] = await runnerFor(c.plan, door)(c.path);
    } catch (err) {
      errors.push(`${door}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  assert.deepEqual(errors, [], `doors failed to answer ${c.path}`);
  const diverged = DOORS.filter((d) => !isDeepStrictEqual(actual[d], c.expect));
  const expected = Object.fromEntries(DOORS.map((d) => [d, c.expect]));
  assert.deepEqual(actual, expected, `${c.plan} ${c.path}: diverged on ${diverged.join(', ')}`);
};

describe('built-in doors — behavioral conformance (same status, Location and headers on every door)', () => {
  for (const c of CASES) {
    it(`${c.plan}: ${c.name} [${c.path}]`, () => runCase(c));
  }

  it('covers every built-in door and plan', () => {
    for (const plan of Object.keys(PLANS) as PlanId[]) {
      for (const door of DOORS) assert.ok(runnerFor(plan, door), `${plan}/${door}`);
    }
  });
});
