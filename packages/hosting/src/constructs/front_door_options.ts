// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `frontDoor` prop: which front door serves the deploy, and the settings
 * the app asks that door for (`features`).
 *
 * Each door kind takes its own typed `features`, holding exactly the settings
 * that door implements. A setting the chosen kind doesn't implement is a
 * TypeScript error:
 *
 * ```ts
 * frontDoor: { features: { waf: { enabled: true }, priceClass: PriceClass.PRICE_CLASS_ALL } } // CloudFront (default)
 * frontDoor: { kind: 'alb', features: { waf: { enabled: true }, logging: { enabled: true } } }
 * frontDoor: { kind: 'alb', features: { geoRestriction: { … } } } // ✗ type error: the ALB has no geo restriction
 * ```
 *
 * The names inside `features` are the names of the top-level props they
 * replace (`domain`, `waf`, `logging`, `monitoring`, …), so moving a setting
 * into `frontDoor.features` is a straight move. The top-level props keep
 * working as deprecated aliases: at construction they are merged into the
 * effective `frontDoor.features` (see {@link resolveFrontDoorFeatures}).
 *
 * Settings per door kind (✓ = implemented by that door):
 *
 * | Setting | CloudFront | ALB | API Gateway | Custom (BYO) |
 * | --- | --- | --- | --- | --- |
 * | `domain` | ✓ | ✓ (no `wwwRedirect`) | ✓ (no `wwwRedirect`) | ✓ |
 * | `waf` | ✓ (CLOUDFRONT scope) | ✓ (REGIONAL scope) | – | ✓ |
 * | `logging` | ✓ | ✓ | – | ✓ |
 * | `monitoring` | ✓ | ✓ (`enabled` only) | – | ✓ |
 * | `skewProtection` | ✓ | – | – | ✓ |
 * | `geoRestriction` | ✓ | – | – | ✓ |
 * | `priceClass`, `contentSecurityPolicy`, `ssrDefaultTtl`, `cacheKeyCookies`, `cacheKeyHeaders`, `responseHeadersPolicy`, `quotas` | ✓ | – | – | – |
 *
 * The stacked door (`@aws-blocks/core` `Hosting` only) scopes its settings
 * per layer: {@link StackedDoorFeatures}. `'none'` takes no settings.
 *
 * @module
 */
