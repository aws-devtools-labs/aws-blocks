// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Assembling the {@link DoorInput} — what AWS Blocks hands a front door.
 *
 * The app facts come from the {@link CapabilityPlan} (the neutral route table
 * built from the framework's build output) and the `Hosting` props; the
 * origins are the resources `HostingConstruct` already provisioned. Building
 * the input has no side effects on the template: the server's Function URL is
 * created only if a door reads `origins.server.url`.
 *
 * @internal Framework-only.
 */
import { Fn } from 'aws-cdk-lib';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { FunctionUrlAuthType, type IFunction, type IFunctionUrl, InvokeMode } from 'aws-cdk-lib/aws-lambda';
import { HostedZone, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { ITopicSubscription } from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import type { CapabilityPlan } from '../plan/types.js';
import type {
  ApiOrigin,
  AssetsOrigin,
  DoorFeatures,
  DoorInput,
  DoorOrigin,
  DoorRoute,
  ImageOrigin,
  ServerOrigin,
} from './front_door.js';

/** The backend's reserved RPC + sign-in subtree (`/aws-blocks/*`). */
export const BLOCKS_API_SUBTREE = '/aws-blocks/*';
/** The auth Building Block's sign-in subtree (`/aws-blocks/auth/*`). */
export const BLOCKS_AUTH_SUBTREE = '/aws-blocks/auth/*';

/** A Lambda function that can carry a Function URL (any regional function). */
type UrlCapableFunction = IFunction & {
  addFunctionUrl(options: { authType: FunctionUrlAuthType; invokeMode?: InvokeMode }): IFunctionUrl;
};

const canAddFunctionUrl = (fn: IFunction): fn is UrlCapableFunction =>
  typeof (fn as { addFunctionUrl?: unknown }).addFunctionUrl === 'function';

/** Inputs to {@link buildDoorInput}: the plan, the provisioned resources, and the feature props. */
export type BuildDoorInputParams = {
  plan: CapabilityPlan;
  /** The private assets bucket. */
  bucket: IBucket;
  /** The local static build output directory. */
  staticDir: string;
  /** The server-rendering compute, when there is a regional one. */
  server?: { fn: IFunction; url?: IFunctionUrl; streaming: boolean };
  /** The image-optimization compute, when there is one with a Function URL. */
  image?: { fn: IFunction; url: IFunctionUrl };
  /** The backend API, when `Hosting` was given one. */
  api?: { url: string; paths?: readonly string[] };
  /** Feature settings straight from the `Hosting` props. */
  domain?: {
    domainName: string | string[];
    hostedZone?: string;
    hostedZoneId?: string;
    certificate?: ICertificate;
  };
  waf?: { enabled: boolean; rateLimit?: number; webAclArn?: string };
  /** `cdn.webAclArn` (the legacy location of a BYO web ACL). */
  cdnWebAclArn?: string;
  logging?: { enabled: boolean; retentionDays?: number };
  monitoring?: { enabled?: boolean; subscriptions?: readonly ITopicSubscription[] };
  geoRestriction?: { type: 'whitelist' | 'blacklist'; countries: string[] };
  errorPages?: { notFound?: string; serverError?: string };
  skewProtection?: { enabled: boolean; maxAge?: number };
};

/** Default skew-protection window (seconds) — matches `skewProtection.maxAge`'s default. */
const DEFAULT_SKEW_MAX_AGE = 86400;

/**
 * Split an API URL (`https://{host}/{stage}/…`) into its host and stage path,
 * in-template (the URL is a CDK token).
 */
const apiHostAndStage = (url: string): { host: string; stagePath: string } => {
  const withoutScheme = Fn.select(1, Fn.split('https://', Fn.select(0, Fn.split('/aws-blocks/api', url))));
  return {
    host: Fn.select(0, Fn.split('/', withoutScheme)),
    stagePath: `/${Fn.select(1, Fn.split('/', withoutScheme))}`,
  };
};

/**
 * Assemble the {@link DoorInput} for this deploy (see the module doc).
 *
 * @param scope the scope to import a BYO hosted zone under (no resources are created).
 * @param params the plan, the provisioned resources, and the feature props.
 * @returns the door input. Each origin object is fresh, so a wiring record can key on it.
 */
export function buildDoorInput(scope: Construct, params: BuildDoorInputParams): DoorInput {
  const { plan } = params;
  const buildId = plan.release.buildId;

  // ── Origins ──
  const assets: AssetsOrigin = {
    kind: 'assets',
    bucket: params.bucket,
    prefix: `builds/${buildId}/`,
    sourceDir: params.staticDir,
  };

  let server: ServerOrigin | undefined;
  if (params.server) {
    const { fn, streaming } = params.server;
    let url = params.server.url;
    server = {
      kind: 'server',
      fn,
      streaming,
      // Created on first read only: the built-in doors reach the server another
      // way (REST API, ALB target, API Gateway integration) and never read it.
      get url(): IFunctionUrl {
        if (!url) {
          if (!canAddFunctionUrl(fn)) {
            throw new Error('origins.server.url: the server function cannot carry a Function URL.');
          }
          url = fn.addFunctionUrl({
            authType: FunctionUrlAuthType.AWS_IAM,
            invokeMode: streaming ? InvokeMode.RESPONSE_STREAM : InvokeMode.BUFFERED,
          });
        }
        return url;
      },
    };
  }

  const imageRoute = plan.routes.entries.find((e) => e.kind === 'image');
  const image: ImageOrigin | undefined = params.image
    ? {
        kind: 'image',
        fn: params.image.fn,
        url: params.image.url,
        pathPrefix:
          plan.policies.imagePrefix ?? (imageRoute ? imageRoute.pattern.replace(/\/?\*$/, '') : '/_next/image'),
      }
    : undefined;

  const api: ApiOrigin | undefined = params.api
    ? {
        kind: 'api',
        url: params.api.url,
        ...apiHostAndStage(params.api.url),
        paths: [...new Set([BLOCKS_API_SUBTREE, ...(params.api.paths ?? [])])],
        authPaths: [BLOCKS_AUTH_SUBTREE],
      }
    : undefined;

  // ── App facts ──
  const originFor: Record<'static' | 'server' | 'image', DoorOrigin | undefined> = {
    static: assets,
    server,
    image,
  };
  const routes: DoorRoute[] = [];
  for (const entry of plan.routes.entries) {
    const origin = originFor[entry.kind];
    if (origin) routes.push({ pattern: entry.pattern, origin });
  }

  const skewEnabled = params.skewProtection?.enabled ?? true;
  const wwwRedirect = plan.policies.wwwRedirect;

  // ── Features (present only when asked for) ──
  const features: {
    -readonly [K in keyof DoorFeatures]: DoorFeatures[K];
  } = {};
  if (params.domain) {
    const names = Array.isArray(params.domain.domainName) ? params.domain.domainName : [params.domain.domainName];
    const { hostedZoneId, hostedZone: zoneName, certificate } = params.domain;
    const customDomain: { names: string[]; certificate?: ICertificate; readonly hostedZone?: IHostedZone } = {
      names,
      ...(certificate ? { certificate } : {}),
    };
    if (hostedZoneId) {
      // Imported on first read only (an import creates no resources, but keeps
      // the construct tree of a door that never reads it unchanged).
      let zone: IHostedZone | undefined;
      Object.defineProperty(customDomain, 'hostedZone', {
        enumerable: true,
        get: (): IHostedZone => {
          zone ??= HostedZone.fromHostedZoneAttributes(scope, 'DoorHostedZone', {
            hostedZoneId,
            zoneName: zoneName ?? names[0] ?? '',
          });
          return zone;
        },
      });
    }
    features.customDomain = customDomain;
  }
  const webAclArn = params.waf?.webAclArn ?? params.cdnWebAclArn;
  if (params.waf?.enabled || webAclArn) {
    features.waf = {
      ...(webAclArn ? { webAclArn } : {}),
      ...(params.waf?.rateLimit !== undefined ? { rateLimit: params.waf.rateLimit } : {}),
    };
  }
  if (params.logging?.enabled) {
    features.logging = params.logging.retentionDays !== undefined ? { retentionDays: params.logging.retentionDays } : {};
  }
  if (params.monitoring && params.monitoring.enabled !== false) {
    features.alarms = params.monitoring.subscriptions ? { subscriptions: params.monitoring.subscriptions } : {};
  }
  if (params.geoRestriction) {
    const { type, countries } = params.geoRestriction;
    features.geo = type === 'whitelist' ? { allow: countries } : { deny: countries };
  }

  return {
    app: {
      buildId,
      ...(plan.policies.basePath ? { basePath: plan.policies.basePath } : {}),
      ...(plan.policies.assetPrefix ? { assetPrefix: plan.policies.assetPrefix } : {}),
      spaFallback: plan.policies.spaFallback,
      routes,
      redirects: plan.routes.redirects,
      headers: plan.routes.headers,
      ...(params.errorPages && (params.errorPages.notFound || params.errorPages.serverError)
        ? {
            errorPages: {
              ...(params.errorPages.notFound ? { notFound: '404.html' } : {}),
              ...(params.errorPages.serverError ? { serverError: '500.html' } : {}),
            },
          }
        : {}),
      ...(wwwRedirect && wwwRedirect !== 'none' ? { wwwRedirect } : {}),
      ...(skewEnabled ? { skew: { maxAge: params.skewProtection?.maxAge ?? DEFAULT_SKEW_MAX_AGE } } : {}),
    },
    origins: {
      assets,
      ...(server ? { server } : {}),
      ...(image ? { image } : {}),
      ...(api ? { api } : {}),
    },
    features,
  };
}
