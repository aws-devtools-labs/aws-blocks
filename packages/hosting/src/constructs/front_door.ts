// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The front-door interface — the free-form shape.
 *
 * A front door is the public entry point in front of an app: it exposes one
 * address and routes each request to the right provisioned origin (static
 * assets, server rendering, image optimization, the backend API). AWS Blocks
 * builds the app and everything it runs on; the front door's author creates the
 * door and wires it to what AWS Blocks built.
 *
 * A door is one function. {@link defineFrontDoor} types it:
 *
 * ```ts
 * import { Distribution } from 'aws-cdk-lib/aws-cloudfront';
 * import { cf, defineFrontDoor } from '@aws-blocks/hosting/constructs';
 *
 * export const myDoor = defineFrontDoor({
 *   service: 'my-cdn',
 *   build(scope, { app, origins, features }) {
 *     const dist = new Distribution(scope, 'Cdn', {
 *       defaultBehavior: { origin: cf.origin(origins.server ?? origins.assets) },
 *       additionalBehaviors: { ...cf.behaviors(app.routes), ...cf.apiBehaviors(origins.api) },
 *       webAclId: features.waf?.webAclArn,
 *     });
 *     return {
 *       url: `https://${dist.distributionDomainName}`,
 *       onUpload: ({ uploads }) => cf.invalidate(dist, { after: uploads }),
 *     };
 *   },
 * });
 * ```
 *
 * AWS Blocks calls `build` ONCE, at synth, after it has created the assets
 * bucket, the compute and the API, and before it declares the asset uploads.
 * Everything it knows about the app arrives in the {@link DoorInput}; the door
 * hands back a {@link FrontDoorResult} whose `url` becomes the app's address.
 *
 * Every built-in door (CloudFront, ALB, API Gateway, the S3 website behind
 * `'none'`, and the CloudFront edge of the stacked door) is written this way
 * too. A built-in may read internal-only extras through an input type that
 * extends {@link DoorInput}; a bring-your-own door receives exactly
 * {@link DoorInput}.
 *
 * These are CDK types by design: this module ships from the CDK entry
 * (`@aws-blocks/hosting/constructs`), where door authors are writing CDK.
 *
 * @module
 */
import type { IFunction, IFunctionUrl } from 'aws-cdk-lib/aws-lambda';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { BucketDeployment } from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct, IConstruct } from 'constructs';
import type { HostingLoggingConfig, HostingMonitoringConfig } from './front_door_options.js';
import type { HostingDomainConfig, HostingWafConfig } from './hosting_construct.js';
import type { OriginHandle } from './layer.js';

// ── Provisioned origins ─────────────────────────────────────────────────────

/**
 * The app's static assets: the private bucket AWS Blocks created, and the
 * immutable per-build prefix the current build is uploaded under.
 */
export type AssetsOrigin = {
  /** Discriminant. */
  readonly kind: 'assets';
  /** The private assets bucket (no public access — reach it with OAC or a proxy). */
  readonly bucket: IBucket;
  /** Key prefix of the current build, e.g. `builds/<buildId>/` (always ends in `/`). */
  readonly prefix: string;
  /** The local build output directory, for a door that publishes the files elsewhere. */
  readonly sourceDir: string;
};

/** The server-rendering compute (SSR), present when the app has one. */
export type ServerOrigin = {
  /** Discriminant. */
  readonly kind: 'server';
  /** The server-rendering Lambda function. */
  readonly fn: IFunction;
  /**
   * A Function URL for {@link fn} (IAM auth). Created on first read, so a door
   * that reaches the server another way never provisions one.
   */
  readonly url: IFunctionUrl;
  /**
   * Whether the server streams its responses, as built for this door: `false`
   * when the door declared `serverResponse: 'buffered'` (a Lambda Web Adapter
   * server is then built buffered). {@link url} is created in the matching
   * invoke mode (`RESPONSE_STREAM` or `BUFFERED`).
   */
  readonly streaming: boolean;
};

/** The image-optimization compute, present when the app has one. */
export type ImageOrigin = {
  /** Discriminant. */
  readonly kind: 'image';
  /** The image-optimization Lambda function. */
  readonly fn: IFunction;
  /** The image function's Function URL (IAM auth). */
  readonly url: IFunctionUrl;
};

/**
 * The backend API, present when `Hosting` was given one (`api`). Every path
 * that must reach the backend is listed, so a door cannot silently drop a raw
 * route by proxying only `/aws-blocks/*`.
 */
