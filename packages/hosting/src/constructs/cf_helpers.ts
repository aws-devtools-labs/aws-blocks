// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `cf.*` — CloudFront helpers for a free-form front door, and the wiring record
 * behind the one check AWS Blocks runs on a bring-your-own door.
 *
 * The helpers do two things:
 *   1. turn an origin from the {@link DoorInput} into a CloudFront origin and
 *      behavior (`cf.origin`, `cf.behaviors`, `cf.apiBehaviors`), wire the app's
 *      redirects, per-pattern headers and error pages the way the built-in
 *      CloudFront door does (`cf.redirects`, `cf.headers`, `cf.errorPages`), and
 *      declare a post-upload invalidation (`cf.invalidate`);
 *   2. RECORD what they wired. After `build` returns, AWS Blocks reads that
 *      record to confirm the static assets are reachable and, when the app has
 *      an API, that the API paths really reach the API (see `custom_door.ts`).
 *
 * The record is keyed on the origin objects of one door's input, so it needs
 * no global state and two doors in one synth stay independent.
 *
 * Known limit: a door that wires correctly with raw CDK (its own `S3BucketOrigin`,
 * its own `/aws-blocks/*` behavior) is invisible to the record and would fail the
 * check. Such a door either calls {@link CloudFrontHelpers.recordWired} for what
 * it wired by hand, or opts out with `frontDoor: { kind: 'custom', door, wiringCheck: false }`.
 */
import {
  AccessLevel,
  AllowedMethods,
  type BehaviorOptions,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  type ErrorResponse,
  type FunctionAssociation,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  Function as CloudFrontFunction,
  type ICachePolicy,
  type IDistribution,
  type IOrigin,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionUrlOrigin, HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { BucketDeployment } from 'aws-cdk-lib/aws-s3-deployment';
import { Duration, Stack } from 'aws-cdk-lib';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct, type IConstruct } from 'constructs';
import { HostingError } from '../hosting_error.js';
import { customErrorResponses } from './error_responses.js';
import type {
  ApiOrigin,
  AssetsOrigin,
  DoorApp,
  DoorHeaderRule,
  DoorInput,
  DoorOrigin,
  DoorOrigins,
  DoorRedirect,
  DoorRoute,
} from './front_door.js';
import { CF_MATCH_HELPERS, headerRowsJs, redirectRowsJs } from './kvs_router.js';

// ── Wiring record ───────────────────────────────────────────────────────────

/** What a door was observed to wire, via the `cf.*` helpers or `cf.recordWired`. */
export type WiringRecord = {
  /** Origin kinds a helper produced a CloudFront origin for (or that were declared wired). */
  readonly origins: Set<'assets' | 'server' | 'image' | 'api'>;
  /** API path patterns that were wired to the API. */
  readonly apiPaths: Set<string>;
  /** The app rules (`app.redirects`, `app.headers`, `app.errorPages`) that were wired. */
  readonly rules: Set<WiredRule>;
  /** The path patterns `cf.behaviors` and `cf.apiBehaviors` returned behaviors for (against the per-distribution quota). */
  readonly behaviors: Set<string>;
};

/** An app rule a door can wire: its redirects, per-pattern headers, or error pages. */
export type WiredRule = 'redirects' | 'headers' | 'errorPages';

/** An app rule set from the input, as handed to `cf.recordWired`. */
type AppRules = readonly DoorRedirect[] | readonly DoorHeaderRule[] | NonNullable<DoorApp['errorPages']>;

/** Which rule each app-rule object of an input is, so a helper called with it records the right one. */
const ruleOf = new WeakMap<object, WiredRule>();

const recordsByOrigin = new WeakMap<object, WiringRecord>();

/**
 * Start a wiring record for one door's input: every origin object in `input`
 * is linked to the same record, so a helper called with any of them records
 * into it.
 *
 * @internal Framework-only (`HostingConstruct`, the conformance kit).
 */
export function startWiringRecord(input: DoorInput): WiringRecord {
  const record: WiringRecord = { origins: new Set(), apiPaths: new Set(), rules: new Set(), behaviors: new Set() };
  const { assets, server, image, api } = input.origins;
  for (const origin of [assets, server, image, api]) {
    if (origin) recordsByOrigin.set(origin, record);
  }
  const rules: Array<[object | undefined, WiredRule]> = [
    [input.app.redirects, 'redirects'],
    [input.app.headers, 'headers'],
    [input.app.errorPages, 'errorPages'],
  ];
  for (const [rule, name] of rules) {
    if (!rule) continue;
    recordsByOrigin.set(rule, record);
    ruleOf.set(rule, name);
  }
  return record;
}

