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
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import type { IFunction, IFunctionUrl } from 'aws-cdk-lib/aws-lambda';
import type { IHostedZone } from 'aws-cdk-lib/aws-route53';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { BucketDeployment } from 'aws-cdk-lib/aws-s3-deployment';
import type { ITopicSubscription } from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
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
  /** Whether the server streams its responses (response-stream Function URL). */
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
  /** URL prefix image requests are served under (e.g. `/_next/image`, `/_ipx`). */
  readonly pathPrefix: string;
};

/**
 * The backend API, present when `Hosting` was given one (`api`). Every path
 * that must reach the backend is listed, so a door cannot silently drop a raw
 * route by proxying only `/aws-blocks/*`.
 */
export type ApiOrigin = {
  /** Discriminant. */
  readonly kind: 'api';
  /** The backend's full API URL (a CDK token), e.g. `https://{id}.execute-api.{region}.amazonaws.com/{stage}/aws-blocks`. */
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
  /**
   * The sign-in subset of {@link paths} (`/aws-blocks/auth/*`), so a door with
   * its own auth gate can let it through.
   */
  readonly authPaths: readonly string[];
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
  /** Asset-only URL prefix (e.g. Next.js `assetPrefix`). */
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
   * (e.g. `404.html`). Present only when the app configured one.
   */
  readonly errorPages?: { readonly notFound?: string; readonly serverError?: string };
  /** Canonical apex/www redirect. Present only when the app asked for one. */
  readonly wwwRedirect?: 'toApex' | 'toWww';
  /** Present only when skew protection is on: keep a visitor on one build for `maxAge` seconds. */
  readonly skew?: { readonly maxAge: number };
};

// ── Features the app asked for ──────────────────────────────────────────────

/**
 * The optional features this app asked the door for, with their settings. A
 * field is present ONLY when the app asked for that feature.
 *
 * AWS Blocks does not check that a door applies them: a free-form door reads
 * what is here and applies what it supports.
 */
export type DoorFeatures = {
  /** Custom domain(s) + TLS. `certificate`/`hostedZone` are set when the app supplied them. */
  readonly customDomain?: {
    readonly names: readonly string[];
    readonly certificate?: ICertificate;
    readonly hostedZone?: IHostedZone;
  };
  /** Request filtering. `webAclArn` when the app brought a web ACL; `rateLimit` per 5-minute window per IP. */
  readonly waf?: { readonly webAclArn?: string; readonly rateLimit?: number };
  /** Access logging. */
  readonly logging?: { readonly retentionDays?: number };
  /** Alarms on the door's metrics, with the endpoints to notify. */
  readonly alarms?: { readonly subscriptions?: readonly ITopicSubscription[] };
  /** Geo restriction: country codes to allow or deny. */
  readonly geo?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
};

/** The door this one sits in front of, when doors are stacked (e.g. CloudFront → ALB). */
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
  /** Present only when this door sits in front of another door. */
  readonly upstream?: DoorUpstream;
};

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
   */
  readonly onUpload?: (ctx: UploadContext) => void;
};

/**
 * A front door: a service id plus one `build` function.
 *
 * `TInput` is the input the door reads — {@link DoorInput} for a
 * bring-your-own door; a built-in door may extend it with internal-only
 * extras. `TResult` lets a built-in door hand back its construct too.
 */
export interface FrontDoor<TInput extends DoorInput = DoorInput, TResult extends FrontDoorResult = FrontDoorResult> {
  /** Stable id used in error messages and diagnostics (e.g. `cloudfront`, `alb`, `my-cdn`). */
  readonly service: string;
  /**
   * Create the door and wire it to the app. Called ONCE at synth, after AWS
   * Blocks has built the bucket, compute and API, and before it declares the
   * asset uploads.
   *
   * @param scope the construct scope to create the door's resources under.
   * @param input everything AWS Blocks knows about the app (see {@link DoorInput}).
   * @returns the door's public `url` (required) and optional extras (see {@link FrontDoorResult}).
   */
  build(scope: Construct, input: TInput): TResult;
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
 */
export function defineFrontDoor<TInput extends DoorInput = DoorInput, TResult extends FrontDoorResult = FrontDoorResult>(
  door: FrontDoor<TInput, TResult>,
): FrontDoor<TInput, TResult> {
  return door;
}