export type ApiOrigin = {
  /** Discriminant. */
  readonly kind: 'api';
  /** The backend's full API URL (a CDK token), e.g. `https://{id}.execute-api.{region}.amazonaws.com/{stage}/aws-blocks/api`. */
  readonly url: string;
  /** The API host (no scheme, no path), derived from {@link url} in-template. */
  readonly host: string;
  /** The stage path to set as the origin path, e.g. `/prod`, derived from {@link url} in-template. */
  readonly stagePath: string;
  /**
   * Every path pattern to proxy to the API: `/aws-blocks/*` (RPC and sign-in)
   * plus each raw route the backend registered.
   */
  readonly paths: readonly string[];
};

/**
 * The app's single entry point, present only when the door routes at the app
 * (`routing: 'app'`, see {@link FrontDoor.routing}). It runs the app's whole
 * route table itself — redirects, the same-origin API, static files from the
 * assets bucket, image optimization and server rendering — so the door maps
 * the app's hostname to this one function (e.g. one ALB listener rule and one
 * Lambda target group) and nothing else.
 *
 * It is the app's server function when the app has a regional one (its
 * handler is wrapped by the router: no new function), else one router
 * function AWS Blocks creates for the app. It answers buffered (not
 * streamed) and accepts the events of an ALB Lambda target, an API Gateway
 * REST or HTTP API, and a Lambda Function URL.
 *
 * It is the door's build cutover: AWS Blocks updates it only after the new
 * build's files are uploaded, so the door needs no cutover of its own for it.
 */
export type EntryOrigin = {
  /** Discriminant. */
  readonly kind: 'entry';
  /** The entry Lambda function. */
  readonly fn: IFunction;
  /**
   * A Function URL for {@link fn} (IAM auth, `BUFFERED`). Created on first
   * read, so a door that reaches the function another way never provisions
   * one. When the entry is the server function, this is the same URL as
   * `origins.server.url`.
   */
  readonly url: IFunctionUrl;
  /** Whether the entry streams its responses: always `false` (the router answers buffered). */
  readonly streaming: boolean;
};

/** An origin a route can point at. */
export type DoorOrigin = AssetsOrigin | ServerOrigin | ImageOrigin;

/** Where each kind of request lives — what AWS Blocks provisioned for the app. */
export type DoorOrigins = {
  /** The static assets (always present). */
  readonly assets: AssetsOrigin;
  /** The server-rendering compute, when the app has one. */
  readonly server?: ServerOrigin;
  /** The image-optimization compute, when the app has one. */
  readonly image?: ImageOrigin;
  /** The backend API, when `Hosting` was given one. */
  readonly api?: ApiOrigin;
  /**
   * The app's single entry point — present only when the door routes at the
   * app (`routing: 'app'`), where it is always present (see {@link AppRoutingDoorInput}).
   */
  readonly entry?: EntryOrigin;
};

// ── App facts ───────────────────────────────────────────────────────────────

/** One route of the app, already joined to its origin (no lookup by name). */
export type DoorRoute = {
  /** Path pattern, most-specific first in {@link DoorApp.routes} (e.g. `/assets/*`, `/*`). */
  readonly pattern: string;
  /** The origin serving this route — one of the objects in {@link DoorInput.origins}. */
  readonly origin: DoorOrigin;
};

/** A redirect rule the app declared (basePath-resolved). */
export type DoorRedirect = {
  readonly source: string;
  readonly destination: string;
  readonly statusCode: 301 | 302 | 307 | 308;
};

/** A per-pattern response-header rule the app declared (basePath-resolved). */
export type DoorHeaderRule = {
  /** URL pattern the headers apply to. */
  readonly pattern: string;
  /** Header name → value. */
  readonly headers: Readonly<Record<string, string>>;
};