const recordOf = (origin: object): WiringRecord | undefined => recordsByOrigin.get(origin);

const markRule = (rules: object): void => {
  const rule = ruleOf.get(rules);
  if (rule) recordOf(rules)?.rules.add(rule);
};

/** CloudFront's limit on a function's code size (10 KB). */
const MAX_FUNCTION_CODE_BYTES = 10_240;

/**
 * A uniquely named CloudFront Function (JS 2.0) under `scope`, failing synth when its code is over the limit.
 *
 * @internal Framework-only (the `cf.*` helpers, the stacked door's edge).
 */
export const inlineFunction = (scope: Construct, baseId: string, helper: string, code: string): CloudFrontFunction => {
  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > MAX_FUNCTION_CODE_BYTES) {
    throw new HostingError('InvalidPropsError', {
      message: `cf.${helper}: the rules make a ${bytes}-byte CloudFront Function, over CloudFront's ${MAX_FUNCTION_CODE_BYTES}-byte limit.`,
      resolution:
        'Consolidate the rules into wildcard patterns, or serve them from a CloudFront KeyValueStore ' +
        '(as the built-in CloudFront door does).',
    });
  }
  let id = baseId;
  for (let n = 2; scope.node.tryFindChild(id); n++) id = `${baseId}${n}`;
  return new CloudFrontFunction(scope, id, { code: FunctionCode.fromInline(code), runtime: FunctionRuntime.JS_2_0 });
};

/** Build id for a set of uploads handed to `onUpload` (so `cf.invalidate` can key its caller reference). */
const buildIdByUploads = new WeakMap<object, string>();

/**
 * Link the `uploads` array handed to `onUpload` to its build id.
 *
 * @internal Framework-only (`HostingConstruct`).
 */
export function registerUploads(uploads: readonly BucketDeployment[], buildId: string): void {
  buildIdByUploads.set(uploads, buildId);
}

// ── Behavior settings ───────────────────────────────────────────────────────

/** Static assets: cache at the edge, read-only methods, compressed. */
const ASSET_BEHAVIOR = {
  allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
  cachePolicy: CachePolicy.CACHING_OPTIMIZED,
  viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  compress: true,
};

/**
 * Compute (server rendering, image optimization) and the API: no edge cache,
 * every method, and every viewer header except `Host` (a Function URL or API
 * Gateway rejects a forwarded `Host` that isn't its own).
 */
const DYNAMIC_BEHAVIOR = {
  allowedMethods: AllowedMethods.ALLOW_ALL,
  cachePolicy: CachePolicy.CACHING_DISABLED,
  originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
  viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
};

const originCache = new WeakMap<object, IOrigin>();

/** The catch-all patterns — the distribution's default behavior serves these. */
const CATCH_ALL = new Set(['*', '/*']);

// ── The helpers ─────────────────────────────────────────────────────────────

