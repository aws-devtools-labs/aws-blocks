// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `cf.*` — CloudFront helpers for a free-form front door, and the wiring record
 * behind the one check AWS Blocks runs on a bring-your-own door.
 *
 * The helpers do two things:
 *   1. turn an origin from the {@link DoorInput} into a CloudFront origin and
 *      behavior (`cf.origin`, `cf.behaviors`, `cf.apiBehaviors`), and declare
 *      a post-upload invalidation (`cf.invalidate`);
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
  AllowedMethods,
  type BehaviorOptions,
  CachePolicy,
  type IDistribution,
  type IOrigin,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionUrlOrigin, HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { BucketDeployment } from 'aws-cdk-lib/aws-s3-deployment';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { HostingError } from '../hosting_error.js';
import type { ApiOrigin, DoorInput, DoorOrigin, DoorRoute } from './front_door.js';

// ── Wiring record ───────────────────────────────────────────────────────────

/** What a door was observed to wire, via the `cf.*` helpers or `cf.recordWired`. */
export type WiringRecord = {
  /** Origin kinds a helper produced a CloudFront origin for (or that were declared wired). */
  readonly origins: Set<'assets' | 'server' | 'image' | 'api'>;
  /** API path patterns that were wired to the API. */
  readonly apiPaths: Set<string>;
};

const recordsByOrigin = new WeakMap<object, WiringRecord>();

/**
 * Start a wiring record for one door's input: every origin object in `input`
 * is linked to the same record, so a helper called with any of them records
 * into it.
 *
 * @internal Framework-only (`HostingConstruct`, the conformance kit).
 */
export function startWiringRecord(input: DoorInput): WiringRecord {
  const record: WiringRecord = { origins: new Set(), apiPaths: new Set() };
  const { assets, server, image, api } = input.origins;
  for (const origin of [assets, server, image, api]) {
    if (origin) recordsByOrigin.set(origin, record);
  }
  return record;
}

const recordOf = (origin: object): WiringRecord | undefined => recordsByOrigin.get(origin);

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
   * its route's origin, with safe defaults per origin kind (assets cached,
   * compute uncached). The catch-all route (`/*`) is skipped — that is the
   * distribution's `defaultBehavior`. Records each origin as wired.
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
   * Declare a CloudFront invalidation that runs AFTER the given uploads. Meant
   * for `onUpload`: `onUpload: ({ uploads }) => cf.invalidate(dist, { after: uploads })`.
   * The caller reference is keyed on the build id, so an unchanged build is a
   * no-op and a new build issues a fresh invalidation.
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
   * `paths` to declare every `api.paths` entry wired.
   *
   * @param origin the origin from the input that the door wired by hand.
   * @param paths for the API origin only: the path patterns that reach it.
   */
  recordWired(origin: DoorOrigin | ApiOrigin, paths?: readonly string[]): void;
}

const markWired = (origin: DoorOrigin | ApiOrigin): void => {
  recordOf(origin)?.origins.add(origin.kind);
};

const behaviorFor = (origin: DoorOrigin): BehaviorOptions => ({
  origin: cf.origin(origin),
  ...(origin.kind === 'assets' ? ASSET_BEHAVIOR : DYNAMIC_BEHAVIOR),
});

const buildOrigin = (origin: DoorOrigin | ApiOrigin): IOrigin => {
  switch (origin.kind) {
    case 'assets':
      return S3BucketOrigin.withOriginAccessControl(origin.bucket, {
        originPath: `/${origin.prefix.replace(/^\/+|\/+$/g, '')}`,
      });
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
    }
    return behaviors;
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
    let id = 'BlocksInvalidation';
    for (let n = 2; distribution.node.tryFindChild(id); n++) id = `BlocksInvalidation${n}`;
    const invalidation = new AwsCustomResource(distribution, id, {
      onUpdate: {
        service: 'CloudFront',
        action: 'createInvalidation',
        parameters: {
          DistributionId: distribution.distributionId,
          InvalidationBatch: {
            CallerReference: `blocks-${buildId}`,
            Paths: { Quantity: paths.length, Items: paths },
          },
        },
        physicalResourceId: PhysicalResourceId.of(`invalidation-${buildId}`),
      },
      // createInvalidation is not resource-scopable in IAM.
      policy: AwsCustomResourcePolicy.fromStatements([
        new PolicyStatement({ actions: ['cloudfront:CreateInvalidation'], resources: ['*'] }),
      ]),
      installLatestAwsSdk: false,
    });
    for (const upload of options.after) invalidation.node.addDependency(upload);
    return invalidation;
  },

  recordWired(origin, paths) {
    const record = recordOf(origin);
    if (!record) return;
    record.origins.add(origin.kind);
    if (origin.kind === 'api') {
      for (const path of paths ?? origin.paths) record.apiPaths.add(path);
    }
  },
};