/** What this app needs served — extracted from its build output and `Hosting` props. */
export type DoorApp = {
  /** The immutable id of this build; its assets live under {@link AssetsOrigin.prefix}. */
  readonly buildId: string;
  /** URL prefix the whole site is served under (e.g. Next.js `basePath`). */
  readonly basePath?: string;
  /**
   * Asset-only URL prefix: Next.js `assetPrefix`. Only the Next.js adapter sets
   * it (a custom adapter may too). Present only when the app has one.
   */
  readonly assetPrefix?: string;
  /** Single-page-app fallback: unknown extensionless paths serve `index.html`. */
  readonly spaFallback: boolean;
  /** The ordered route table, most-specific first, each route joined to its origin. */
  readonly routes: readonly DoorRoute[];
  /** Redirects to perform (first match wins). */
  readonly redirects: readonly DoorRedirect[];
  /** Per-pattern response headers to inject. */
  readonly headers: readonly DoorHeaderRule[];
  /**
   * Custom error pages, as object keys relative to {@link AssetsOrigin.prefix}
   * (e.g. `404.html`): the app's `errorPages`, else the 404 and 500 pages the
   * framework build shipped (e.g. a SPA's `404.html`). A multi-page static
   * site (no server, no SPA fallback) with no 404 page of its own gets AWS
   * Blocks' default one as `notFound` (`_not_found.html`, uploaded with the
   * build), the page the CloudFront door serves for the same miss. Present
   * only when the app has one.
   */
  readonly errorPages?: { readonly notFound?: string; readonly serverError?: string };
};

// ── Features the app asked for ──────────────────────────────────────────────

/**
 * The settings this app asked the door for — the door's `frontDoor.features`
 * (merged with the deprecated top-level props), under the SAME names and
 * shapes (see `CustomDoorFeatures`). A field is present ONLY when the app
 * asked for that feature:
 *
 * - `domain`: when set (`domain.wwwRedirect` included when not `'none'`);
 * - `waf`: when `enabled`, or a web ACL was given (`webAclArn`);
 * - `logging`: when `enabled`;
 * - `monitoring`: when set and not `enabled: false`;
 * - `geoRestriction`: when set;
 * - `skewProtection`: unless `enabled: false` (on by default), with `maxAge` resolved.
 *
 * AWS Blocks does not check that a door applies them: a free-form door reads
 * what is here and applies what it supports.
 */
export type DoorFeatures = {
  /**
   * Custom domain(s) + TLS, as the app wrote them. Import a hosted zone given
   * by id with `HostedZone.fromHostedZoneAttributes`.
   */
  readonly domain?: Readonly<HostingDomainConfig>;
  /** Request filtering. `webAclArn` when the app brought a web ACL; `rateLimit` per 5-minute window per IP. */
  readonly waf?: Readonly<HostingWafConfig>;
  /** Access logging (`enabled` is always `true` here). */
  readonly logging?: Readonly<HostingLoggingConfig>;
  /** Alarms on the door's metrics, with the endpoints to notify. */
  readonly monitoring?: Readonly<HostingMonitoringConfig>;
  /**
   * Geo restriction: the country codes to allow (`'allowlist'`) or deny
   * (`'denylist'`). The app may write the legacy `'whitelist'` / `'blacklist'`;
   * the door always receives these two.
   */
  readonly geoRestriction?: { readonly type: 'allowlist' | 'denylist'; readonly countries: readonly string[] };
  /** Skew protection: keep a visitor on one build for `maxAge` seconds. */
  readonly skewProtection?: { readonly enabled: true; readonly maxAge: number };
};

/**
 * The door this one sits in front of, when doors are stacked (e.g. CloudFront
 * → ALB). Only the built-in stacked door has one (see `CloudFrontEdgeDoorInput`).
 */
export type DoorUpstream = {
  /** The inner door's service id (e.g. `alb`). */
  readonly service: string;
  /** The inner door's address. */
  readonly url: string;
  /** How to point an origin at the inner door. */
  readonly originHandle: OriginHandle;
};

/**
 * Everything AWS Blocks hands a front door at synth: the author's entire view
 * of the app. None of it is written by the door author — AWS Blocks extracts
 * the app facts from the build output and `Hosting` props, and provisions the
 * origins before the door is built.
 */
export type DoorInput = {
  /** App facts: what this app needs served. */
  readonly app: DoorApp;
  /** Provisioned origins: what AWS Blocks built, and where it lives. */
  readonly origins: DoorOrigins;
  /** The features this app asked for. A field is present only when asked for. */
  readonly features: DoorFeatures;
};

/**
 * The input of a door that routes at the app (`routing: 'app'`): `TInput`
 * with `origins.entry` always present.
 */
export type AppRoutingDoorInput<TInput extends DoorInput = DoorInput> = TInput & {
  readonly origins: { readonly entry: EntryOrigin };
};

/**
 * Where the app's route table runs (see {@link FrontDoor.routing}):
 * `'door'` renders it onto the door's own primitives, `'app'` runs it in the
 * app's entry function.
 */