/** The `cf.*` helper set. See the module doc. */
export interface CloudFrontHelpers {
  /**
   * A CloudFront origin for an origin from the input — the assets bucket (via
   * Origin Access Control, at the build prefix), a compute Function URL (via
   * OAC), or the API (an HTTPS origin at its stage path). Memoized per origin,
   * so every behavior shares one CloudFront origin. Records the origin as wired.
   *
   * @param origin one of the objects in `input.origins` (or a route's `origin`).
   * @returns the CloudFront origin.
   */
  origin(origin: DoorOrigin | ApiOrigin): IOrigin;
  /**
   * One CloudFront behavior per route (most-specific first), each pointing at
   * its route's origin, with safe defaults per origin kind: assets cached;
   * image optimization cached on the origin's `Cache-Control` (the query
   * string and `Accept` in the key, no cookies — one cache policy per stack);
   * server rendering uncached. The catch-all route (`/*`) is skipped — that is
   * the distribution's `defaultBehavior`. Records each origin as wired. A
   * distribution allows 25 behaviors by default (24 besides the default); the
   * wiring check warns past that (`@aws-blocks/hosting:FrontDoorBehaviorLimit`).
   *
   * @param routes the app's routes (`input.app.routes`).
   * @returns `additionalBehaviors` entries, keyed by path pattern.
   */
  behaviors(routes: readonly DoorRoute[]): Record<string, BehaviorOptions>;
  /**
   * One uncached, all-methods behavior per API path (`/aws-blocks/*` and every
   * raw route) → the API origin. Records the paths as wired. Returns `{}` when
   * the app has no API, so it can be spread unconditionally.
   *
   * @param api the API origin (`input.origins.api`), or `undefined`.
   * @returns `additionalBehaviors` entries, keyed by path pattern.
   */
  apiBehaviors(api: ApiOrigin | undefined): Record<string, BehaviorOptions>;
  /**
   * The app's redirects (`app.redirects`, first match wins), as a viewer-request
   * CloudFront Function association — the same matching and wildcard splice as
   * the built-in CloudFront door. Attach it to every behavior a redirect source
   * can reach (usually `defaultBehavior`). Records the redirects as wired.
   * Returns `[]` when the app has none, so it can be spread unconditionally.
   * A behavior takes ONE viewer-request function.
   *
   * @param scope the construct scope to create the function under.
   * @param redirects the app's redirects (`input.app.redirects`).
   * @returns `functionAssociations` entries.
   * @throws HostingError('InvalidPropsError') when the rules exceed CloudFront's 10 KB function limit.
   *
   * @example
   * defaultBehavior: { origin, functionAssociations: [...cf.redirects(scope, app.redirects), ...cf.headers(scope, app.headers)] }
   */
  redirects(scope: Construct, redirects: readonly DoorRedirect[]): FunctionAssociation[];
  /**
   * The app's per-pattern response headers (`app.headers`), as a
   * viewer-response CloudFront Function association — every matching rule is
   * applied, as on the built-in CloudFront door. Records the headers as wired.
   * Returns `[]` when the app has none. A behavior takes ONE viewer-response
   * function.
   *
   * @param scope the construct scope to create the function under.
   * @param headers the app's header rules (`input.app.headers`).
   * @returns `functionAssociations` entries.
   * @throws HostingError('InvalidPropsError') when the rules exceed CloudFront's 10 KB function limit.
   */
  headers(scope: Construct, headers: readonly DoorHeaderRule[]): FunctionAssociation[];
  /**
   * The app's custom error pages (`app.errorPages`): the distribution's
   * `errorResponses` (404 → `404.html`; 500 → `500.html`, plus 502/503/504 for
   * an app without a server — as on the built-in CloudFront door), and the
   * behaviors that serve the pages from the static assets. Records the error
   * pages (and the assets origin) as wired. Empty when the app has none.
   *
   * @param errorPages the app's error pages (`input.app.errorPages`).
   * @param origins the input's origins (the pages are served from `origins.assets`).
   * @returns `errorResponses` for the Distribution, and `behaviors` to spread into `additionalBehaviors`.
   *
   * @example
   * const pages = cf.errorPages(app.errorPages, origins);
   * new Distribution(scope, 'Cdn', { …, additionalBehaviors: { ...pages.behaviors }, errorResponses: pages.errorResponses });
   */
  errorPages(
    errorPages: DoorApp['errorPages'],
    origins: DoorOrigins,
  ): { errorResponses: ErrorResponse[]; behaviors: Record<string, BehaviorOptions> };
  /**
   * Declare a CloudFront invalidation that runs AFTER the given uploads. Meant
   * for `onUpload`: `onUpload: ({ uploads }) => cf.invalidate(dist, { after: uploads })`.
   * The caller reference is keyed on the build id, so an unchanged build is a
   * no-op and a new build issues a fresh invalidation; a second invalidation
   * of the same distribution in one build gets its own. The
   * `cloudfront:CreateInvalidation` grant is scoped to this distribution.
   *
   * @param distribution the distribution to invalidate (a construct in this app).
   * @param options.after the uploads the invalidation must wait for.
   * @param options.paths paths to invalidate. @default ['/*']
   * @param options.buildId the build id; read from `onUpload`'s `uploads` when omitted.
   * @returns the custom resource that issues the invalidation.
   * @throws HostingError('InvalidPropsError') when the build id can't be determined,
   *   or `distribution` is not a construct.
   */
  invalidate(
    distribution: IDistribution,
    options: { after: readonly BucketDeployment[]; paths?: readonly string[]; buildId?: string },
  ): AwsCustomResource;
  /**
   * Declare something the door wired WITHOUT the helpers (raw CDK), so the
   * wiring check sees it. For the API, pass the paths that were wired, or omit
   * `paths` to declare every `api.paths` entry wired. The app's rules
   * (`app.redirects`, `app.headers`, `app.errorPages`) are declared the same way.
   *
   * @param origin the origin (or app rule set) from the input that the door wired by hand.
   * @param paths for the API origin only: the path patterns that reach it.
   */
  recordWired(origin: DoorOrigin | ApiOrigin | AppRules, paths?: readonly string[]): void;
}

