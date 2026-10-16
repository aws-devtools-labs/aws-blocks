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
 * | `domain` | ✓ | – (use `certificate`) | ✓ (no `wwwRedirect`) | ✓ |
 * | `waf` | ✓ (CLOUDFRONT scope) | ✓ (REGIONAL scope) | – | ✓ |
 * | `logging` | ✓ | ✓ | – | ✓ |
 * | `monitoring` | ✓ | ✓ (`enabled` only) | – | ✓ |
 * | `skewProtection` | ✓ | – | – | ✓ (as `app.skew`) |
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
import type { AccessLogFormat, AccessLogPartitioning } from './access_logging.js';
import type { DoorInput, FrontDoor } from './front_door.js';
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

/** Geo restriction: the country codes to allow (`whitelist`) or deny (`blacklist`). */
export type HostingGeoRestriction = {
  type: 'whitelist' | 'blacklist';
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
 * Settings the ALB door implements. It has no edge: no custom-domain records
 * (give the door a regional `certificate` and point your DNS at the ALB), geo
 * restriction, price class, CSP header or skew protection.
 */
export type AlbDoorFeatures = {
  /**
   * A REGIONAL web ACL on the load balancer: a rate-limited one built for you
   * (`enabled`), or yours (`webAclArn`, a REGIONAL ACL in the stack's region).
   */
  waf?: HostingWafConfig;
  /** The ALB's own access logs (a dedicated bucket), plus the asset bucket's access logs. */
  logging?: HostingLoggingConfig;
  /**
   * Alarms on the ALB's own metrics (5xx count, target response time). The ALB
   * door does not subscribe endpoints to them, so only `enabled` applies.
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
 * {@link DoorInput} (`input.features`, plus `input.app` for `wwwRedirect` and
 * skew), under these names:
 *
 * | `features.` | reaches the door as |
 * | --- | --- |
 * | `domain` | `features.customDomain` (`names`, `certificate`, `hostedZone`); `domain.wwwRedirect` → `app.wwwRedirect` |
 * | `waf` | `features.waf` (`webAclArn`, `rateLimit`) |
 * | `logging` | `features.logging` (`retentionDays`), when `enabled` |
 * | `monitoring` | `features.alarms` (`subscriptions`), unless `enabled: false` |
 * | `geoRestriction` | `features.geo` (`allow` for `whitelist`, `deny` for `blacklist`) |
 * | `skewProtection` | `app.skew` (`maxAge`), unless `enabled: false` |
 *
 * AWS Blocks does not check that the door applies them.
 */
export type CustomDoorFeatures<TDomain = HostingDomainConfig> = {
  /** Custom domain(s) → `input.features.customDomain` (and `domain.wwwRedirect` → `input.app.wwwRedirect`). */
  domain?: TDomain;
  /** Request filtering → `input.features.waf`. */
  waf?: HostingWafConfig;
  /** Access logging → `input.features.logging` (also the asset bucket's access logs). */
  logging?: HostingLoggingConfig;
  /** Alarms → `input.features.alarms`. */
  monitoring?: HostingMonitoringConfig;
  /** Geo restriction → `input.features.geo`. */
  geoRestriction?: HostingGeoRestriction;
  /** Skew protection → `input.app.skew`. @default \{ enabled: true \} */
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
  /** The ALB router behind the edge: the {@link AlbDoorFeatures}. */
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

/** An Application Load Balancer door (regional, no CDN). */
export type AlbDoorOptions = {
  kind: 'alb';
  /** BYO VPC; a default 2-AZ VPC is created when omitted. */
  vpc?: IVpc;
  /** Internal (private) ALB vs internet-facing. Default: internet-facing. */
  internal?: boolean;
  /** Regional ACM certificate for an HTTPS listener (same region as the ALB). */
  certificate?: ICertificate;
  /**
   * Backend API Gateway URL to proxy same-origin (`/aws-blocks/*`) through
   * the ALB via a Lambda target. Set by the Blocks integration layer from
   * the `api` prop; enables cookie auth with no CORS.
   */
  backendApiUrl?: string;
  /**
   * Extra path patterns that must reach the backend (the backend's raw
   * routes), beyond `/aws-blocks/*`. Set by the Blocks integration layer;
   * each gets a listener rule to the API forwarder.
   */
  backendApiPaths?: string[];
  /** The settings the app asks the ALB door for. */
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
  /**
   * Backend API URL to proxy same-origin (`/aws-blocks/*`) through the
   * gateway. Set by the Blocks integration layer from the `api` prop;
   * enables cookie auth with no CORS. API Gateway proxies an external
   * HTTPS URL natively — no forwarder Lambda (unlike the ALB door).
   */
  backendApiUrl?: string;
  /**
   * Extra path patterns that must reach the backend (the backend's raw
   * routes), beyond `/aws-blocks/*`. Set by the Blocks integration layer;
   * each gets a route proxied to the same path on the backend.
   */
  backendApiPaths?: string[];
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
  /**
   * Backend API URL to proxy same-origin (`/aws-blocks/*`). Set by the
   * Blocks integration layer from the `api` prop; surfaces as
   * `input.origins.api`.
   */
  backendApiUrl?: string;
  /**
   * Extra path patterns that must reach the backend (the backend's raw
   * routes), beyond `/aws-blocks/*`. Set by the Blocks integration layer;
   * surfaces in `input.origins.api.paths`.
   */
  backendApiPaths?: string[];
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
  | AlbDoorOptions
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
 * unsupported-setting error (and the table in the module doc).
 */
export const FRONT_DOOR_SETTINGS: Readonly<Record<FrontDoorKind, readonly FrontDoorSettingName[]>> = {
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
  alb: ['waf', 'logging', 'monitoring'],
  apiGateway: ['domain'],
  custom: ['domain', 'waf', 'logging', 'monitoring', 'geoRestriction', 'skewProtection'],
  none: [],
};

/** A deprecated top-level prop: its value and the name the app wrote it under (for errors). */
export type FrontDoorAlias<T> = { readonly value: T | undefined; readonly prop: string };

/** The deprecated top-level props, by the `features` setting each one aliases. */
export type FrontDoorAliases<TDomain = HostingDomainConfig> = {
  [K in FrontDoorSettingName]?: FrontDoorAlias<FrontDoorSettings<TDomain>[K]>;
};

/** What {@link resolveFrontDoorFeatures} returns. */
export type ResolvedFrontDoor<TDomain = HostingDomainConfig> = {
  /** The door kind. */
  kind: FrontDoorKind;
  /** The effective settings: `frontDoor.features` plus every alias that was set. */
  features: FrontDoorSettings<TDomain>;
};

/** The resolved kind of a `frontDoor` value. */
export const frontDoorKind = (frontDoor: HostingFrontDoor<unknown> | undefined): FrontDoorKind => {
  if (frontDoor === undefined || frontDoor === 'cloudfront') return 'cloudfront';
  if (frontDoor === 'none') return 'none';
  return frontDoor.kind ?? 'cloudfront';
};

const KIND_LABEL: Record<FrontDoorKind, string> = {
  cloudfront: 'cloudfront',
  none: 'none',
  alb: 'alb',
  apiGateway: 'apiGateway',
  custom: 'custom',
};

const unsupported = (kind: FrontDoorKind, prop: string, extra?: string): HostingError =>
  new HostingError('UnsupportedFrontDoorSettingError', {
    message: `\`${prop}\` is not supported by the '${KIND_LABEL[kind]}' front door${extra ? ` (${extra})` : ''}.`,
    resolution:
      FRONT_DOOR_SETTINGS[kind].length > 0
        ? `Remove \`${prop}\`. The '${KIND_LABEL[kind]}' front door implements: ` +
          `${FRONT_DOOR_SETTINGS[kind].map((s) => `frontDoor.features.${s}`).join(', ')}.`
        : `Remove \`${prop}\`: the '${KIND_LABEL[kind]}' front door takes no settings.`,
  });

/**
 * Merge the deprecated top-level props into the effective `frontDoor.features`
 * — the one place the alias rules live:
 *
 * - a top-level prop that is set is moved to `features.<name>`;
 * - a setting set BOTH top-level and in `frontDoor.features` fails synth
 *   (`FrontDoorSettingConflictError`, naming both);
 * - a setting the chosen kind doesn't implement fails synth
 *   (`UnsupportedFrontDoorSettingError`, naming the kind and the prop) — the
 *   type system can't catch it through a top-level prop.
 *
 * Within a setting, the sub-settings a door doesn't implement fail the same
 * way: `monitoring.subscriptions` on the ALB, `domain.wwwRedirect` on API
 * Gateway.
 *
 * @param frontDoor the `frontDoor` prop.
 * @param aliases the deprecated top-level props, with the names the app wrote them under.
 * @returns the door kind and its effective settings.
 * @throws HostingError('FrontDoorSettingConflictError') when a setting is set twice.
 * @throws HostingError('UnsupportedFrontDoorSettingError') when the kind doesn't implement a setting.
 * @internal Framework-only.
 */
export function resolveFrontDoorFeatures<TDomain>(
  frontDoor: HostingFrontDoor<TDomain> | undefined,
  aliases: FrontDoorAliases<TDomain>,
): ResolvedFrontDoor<TDomain> {
  const kind = frontDoorKind(frontDoor);
  const supported = new Set<string>(FRONT_DOOR_SETTINGS[kind]);
  // Each kind's `features` is a subset of the settings (API Gateway's `domain`
  // without `wwwRedirect`, the ALB's `monitoring` without `subscriptions`).
  const explicit = (
    typeof frontDoor === 'object' && frontDoor.features ? { ...frontDoor.features } : {}
  ) as FrontDoorSettings<TDomain>;
  const features: { -readonly [K in FrontDoorSettingName]?: FrontDoorSettings<TDomain>[K] } = { ...explicit };

  // A setting the kind doesn't implement can only get into `features` with a
  // cast (or from JavaScript); reject it the same way as an alias.
  for (const name of Object.keys(explicit)) {
    if (explicit[name as FrontDoorSettingName] !== undefined && !supported.has(name)) {
      throw unsupported(kind, `frontDoor.features.${name}`);
    }
  }

  for (const name of Object.keys(aliases) as FrontDoorSettingName[]) {
    const alias = aliases[name];
    if (!alias || alias.value === undefined) continue;
    if (explicit[name] !== undefined) {
      throw new HostingError('FrontDoorSettingConflictError', {
        message: `\`${alias.prop}\` and \`frontDoor.features.${name}\` are both set. They are the same setting.`,
        resolution: `Keep \`frontDoor.features.${name}\` and remove \`${alias.prop}\` (deprecated).`,
      });
    }
    if (!supported.has(name)) throw unsupported(kind, alias.prop);
    Object.assign(features, { [name]: alias.value });
  }

  // Sub-settings a door doesn't implement.
  const propOf = (name: FrontDoorSettingName): string =>
    explicit[name] !== undefined ? `frontDoor.features.${name}` : (aliases[name]?.prop ?? name);
  if (kind === 'alb' && features.monitoring?.subscriptions && features.monitoring.subscriptions.length > 0) {
    throw unsupported(kind, `${propOf('monitoring')}.subscriptions`, 'its alarms have no subscriptions; only `enabled` applies');
  }
  const domain = features.domain as { wwwRedirect?: string } | undefined;
  if (kind === 'apiGateway' && domain?.wwwRedirect !== undefined && domain.wwwRedirect !== 'none') {
    throw unsupported(kind, `${propOf('domain')}.wwwRedirect`);
  }

  return { kind, features };
}