export type DoorRouting = 'door' | 'app';

/** The input `build` receives for a door's routing mode: {@link AppRoutingDoorInput} under `'app'`, else `TInput`. */
export type DoorInputFor<TInput extends DoorInput, TRouting extends DoorRouting> = [TRouting] extends ['app']
  ? AppRoutingDoorInput<TInput>
  : TInput;

// ── What the door hands back ────────────────────────────────────────────────

/** What AWS Blocks passes to {@link FrontDoorResult.onUpload}. */
export type UploadContext = {
  /** Every asset upload AWS Blocks declared for this build. Depend on these to run after them. */
  readonly uploads: readonly BucketDeployment[];
  /** The build these uploads belong to. */
  readonly buildId: string;
};

/** What a door's `build` returns. */
export type FrontDoorResult = {
  /**
   * REQUIRED. The app's public address (e.g. `https://d123.cloudfront.net`, or
   * the custom domain when the door serves one). AWS Blocks publishes it as the
   * `HostingUrl` output and `Hosting.url`, hands it to the backend as the
   * trusted public origin (`BLOCKS_PUBLIC_ORIGIN`), and allows it for
   * cross-origin API calls (`CORS_HOSTING_ORIGINS`). A missing or empty `url`
   * fails synth (`MissingFrontDoorUrlError`).
   */
  readonly url: string;
  /**
   * How a door in front of this one reaches it. Derived from {@link url} (its
   * host and scheme) unless given — override only when the inner address
   * differs from the public one (e.g. a private, VPC-only origin).
   */
  readonly originHandle?: OriginHandle;
  /**
   * A public bucket the door serves the files from (e.g. an S3 website). AWS
   * Blocks then publishes the app's runtime config there instead of the
   * private assets bucket.
   */
  readonly publicBucket?: IBucket;
  /**
   * Called once at synth, after AWS Blocks has declared the asset uploads, so
   * the door can declare resources that must run after them (e.g. a cache
   * invalidation via `cf.invalidate`). Like the door itself, it only DECLARES
   * resources; CloudFormation runs them during the deploy.
   *
   * Declare them under the door's `scope` (or a construct inside it): those
   * also wait for the uploads AWS Blocks declares later (the
   * `@aws-blocks/core` `Hosting` uploads the resolved runtime config after
   * the door). A resource created directly under the stack is not ordered
   * after that later upload.
   */
  readonly onUpload?: (ctx: UploadContext) => void;
  /**
   * The constructs that switch traffic to the new build — whatever holds the
   * build id or prefix (e.g. a proxy Lambda whose environment names
   * `builds/<buildId>`, a function that rewrites to it). AWS Blocks makes each
   * one depend on every asset upload of the build, the later runtime-config
   * upload included, so CloudFormation updates it only once the new files are
   * in place and the previous build keeps serving until then.
   *
   * An in-place build (`HostingConstructProps.inPlaceBuild`, core `Hosting`
   * `buildId: 'fixed'`) reuses one prefix, so there is nothing to switch:
   * the cutover constructs are then not ordered after the uploads.
   */
  readonly cutover?: readonly IConstruct[];
};

/**
 * A front door: a service id plus one `build` function.
 *
 * `TInput` is the input the door reads — {@link DoorInput} for a
 * bring-your-own door; a built-in door may extend it with internal-only
 * extras. `TResult` lets a built-in door hand back its construct too.
 * `TRouting` is the door's {@link FrontDoor.routing} mode, inferred from the
 * literal by {@link defineFrontDoor}: under `'app'`, `build` receives
 * {@link AppRoutingDoorInput} (`origins.entry` always present).
 */
export interface FrontDoor<
  TInput extends DoorInput = DoorInput,
  TResult extends FrontDoorResult = FrontDoorResult,
  TRouting extends DoorRouting = DoorRouting,