const markWired = (origin: DoorOrigin | ApiOrigin): void => {
  recordOf(origin)?.origins.add(origin.kind);
};

/**
 * The cache policy of image-optimization behaviors, one per stack: the
 * origin's `Cache-Control` honored (as on the built-in CloudFront door), the
 * query string (the image parameters) and `Accept` (the format) in the key,
 * no cookies.
 */
const imageCachePolicy = (fn: IConstruct): ICachePolicy => {
  const stack = Stack.of(fn);
  const existing = stack.node.tryFindChild(IMAGE_CACHE_POLICY_ID);
  if (existing instanceof CachePolicy) return existing;
  return new CachePolicy(stack, IMAGE_CACHE_POLICY_ID, {
    comment: 'Image optimization: honor origin Cache-Control; key on the query string and Accept',
    minTtl: Duration.seconds(0),
    defaultTtl: Duration.seconds(0),
    maxTtl: Duration.days(365),
    cookieBehavior: CacheCookieBehavior.none(),
    headerBehavior: CacheHeaderBehavior.allowList('accept'),
    queryStringBehavior: CacheQueryStringBehavior.all(),
    enableAcceptEncodingGzip: true,
    enableAcceptEncodingBrotli: true,
  });
};
const IMAGE_CACHE_POLICY_ID = 'BlocksImageCachePolicy';

const behaviorFor = (origin: DoorOrigin): BehaviorOptions => {
  if (origin.kind === 'assets') return { origin: cf.origin(origin), ...ASSET_BEHAVIOR };
  if (origin.kind === 'image') {
    return {
      origin: cf.origin(origin),
      ...DYNAMIC_BEHAVIOR,
      allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachePolicy: imageCachePolicy(origin.fn),
    };
  }
  return { origin: cf.origin(origin), ...DYNAMIC_BEHAVIOR };
};

/**
 * `value` without leading or trailing `/`. A linear scan rather than a
 * `^\/+|\/+$` regex, which backtracks quadratically on long runs of `/`.
 *
 * @internal Exported for tests.
 */
export const trimSlashes = (value: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) start++;
  while (end > start && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(start, end);
};

/**
 * The CloudFront origin for the assets bucket: Origin Access Control, at the
 * build prefix. `listable` also grants the distribution `s3:ListBucket`, so a
 * missing file is a 404 rather than S3's 403; `bucketRoot` puts the origin at
 * the bucket root, for a door whose viewer-request function writes the build
 * prefix into the URI (so the build id is in the edge cache key). The
 * stacked door's edge uses both.
 *
 * @internal Framework-only (`cf.origin`, the stacked door's edge).
 */
export const assetsS3Origin = (
  origin: AssetsOrigin,
  opts: { listable?: boolean; bucketRoot?: boolean } = {},
): IOrigin =>
  S3BucketOrigin.withOriginAccessControl(origin.bucket, {
    ...(opts.bucketRoot ? {} : { originPath: `/${trimSlashes(origin.prefix)}` }),
    ...(opts.listable ? { originAccessLevels: [AccessLevel.READ, AccessLevel.LIST] } : {}),
  });

/**
 * The behavior settings for static assets (`cf.behaviors` for an assets route).
 *
 * @internal Framework-only.
 */
export const ASSET_BEHAVIOR_OPTIONS: Omit<BehaviorOptions, 'origin'> = ASSET_BEHAVIOR;

const buildOrigin = (origin: DoorOrigin | ApiOrigin): IOrigin => {
  switch (origin.kind) {
    case 'assets':
      return assetsS3Origin(origin);
    case 'server':
    case 'image':
      return FunctionUrlOrigin.withOriginAccessControl(origin.url);
    case 'api':
      return new HttpOrigin(origin.host, { originPath: origin.stagePath });
  }
};