import type { Duration } from 'aws-cdk-lib';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import type { IResponseHeadersPolicy, PriceClass } from 'aws-cdk-lib/aws-cloudfront';
import type { IVpc } from 'aws-cdk-lib/aws-ec2';
import type { EmailSubscription, UrlSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { HostingError } from '../hosting_error.js';
import type { DoorFeatures, DoorInput, FrontDoor } from './front_door.js';
import type { AccessLogFormat, AccessLogPartitioning } from './access_logging.js';
import type { HostingDomainConfig, HostingWafConfig } from './hosting_construct.js';
import type { QuotaOverrides } from './quota_budget.js';
import type { SkewProtectionConfig } from './skew_protection.js';

// ── Setting shapes (shared by the top-level props and `features`) ───────────

/**
 * Access logging: `enabled` turns it on; `retentionDays` sets how long the logs
 * are kept. `version`, `partitioning` and `format` choose the CloudFront
 * logging pipeline (CloudFront door only; other doors ignore them).
 */
export type HostingLoggingConfig = {
  enabled: boolean;
  retentionDays?: number;
  /**
   * CloudFront logging pipeline: `'v1'` (legacy standard logging) or `'v2'`
   * (standard logging v2 via the CloudWatch Logs delivery pipeline).
   * @default 'v1'
   */
  version?: 'v1' | 'v2';
  /** (v2 only) S3 key layout for delivered logs. @default 'date' */
  partitioning?: AccessLogPartitioning;
  /** (v2 only) Delivered log record format. @default 'w3c' */
  format?: AccessLogFormat;
};

/**
 * CloudWatch alarms on the door's metrics, with endpoint subscriptions on the
 * alarm topics (`EmailSubscription` / `UrlSubscription` from
 * `aws-cdk-lib/aws-sns-subscriptions`).
 */
export type HostingMonitoringConfig = {
  /** @default true */
  enabled?: boolean;
  /**
   * Endpoint subscriptions applied to every hosting alarm topic.
   * `EmailSubscription` / `UrlSubscription` only.
   */
  subscriptions?: Array<EmailSubscription | UrlSubscription>;
};

/**
 * Geo restriction: the country codes to allow (`'allowlist'`) or deny
 * (`'denylist'`). `'whitelist'` and `'blacklist'` are accepted as the legacy
 * spellings of the same two; any other value fails synth
 * (`InvalidFrontDoorSettingError`). The door receives `'allowlist'` /
 * `'denylist'` (see `DoorFeatures.geoRestriction`).
 */
export type HostingGeoRestriction = {
  type: 'allowlist' | 'denylist' | 'whitelist' | 'blacklist';
  countries: string[];
};

// ── Features per door kind ──────────────────────────────────────────────────

/**
 * Settings the CloudFront door (the default) implements. Each one has the name
 * and shape of the top-level prop it replaces (on `HostingConstruct`, the
 * CloudFront settings were under `cdn.*`: `cdn.priceClass` →
 * `features.priceClass`, and so on).
 *
 * `TDomain` is the custom-domain shape: {@link HostingDomainConfig} here; the
 * `@aws-blocks/core` `Hosting` widens `domainName` to accept `config()` markers.
 */
export type CloudFrontDoorFeatures<TDomain = HostingDomainConfig> = {
  /** Custom domain(s): ACM certificate (us-east-1), distribution aliases, Route 53 records, `wwwRedirect`. */
  domain?: TDomain;
  /** A CLOUDFRONT-scoped web ACL: a rate-limited one built for you (`enabled`), or yours (`webAclArn`, in us-east-1). */
  waf?: HostingWafConfig;
  /** CloudFront and asset-bucket access logs. @default \{ enabled: true \} */
  logging?: HostingLoggingConfig;
  /** CloudFront 5xx, Lambda error/throttle and revalidation-queue alarms. @default \{ enabled: true \} */
  monitoring?: HostingMonitoringConfig;
  /** Cookie-based skew protection at the edge. @default \{ enabled: true \} */
  skewProtection?: SkewProtectionConfig;
  /** CloudFront price class. @default PriceClass.PRICE_CLASS_100 */
  priceClass?: PriceClass;
  /** `Content-Security-Policy` header value for the security-headers policy. */
  contentSecurityPolicy?: string;
  /** CloudFront geo restriction. */
  geoRestriction?: HostingGeoRestriction;
  /**
   * Default TTL for SSR cache behaviors when the origin sends no
   * `Cache-Control`. Synth fails closed if this is `> 0` and neither
   * `cacheKeyCookies` nor `cacheKeyHeaders` is set.
   * @default Duration.seconds(0)
   */
  ssrDefaultTtl?: Duration;
  /** Cookie names in the SSR cache key (at most 10; 2 are reserved for Next.js preview mode). */
  cacheKeyCookies?: string[];
  /** Header names in the SSR cache key (e.g. `'authorization'`; not `'accept-encoding'`). */
  cacheKeyHeaders?: string[];
  /** Bring-your-own response headers policy (shared across stacks to save the account quota). */
  responseHeadersPolicy?: IResponseHeadersPolicy;
  /** The AWS Service Quotas you were granted (cache behaviors, Lambda\@Edge associations, header policies). */
  quotas?: QuotaOverrides;
};

/**
 * Settings the ALB door implements. It has no edge: no geo restriction, price
 * class, CSP header or skew protection.
 *
 * `TDomain` is the custom-domain shape (see {@link CloudFrontDoorFeatures}).
 */
export type AlbDoorFeatures<TDomain = HostingDomainConfig> = {
  /**
   * Custom domain(s) served by the load balancer over HTTPS: the door's
   * `certificate`, else `domain.certificate`, else a DNS-validated regional
   * certificate (needs `hostedZone` / `hostedZoneId`); Route 53 A/AAAA alias
   * records to the ALB when a hosted zone is given; and a port 80 → 443
   * redirect. The primary name is the app's URL (`HostingUrl`, the trusted
   * public origin, the CORS hosting origin). No `wwwRedirect`.
   */
  domain?: Omit<TDomain, 'wwwRedirect'>;
  /**
   * A REGIONAL web ACL on the load balancer: a rate-limited one built for you
   * (`enabled`), or yours (`webAclArn`, a REGIONAL ACL in the stack's region).
   */
  waf?: HostingWafConfig;
  /**
   * The ALB's own access logs (a dedicated bucket): off unless set (and not
   * `enabled: false`). The asset bucket's access logs are on by default on
   * every door; `{ enabled: false }` turns both off.
   */
  logging?: HostingLoggingConfig;
  /**
   * Alarms on the ALB's own metrics (5xx count, target response time): on
   * unless `enabled: false`, as on the CloudFront door. The ALB door creates no alarm topic
   * and subscribes no endpoints, so only `enabled` applies; attach actions to
   * the alarms yourself.
   */
  monitoring?: { enabled?: boolean };
};

/**
 * Settings the API Gateway door (HTTP and REST) implements: a regional custom
 * domain. There is no WAF, access log or alarm on either flavor, and no
 * www-redirect.
 */
export type ApiGatewayDoorFeatures<TDomain = HostingDomainConfig> = {
  /**
   * Custom domain(s): a regional DomainName + API mapping (HTTP) or base-path
   * mapping (REST) + Route 53 alias. The door's `certificate`, else
   * `domain.certificate`, else a DNS-validated one. Required for `api: 'rest'`.
   */
  domain?: Omit<TDomain, 'wwwRedirect'>;
};

/**
 * Settings a bring-your-own door receives. They reach the door as
 * `input.features` ({@link DoorFeatures}) under the SAME names and shapes,
 * keeping only what the app asked for: `waf` when `enabled` or a web ACL is
 * given, `logging` when `enabled`, `monitoring` when set and not
 * `enabled: false` (a door receives no `monitoring` unless the app sets it),
 * `skewProtection` unless `enabled: false` (on by default, `maxAge` resolved),
 * and `domain` / `geoRestriction` when set.
 *
 * AWS Blocks does not check that the door applies them.
 */
export type CustomDoorFeatures<TDomain = HostingDomainConfig> = {
  /** Custom domain(s), with `wwwRedirect` → `input.features.domain`. */
  domain?: TDomain;
  /** Request filtering → `input.features.waf`. */
  waf?: HostingWafConfig;
  /** Access logging → `input.features.logging` (also the asset bucket's access logs). */
  logging?: HostingLoggingConfig;
  /** Alarms → `input.features.monitoring`. */
  monitoring?: HostingMonitoringConfig;
  /** Geo restriction → `input.features.geoRestriction`. */
  geoRestriction?: HostingGeoRestriction;
  /** Skew protection → `input.features.skewProtection`. @default \{ enabled: true \} */
  skewProtection?: SkewProtectionConfig;
};

/**
 * Settings the stacked door (`{ kind: 'stacked', edge: 'cloudfront', router:
 * 'alb' }`, on the `@aws-blocks/core` `Hosting`) implements, per layer. Each
 * layer takes its own WAF: the edge a CLOUDFRONT-scoped ACL, the router a
 * REGIONAL one.
 */
export type StackedDoorFeatures = {
  /** The CloudFront edge. */
  edge?: {
    /** Your CLOUDFRONT-scoped web ACL (in us-east-1) on the edge distribution. */
    waf?: { webAclArn: string };
    /** `Content-Security-Policy` header value for the edge's security-headers policy. */
    contentSecurityPolicy?: string;
  };
  /**
   * The ALB router behind the edge: the {@link AlbDoorFeatures}. Its `domain`
   * is not the app's address (the edge is): it is the name the edge connects
   * to over HTTPS — the router's certificate (the stacked door's
   * `certificate`, else a DNS-validated one) covers it, and Route 53 alias
   * records point it at the ALB. Without one, the edge → router hop is HTTP.
   */
  router?: AlbDoorFeatures;
};

// ── The door options ────────────────────────────────────────────────────────

/** The CloudFront door (the default) with settings: `{ features }`, `kind` optional. */
export type CloudFrontDoorOptions<TDomain = HostingDomainConfig> = {
  /** `'cloudfront'`, or omit — the default door. */
  kind?: 'cloudfront';
  /** The settings the app asks the CloudFront door for. */
  features?: CloudFrontDoorFeatures<TDomain>;
};

/**
 * An Application Load Balancer door (regional, no CDN).
 *
 * `TDomain` is the custom-domain shape (see {@link CloudFrontDoorFeatures}).
 */
export type AlbDoorOptions<TDomain = HostingDomainConfig> = {
  kind: 'alb';
  /** BYO VPC; a default 2-AZ VPC is created when omitted. */
  vpc?: IVpc;
  /**
   * Internal (private) ALB vs internet-facing. Default: internet-facing. An
   * internal ALB is placed in the VPC's private subnets when it has any (the
   * default VPC is public-only: bring a VPC with private subnets).
   */
  internal?: boolean;
  /**
   * Regional ACM certificate for the HTTPS listener (same region as the ALB).
   * It must cover `features.domain`, which is required with it: a certificate
   * can't cover the ALB's own `*.elb.amazonaws.com` name, so the app is
   * reached at the custom domain.
   */
  certificate?: ICertificate;
  /** The settings the app asks the ALB door for. */
  features?: AlbDoorFeatures<TDomain>;
};

/**
 * The ALB door as the stacked door's router, as `@aws-blocks/core` `Hosting`
 * hands it to the L3. Not for apps: it locks the ALB to a CloudFront door in
 * front of it (every listener rule requires the origin-verify header, the
 * default action is a 403, and the security group admits only CloudFront —
 * the origin-facing managed prefix list for a public ALB, a CloudFront VPC
 * origin for an `internal` one), so without that edge the site is unreachable.
 * Use `{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }` on `Hosting`.
 *
 * @internal Framework-only.
 */
export type StackedRouterDoorOptions = {
  kind: 'stackedRouter';
  /** BYO VPC; a default 2-AZ VPC is created when omitted. */
  vpc?: IVpc;
  /** Internal (private) ALB, reached through a CloudFront VPC origin. */
  internal?: boolean;
  /** The router's certificate (HTTPS :443 from the edge); needs `features.domain`. */
  certificate?: ICertificate;
  /** The router's settings (its `domain` is the name the edge connects to). */
  features?: AlbDoorFeatures;
};

/** An Amazon API Gateway door (regional, no CDN, no VPC). */
export type ApiGatewayDoorOptions<TDomain = HostingDomainConfig> = {
  kind: 'apiGateway';
  /**
   * The API Gateway flavor. `'http'` (default) is an HTTP API v2 — its auto
   * `$default` stage is **rootless**, so a SPA/SSR app's root-absolute asset
   * URLs (`/assets/*`, `/favicon.ico`) resolve directly; it's also cheaper.
   * `'rest'` is a REST API: it invokes the SSR/image Lambdas with
   * `lambda:InvokeFunction` (no Function-URL body-hash mismatch), but a bare
   * REST `execute-api` URL always carries a **stage path** (`/prod/`), which
   * breaks root-absolute asset URLs — so `'rest'` requires a **custom
   * domain** (base-path mapping to the stage); without `domain`, synth
   * fails with `RestFrontDoorNeedsDomainError`. `'rest'` streams SSR
   * responses; `'http'` buffers them.
   * @default 'http'
   */
  api?: 'rest' | 'http';
  /** Regional ACM certificate for a custom-domain HTTPS listener (same region). */
  certificate?: ICertificate;
  /** The settings the app asks the API Gateway door for. */
  features?: ApiGatewayDoorFeatures<TDomain>;
};

/** A bring-your-own front door. */
export type CustomDoorOptions<TDomain = HostingDomainConfig> = {
  /** BYO — a customer-authored front door. */
  kind: 'custom';
  /**
   * Your front door: `defineFrontDoor({ service, build(scope, input) })`
   * (see {@link FrontDoor}). Hosting provisions the app (S3 assets, compute,
   * backend) and calls `build` ONCE at synth with everything it built (the
   * {@link DoorInput}); `build` creates the door and returns its public
   * `url` (required — a missing `url` fails synth).
   */
  door: FrontDoor;
  /**
   * Check the door's routing after `build`: the static assets must be
   * reachable, and when the app has an API at least one of its paths must
   * reach it — as recorded by the `cf.*` helpers (or `cf.recordWired`).
   * A door that wires correctly with raw CDK and doesn't declare it gets a
   * false alarm; set `false` to turn the check off.
   * @default true
   */
  wiringCheck?: boolean;
  /** The settings the door receives as `input.features` (see {@link CustomDoorFeatures}). */
  features?: CustomDoorFeatures<TDomain>;
};

/**
 * Which front door serves the deploy, with the settings the app asks it for.
 * See `HostingConstructProps.frontDoor`.
 */
export type HostingFrontDoor<TDomain = HostingDomainConfig> =
  | 'cloudfront'
  /**
   * No front door — the app is served DIRECTLY from S3 static-website hosting
   * (public bucket, HTTP-only, no edge, no router). The cheapest option for a
   * pure static site / SPA. There is no front door to route to a backend, so
   * there is no SSR, same-origin API (the client calls the backend
   * cross-origin), image optimization or TLS; an app with a server fails synth
   * (use `'cloudfront'` or `{ kind: 'alb' }`). `s3-website` is the internal
   * mechanism, not a front door. It takes no settings.
   */
  | 'none'
  | CloudFrontDoorOptions<TDomain>
  | AlbDoorOptions<TDomain>
  | ApiGatewayDoorOptions<TDomain>
  | CustomDoorOptions<TDomain>;

// ── Merging the deprecated top-level props into `features` ──────────────────

/** A door kind, as resolved from `frontDoor` (`undefined` / `'cloudfront'` / `{ features }` → `'cloudfront'`). */
export type FrontDoorKind = 'cloudfront' | 'none' | 'alb' | 'apiGateway' | 'custom';

/** Every setting any door kind implements: the effective features, after the merge. */
export type FrontDoorSettings<TDomain = HostingDomainConfig> = CloudFrontDoorFeatures<TDomain>;

/** A setting name inside `features`. */
export type FrontDoorSettingName = keyof FrontDoorSettings;

/**
 * The settings each door kind implements — the single source for the
 * unsupported-setting error, for whether a kind takes a custom domain, and for
 * the table in the module doc. Each list is checked against that kind's
 * `features` type (an entry the type lacks is a compile error; a key the type
 * has but the list misses fails `front_door_options.types.test.ts`).
 */
export const FRONT_DOOR_SETTINGS = {
  cloudfront: [
    'domain',
    'waf',
    'logging',
    'monitoring',
    'skewProtection',
    'priceClass',
    'contentSecurityPolicy',
    'geoRestriction',
    'ssrDefaultTtl',
    'cacheKeyCookies',
    'cacheKeyHeaders',
    'responseHeadersPolicy',
    'quotas',
  ],
  alb: ['domain', 'waf', 'logging', 'monitoring'],
  apiGateway: ['domain'],
  custom: ['domain', 'waf', 'logging', 'monitoring', 'geoRestriction', 'skewProtection'],
  none: [],
} as const satisfies {
  readonly cloudfront: readonly (keyof CloudFrontDoorFeatures)[];
  readonly alb: readonly (keyof AlbDoorFeatures)[];
  readonly apiGateway: readonly (keyof ApiGatewayDoorFeatures)[];
  readonly custom: readonly (keyof CustomDoorFeatures)[];
  readonly none: readonly never[];
};

/** A deprecated top-level prop: its value and the name the app wrote it under (for errors). */
export type FrontDoorAlias<T> = { readonly value: T | undefined; readonly prop: string };

/** The deprecated top-level props, by the `features` setting each one aliases. */
export type FrontDoorAliases<TDomain = HostingDomainConfig> = {
  [K in FrontDoorSettingName]?: FrontDoorAlias<FrontDoorSettings<TDomain>[K]>;
};

/** What {@link resolveFrontDoorFeatures} returns. */
export type ResolvedFrontDoor<TDomain = HostingDomainConfig> = {
  /** The door kind (the stacked door's router resolves to `'alb'`). */
  kind: FrontDoorKind;
  /** The effective settings: `frontDoor.features` plus every alias that was set. */
  features: FrontDoorSettings<TDomain>;
};

/** Options of {@link resolveFrontDoorFeatures}. */
export type ResolveFrontDoorOptions = {
  /**
   * Where the app wrote `features`, for the errors (e.g.
   * `frontDoor.features.router` for the stacked door's router).
   * @default 'frontDoor.features'
   */
  readonly featuresPath?: string;
  /** The door as the app named it, for the errors (e.g. `stacked`). @default the kind */
  readonly label?: string;
};

/** The options each door kind takes besides `kind` and `features` (unknown keys fail synth). */
const DOOR_OPTION_KEYS: Readonly<Record<FrontDoorKind | 'stackedRouter', readonly string[]>> = {
  cloudfront: [],
  none: [],
  alb: ['vpc', 'internal', 'certificate'],
  apiGateway: ['api', 'certificate'],
  custom: ['door', 'wiringCheck'],
  stackedRouter: ['vpc', 'internal', 'certificate'],
};

/** The keys each object-shaped setting takes inside `frontDoor.features` (unknown keys fail synth). */
const SETTING_KEYS: Readonly<Partial<Record<FrontDoorSettingName, readonly string[]>>> = {
  domain: ['domainName', 'hostedZone', 'hostedZoneId', 'certificate', 'wwwRedirect'],
  waf: ['enabled', 'rateLimit', 'webAclArn'],
  logging: ['enabled', 'retentionDays', 'version', 'partitioning', 'format'],
  monitoring: ['enabled', 'subscriptions'],
  skewProtection: ['enabled', 'maxAge'],
  geoRestriction: ['type', 'countries'],
};

const GEO_TYPES: Readonly<Record<string, 'allowlist' | 'denylist'>> = {
  allowlist: 'allowlist',
  whitelist: 'allowlist',
  denylist: 'denylist',
  blacklist: 'denylist',
};

const KNOWN_DOORS =
  "'cloudfront' (default), 'none' (S3 website), { kind: 'alb' }, { kind: 'apiGateway' }, or { kind: 'custom', door }";

/**
 * The resolved kind of a `frontDoor` value (`null` is treated as omitted; the
 * stacked door's router is `'alb'`).
 *
 * @throws HostingError('UnsupportedFrontDoorError') for a value that is not a front door.
 * @internal Framework-only.
 */
export const frontDoorKind = (frontDoor: HostingFrontDoor<unknown> | StackedRouterDoorOptions | null | undefined): FrontDoorKind => {
  if (frontDoor === undefined || frontDoor === null || frontDoor === 'cloudfront') return 'cloudfront';
  if (frontDoor === 'none') return 'none';
  if (typeof frontDoor !== 'object') throw unknownDoor(frontDoor);
  switch (frontDoor.kind) {
    case undefined:
    case 'cloudfront':
      return 'cloudfront';
    case 'alb':
    case 'stackedRouter':
      return 'alb';
    case 'apiGateway':
    case 'custom':
      return frontDoor.kind;
    default:
      throw unknownDoor(frontDoor);
  }
};

const unknownDoor = (frontDoor: unknown): HostingError =>
  new HostingError('UnsupportedFrontDoorError', {
    message: `Unknown front door ${JSON.stringify(frontDoor)}.`,
    resolution:
      `Use ${KNOWN_DOORS}. A door other than 'cloudfront' and 'none' is an object with a \`kind\` ` +
      "(e.g. `{ kind: 'alb' }`, not `'alb'`); kinds are case-sensitive.",
  });

const invalidOption = (message: string, resolution: string): HostingError =>
  new HostingError('InvalidFrontDoorOptionError', { message, resolution });

const unsupported = (kind: FrontDoorKind, label: string, featuresPath: string, prop: string, extra?: string): HostingError =>
  new HostingError('UnsupportedFrontDoorSettingError', {
    message: `\`${prop}\` is not supported by the '${label}' front door${extra ? ` (${extra})` : ''}.`,
    resolution:
      FRONT_DOOR_SETTINGS[kind].length > 0
        ? `Remove \`${prop}\`. The '${label}' front door implements: ` +
          `${FRONT_DOOR_SETTINGS[kind].map((s) => `${featuresPath}.${s}`).join(', ')}.`
        : `Remove \`${prop}\`: the '${label}' front door takes no settings.`,
  });

/**
 * Check the door's own options (everything but `features`): each kind takes
 * only its documented keys, with values of the right shape. Plain JavaScript
 * (or a cast) can pass anything; a typo must fail synth, not deploy a door
 * without the setting.
 *
 * @throws HostingError('InvalidFrontDoorOptionError') naming the option.
 */
const validateDoorOptions = (frontDoor: object, kind: FrontDoorKind, label: string): void => {
  const door = frontDoor as Record<string, unknown>;
  const optionKind = door.kind === 'stackedRouter' ? 'stackedRouter' : kind;
  const allowed = new Set(['kind', 'features', ...DOOR_OPTION_KEYS[optionKind]]);
  for (const key of Object.keys(door)) {
    if (door[key] === undefined || allowed.has(key)) continue;
    throw invalidOption(
      `\`frontDoor.${key}\` is not an option of the '${label}' front door.`,
      DOOR_OPTION_KEYS[optionKind].length > 0
        ? `Remove it. The '${label}' front door takes: ${DOOR_OPTION_KEYS[optionKind].map((k) => `frontDoor.${k}`).join(', ')}, and \`frontDoor.features\`.`
        : `Remove it. The '${label}' front door takes only \`frontDoor.features\`.`,
    );
  }
  if (door.features !== undefined && (door.features === null || typeof door.features !== 'object')) {
    throw invalidOption('`frontDoor.features` must be an object.', 'Pass the settings as `features: { … }`, or omit it.');
  }
  if (door.internal !== undefined && typeof door.internal !== 'boolean') {
    throw invalidOption(`\`frontDoor.internal\` must be true or false (got ${JSON.stringify(door.internal)}).`, 'Pass a boolean.');
  }
  if (door.wiringCheck !== undefined && typeof door.wiringCheck !== 'boolean') {
    throw invalidOption(`\`frontDoor.wiringCheck\` must be true or false (got ${JSON.stringify(door.wiringCheck)}).`, 'Pass a boolean.');
  }
  if (door.api !== undefined && door.api !== 'http' && door.api !== 'rest') {
    throw invalidOption(
      `\`frontDoor.api\` must be 'http' or 'rest' (got ${JSON.stringify(door.api)}).`,
      "Use 'http' (HTTP API, the default) or 'rest' (REST API); the values are lower-case.",
    );
  }
  const certificate = door.certificate as { certificateArn?: unknown } | undefined;
  if (certificate !== undefined && (certificate === null || typeof certificate !== 'object' || certificate.certificateArn === undefined)) {
    throw invalidOption(
      '`frontDoor.certificate` must be an ACM certificate construct, not an ARN string.',
      'Import an existing certificate with `Certificate.fromCertificateArn(scope, id, arn)` (aws-cdk-lib/aws-certificatemanager).',
    );
  }
  if (kind === 'custom' && door.door === undefined) {
    throw new HostingError('InvalidPropsError', {
      message: "`frontDoor: { kind: 'custom' }` has no `door`.",
      resolution: 'Pass the door: `{ kind: \'custom\', door: defineFrontDoor({ service, build }) }`.',
    });
  }
};

/**
 * Check the keys inside `frontDoor.features` settings (`waf`, `logging`, …),
 * and normalize the geo-restriction type. Only `frontDoor.features` is checked
 * for unknown keys; the deprecated top-level props keep their released
 * behavior.
 *
 * @throws HostingError('InvalidFrontDoorSettingError') naming the setting.
 */
const validateSettingKeys = (explicit: Record<string, unknown>, featuresPath: string): void => {
  for (const [name, value] of Object.entries(explicit)) {
    const keys = SETTING_KEYS[name as FrontDoorSettingName];
    if (!keys || value === undefined) continue;
    if (value === null || typeof value !== 'object') {
      throw new HostingError('InvalidFrontDoorSettingError', {
        message: `\`${featuresPath}.${name}\` must be an object.`,
        resolution: `Pass \`${name}: { ${keys.join(', ')} }\`, or omit it.`,
      });
    }
    for (const key of Object.keys(value)) {
      if (keys.includes(key) || (value as Record<string, unknown>)[key] === undefined) continue;
      throw new HostingError('InvalidFrontDoorSettingError', {
        message: `\`${featuresPath}.${name}.${key}\` is not a ${name} setting.`,
        resolution: `Remove it. \`${name}\` takes: ${keys.join(', ')}.`,
      });
    }
  }
};

/**
 * The geo restriction with its type normalized to `'allowlist'` / `'denylist'`.
 *
 * @throws HostingError('InvalidFrontDoorSettingError') for any other type.
 */
const normalizeGeo = (geo: HostingGeoRestriction, prop: string): HostingGeoRestriction => {
  const type = GEO_TYPES[geo.type];
  if (!type) {
    throw new HostingError('InvalidFrontDoorSettingError', {
      message: `\`${prop}.type\` must be 'allowlist' or 'denylist' (got ${JSON.stringify(geo.type)}).`,
      resolution: "Use 'allowlist' (only these countries) or 'denylist' (all but these countries).",
    });
  }
  return { ...geo, type };
};

/**
 * Validate the `frontDoor` prop and merge the deprecated top-level props into
 * the effective `frontDoor.features` — the one place the alias rules live:
 *
 * - `frontDoor` must be a known door: `'cloudfront'`, `'none'`, or an object
 *   whose `kind` is a known kind (`null` is treated as omitted); each kind
 *   takes only its own options, with values of the right shape, and only the
 *   documented keys inside each `features` setting;
 * - a top-level prop that is set is moved to `features.<name>`;
 * - a setting set BOTH top-level and in `frontDoor.features` fails synth
 *   (`FrontDoorSettingConflictError`, naming both);
 * - a setting the chosen kind doesn't implement fails synth
 *   (`UnsupportedFrontDoorSettingError`, naming the kind and the prop) — the
 *   type system can't catch it through a top-level prop.
 *
 * Within a setting, the sub-settings a door doesn't implement fail the same
 * way: `monitoring.subscriptions` on the ALB, `domain.wwwRedirect` on the ALB
 * and API Gateway. A geo restriction's type is normalized to `'allowlist'` /
 * `'denylist'` (the legacy `'whitelist'` / `'blacklist'` map to them).
 *
 * @param frontDoor the `frontDoor` prop.
 * @param aliases the deprecated top-level props, with the names the app wrote them under.
 * @param options where the app wrote `features`, and the door's name, for the errors.
 * @returns the door kind and its effective settings.
 * @throws HostingError('UnsupportedFrontDoorError') when `frontDoor` is not a known door.
 * @throws HostingError('InvalidFrontDoorOptionError') for an unknown or mistyped door option.
 * @throws HostingError('InvalidFrontDoorSettingError') for an unknown key inside a setting, or an unknown geo type.
 * @throws HostingError('FrontDoorSettingConflictError') when a setting is set twice.
 * @throws HostingError('UnsupportedFrontDoorSettingError') when the kind doesn't implement a setting.
 * @internal Framework-only: the merge `HostingConstruct` and the `@aws-blocks/core` `Hosting` share.
 */
export function resolveFrontDoorFeatures<TDomain>(
  frontDoor: HostingFrontDoor<TDomain> | StackedRouterDoorOptions | null | undefined,
  aliases: FrontDoorAliases<TDomain>,
  options: ResolveFrontDoorOptions = {},
): ResolvedFrontDoor<TDomain> {
  const kind = frontDoorKind(frontDoor);
  const label = options.label ?? KIND_LABEL[kind];
  const featuresPath = options.featuresPath ?? 'frontDoor.features';
  if (typeof frontDoor === 'object' && frontDoor !== null) validateDoorOptions(frontDoor, kind, label);
  const supported = new Set<string>(FRONT_DOOR_SETTINGS[kind]);
  // Each kind's `features` is a subset of the settings (the `domain` of the
  // ALB and API Gateway without `wwwRedirect`, the ALB's `monitoring` without
  // `subscriptions`).
  const explicit = (
    typeof frontDoor === 'object' && frontDoor !== null && frontDoor.features ? { ...frontDoor.features } : {}
  ) as FrontDoorSettings<TDomain>;
  const features: { -readonly [K in FrontDoorSettingName]?: FrontDoorSettings<TDomain>[K] } = { ...explicit };

  // A setting the kind doesn't implement can only get into `features` with a
  // cast (or from JavaScript); reject it the same way as an alias.
  for (const name of Object.keys(explicit)) {
    if (explicit[name as FrontDoorSettingName] !== undefined && !supported.has(name)) {
      throw unsupported(kind, label, featuresPath, `${featuresPath}.${name}`);
    }
  }
  validateSettingKeys(explicit, featuresPath);

  for (const name of Object.keys(aliases) as FrontDoorSettingName[]) {
    const alias = aliases[name];
    if (!alias || alias.value === undefined) continue;
    if (explicit[name] !== undefined) {
      throw new HostingError('FrontDoorSettingConflictError', {
        message: `\`${alias.prop}\` and \`${featuresPath}.${name}\` are both set. They are the same setting.`,
        resolution: `Keep \`${featuresPath}.${name}\` and remove \`${alias.prop}\` (deprecated).`,
      });
    }
    if (!supported.has(name)) throw unsupported(kind, label, featuresPath, alias.prop);
    Object.assign(features, { [name]: alias.value });
  }

  // Sub-settings a door doesn't implement.
  const propOf = (name: FrontDoorSettingName): string =>
    explicit[name] !== undefined ? `${featuresPath}.${name}` : (aliases[name]?.prop ?? name);
  if (kind === 'alb' && features.monitoring?.subscriptions && features.monitoring.subscriptions.length > 0) {
    throw unsupported(kind, label, featuresPath, `${propOf('monitoring')}.subscriptions`, 'its alarms have no subscriptions; only `enabled` applies');
  }
  const domain = features.domain as { wwwRedirect?: string } | undefined;
  if ((kind === 'apiGateway' || kind === 'alb') && domain?.wwwRedirect !== undefined && domain.wwwRedirect !== 'none') {
    throw unsupported(kind, label, featuresPath, `${propOf('domain')}.wwwRedirect`);
  }
  if (features.geoRestriction) features.geoRestriction = normalizeGeo(features.geoRestriction, propOf('geoRestriction'));

  return { kind, features };
}

const KIND_LABEL: Record<FrontDoorKind, string> = {
  cloudfront: 'cloudfront',
  none: 'none',
  alb: 'alb',
  apiGateway: 'apiGateway',
  custom: 'custom',
};