> {
  /** Stable id used in error messages and diagnostics (e.g. `cloudfront`, `alb`, `my-cdn`). */
  readonly service: string;
  /**
   * Where the app's route table runs.
   *
   * - `'door'` (default): the door renders the route table onto its own
   *   primitives — behaviors and functions, listener rules, API routes — from
   *   `input.app.routes` and `input.origins`. Every built-in door works this way.
   * - `'app'`: the app routes itself. AWS Blocks gives the door one entry
   *   function (`input.origins.entry`) that runs the whole route table —
   *   redirects, the same-origin API, static files, image optimization, server
   *   rendering, header rules and error pages — and the door maps the app's
   *   hostname to it and nothing else (e.g. one listener rule on a shared ALB).
   *   The entry is the app's server function, wrapped, or for an app without
   *   one a single router function; it answers buffered, so `serverResponse`
   *   is `'buffered'` (setting it to `'streaming'` fails synth). The routes
   *   and API wiring check does not apply.
   *
   * Trade-offs of `'app'`: every request runs in Lambda (static files too,
   * billed as Lambda time), the door's response-size limit applies to every
   * file (1 MB behind an ALB; larger files fail), and nothing is cached at an
   * edge unless the door puts one in front.
   *
   * @default 'door'
   */
  readonly routing?: TRouting;
  /**
   * How the door invokes the server-rendering compute, so AWS Blocks builds
   * the server to answer in a form the door can carry. Read before the compute
   * is built.
   *
   * - `'streaming'` (default): the door streams the server's response (a
   *   CloudFront Function URL origin with `RESPONSE_STREAM`, an API Gateway
   *   REST integration with `ResponseTransferMode.STREAM`).
   * - `'buffered'`: the door invokes the server with a plain (non-streaming)
   *   invoke and needs a complete response: an ALB Lambda target, an API
   *   Gateway HTTP API integration, or a `BUFFERED` Function URL. A streaming
   *   server behind such a door returns the stream's framing instead of the
   *   page (a 502, a 500, or an empty 200).
   *
   * `input.origins.server.streaming` reports the result, and
   * `input.origins.server.url` is created in the matching invoke mode. Has no
   * effect on an app without a server.
   *
   * @default 'streaming'
   */
  readonly serverResponse?: 'streaming' | 'buffered';
  /**
   * Create the door and wire it to the app. Called ONCE at synth, after AWS
   * Blocks has built the bucket, compute and API, and before it declares the
   * asset uploads.
   *
   * @param scope the construct scope to create the door's resources under.
   * @param input everything AWS Blocks knows about the app (see {@link DoorInput});
   *   with `routing: 'app'`, `input.origins.entry` too (see {@link AppRoutingDoorInput}).
   * @returns the door's public `url` (required) and optional extras (see {@link FrontDoorResult}).
   */
  build(scope: Construct, input: DoorInputFor<TInput, TRouting>): TResult;
}

/**
 * Define a front door. An identity helper: it returns its argument unchanged
 * and only gives the object literal its type (so `build`'s `input` is typed
 * without annotations).
 *
 * @example
 * export const myDoor = defineFrontDoor({
 *   service: 'my-cdn',
 *   build(scope, { origins }) {
 *     const dist = new Distribution(scope, 'Cdn', { defaultBehavior: { origin: cf.origin(origins.assets) } });
 *     return { url: `https://${dist.distributionDomainName}` };
 *   },
 * });
 *
 * @example
 * // A door that invokes the server without streaming (e.g. an ALB Lambda target):
 * export const myAlbDoor = defineFrontDoor({
 *   service: 'my-alb',
 *   serverResponse: 'buffered',
 *   build: buildMyAlb, // your build: an ALB whose default target is origins.server.fn
 * });
 *
 * @example
 * // A door that routes at the app: one listener rule on a shared ALB per app.
 * export const sharedAlbDoor = defineFrontDoor({
 *   service: 'shared-alb',
 *   routing: 'app',
 *   build(scope, { origins }) {
 *     const target = new ApplicationTargetGroup(scope, 'Tg', {
 *       targetType: TargetType.LAMBDA,
 *       targets: [new LambdaTarget(origins.entry.fn)],
 *       multiValueHeadersEnabled: true,
 *     });
 *     new ApplicationListenerRule(scope, 'Rule', {
 *       listener: sharedListener, // your ALB's HTTPS listener
 *       priority: 10,
 *       conditions: [ListenerCondition.hostHeaders(['app.example.com'])],
 *       action: ListenerAction.forward([target]),
 *     });
 *     return { url: 'https://app.example.com' };
 *   },
 * });
 */
export function defineFrontDoor<
  TInput extends DoorInput = DoorInput,
  TResult extends FrontDoorResult = FrontDoorResult,
  TRouting extends DoorRouting = 'door',
>(door: FrontDoor<TInput, TResult, TRouting>): FrontDoor<TInput, TResult, TRouting> {
  return door;
}