/** CloudFront helpers for a free-form front door. See {@link CloudFrontHelpers}. */
export const cf: CloudFrontHelpers = {
  origin(origin) {
    markWired(origin);
    const cached = originCache.get(origin);
    if (cached) return cached;
    const built = buildOrigin(origin);
    originCache.set(origin, built);
    return built;
  },

  behaviors(routes) {
    const behaviors: Record<string, BehaviorOptions> = {};
    for (const route of routes) {
      if (CATCH_ALL.has(route.pattern) || behaviors[route.pattern]) continue;
      behaviors[route.pattern] = behaviorFor(route.origin);
      const record = recordOf(route.origin);
      if (record) record.behaviors.add(route.pattern);
    }
    return behaviors;
  },

  apiBehaviors(api) {
    if (!api) return {};
    const origin = cf.origin(api);
    const behaviors: Record<string, BehaviorOptions> = {};
    for (const path of api.paths) {
      behaviors[path] = { origin, ...DYNAMIC_BEHAVIOR };
      recordOf(api)?.apiPaths.add(path);
      recordOf(api)?.behaviors.add(path);
    }
    return behaviors;
  },

  redirects(scope, redirects) {
    markRule(redirects);
    if (redirects.length === 0) return [];
    const rows = JSON.stringify(redirects.map((r) => [r.source, r.destination, r.statusCode]));
    const code = `${CF_MATCH_HELPERS}
var REDIRECTS = ${rows};
function handler(event) {
  var request = event.request;
  var uri = request.uri;
${redirectRowsJs('REDIRECTS', '  ', { sameSite: true })}
  return request;
}`;
    const fn = inlineFunction(scope, 'BlocksRedirects', 'redirects', code);
    return [{ function: fn, eventType: FunctionEventType.VIEWER_REQUEST }];
  },

  headers(scope, headers) {
    markRule(headers);
    if (headers.length === 0) return [];
    const rows = JSON.stringify(headers.map((h) => [h.pattern, h.headers]));
    const code = `${CF_MATCH_HELPERS}
var HEADERS = ${rows};
function handler(event) {
  var request = event.request;
  var response = event.response;
  var uri = request.uri;
${headerRowsJs('HEADERS', '  ')}
  return response;
}`;
    const fn = inlineFunction(scope, 'BlocksHeaders', 'headers', code);
    return [{ function: fn, eventType: FunctionEventType.VIEWER_RESPONSE }];
  },

  errorPages(errorPages, origins) {
    if (!errorPages) return { errorResponses: [], behaviors: {} };
    markRule(errorPages);
    // The assets origin sits at the build prefix, so a page is served at its key.
    const errorResponses = customErrorResponses(errorPages, { pathPrefix: '', hasCompute: Boolean(origins.server) });
    const behaviors: Record<string, BehaviorOptions> = {};
    for (const page of new Set(errorResponses.map((r) => r.responsePagePath ?? ''))) {
      if (page) behaviors[page] = behaviorFor(origins.assets);
    }
    return { errorResponses, behaviors };
  },

  invalidate(distribution, options) {
    if (!(distribution instanceof Construct)) {
      throw new HostingError('InvalidPropsError', {
        message: 'cf.invalidate: the distribution must be a construct in this app.',
        resolution: 'Pass the Distribution your door created.',
      });
    }
    const buildId = options.buildId ?? buildIdByUploads.get(options.after);
    if (!buildId) {
      throw new HostingError('InvalidPropsError', {
        message: 'cf.invalidate: could not determine the build id for the invalidation.',
        resolution: "Call it from `onUpload` with the `uploads` it receives, or pass `buildId` explicitly.",
      });
    }
    const paths = [...(options.paths ?? ['/*'])];
    // A second invalidation of the same distribution in one build gets its own
    // CallerReference (CloudFront rejects a reused one with different paths).
    let id = 'BlocksInvalidation';
    let suffix = '';
    for (let n = 2; distribution.node.tryFindChild(id); n++) {
      id = `BlocksInvalidation${n}`;
      suffix = `-${n}`;
    }
    const invalidation = new AwsCustomResource(distribution, id, {
      onUpdate: {
        service: 'CloudFront',
        action: 'createInvalidation',
        parameters: {
          DistributionId: distribution.distributionId,
          InvalidationBatch: {
            CallerReference: `blocks-${buildId}${suffix}`,
            Paths: { Quantity: paths.length, Items: paths },
          },
        },
        physicalResourceId: PhysicalResourceId.of(`invalidation-${buildId}${suffix}`),
      },
      // Scoped to this distribution: the grant lands on the stack's shared
      // custom-resource role, which must not invalidate every distribution.
      policy: AwsCustomResourcePolicy.fromStatements([
        new PolicyStatement({
          actions: ['cloudfront:CreateInvalidation'],
          resources: [
            Stack.of(distribution).formatArn({
              service: 'cloudfront',
              region: '',
              resource: 'distribution',
              resourceName: distribution.distributionId,
            }),
          ],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    for (const upload of options.after) invalidation.node.addDependency(upload);
    return invalidation;
  },

  recordWired(origin, paths) {
    const record = recordOf(origin);
    if (!record) return;
    if (Array.isArray(origin) || !('kind' in origin)) {
      markRule(origin);
      return;
    }
    record.origins.add(origin.kind);
    if (origin.kind === 'api') {
      for (const path of paths ?? origin.paths) record.apiPaths.add(path);
    }
  },
};
