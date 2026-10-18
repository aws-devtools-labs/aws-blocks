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
import { FunctionUrlAuthType, type IFunction, type IFunctionUrl, InvokeMode } from 'aws-cdk-lib/aws-lambda';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { CapabilityPlan } from '../plan/types.js';
import type { FrontDoorSettings } from './front_door_options.js';
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
  errorPages?: { notFound?: string; serverError?: string };
} & DoorFeatureSettings;

/**
 * The door's effective settings (`frontDoor.features` merged with the
 * deprecated top-level aliases) that a door receives as {@link DoorFeatures}
 * (see {@link toDoorFeatures}).
 */
export type DoorFeatureSettings = Pick<
  FrontDoorSettings,
  'domain' | 'waf' | 'logging' | 'monitoring' | 'geoRestriction' | 'skewProtection'
> & {
  /** `cdn.webAclArn` (the legacy location of a BYO web ACL); `waf.webAclArn` wins. */
  cdnWebAclArn?: string;
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
 * @param params the plan, the provisioned resources, and the feature props.
 * @returns the door input. Each origin object is fresh, so a wiring record can key on it.
 */
export function buildDoorInput(params: BuildDoorInputParams): DoorInput {
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

  const image: ImageOrigin | undefined = params.image
    ? {
        kind: 'image',
        fn: params.image.fn,
        url: params.image.url,
      }
    : undefined;

  const api: ApiOrigin | undefined = params.api
    ? {
        kind: 'api',
        url: params.api.url,
        ...apiHostAndStage(params.api.url),
        paths: [...new Set([BLOCKS_API_SUBTREE, ...(params.api.paths ?? [])])],
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

  const features = toDoorFeatures(params);

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

/**
 * The {@link DoorFeatures} a door receives: its settings under their
 * `frontDoor.features` names and shapes, keeping only what the app asked for
 * (see {@link DoorFeatures} for when each one is present). The legacy
 * `cdn.webAclArn` is folded into `waf.webAclArn` (`waf.webAclArn` wins), and
 * skew protection's `maxAge` default is resolved.
 *
 * @param settings the door's effective settings.
 * @returns the features; a field is present only when the app asked for it.
 * @internal Framework-only.
 */
export function toDoorFeatures(settings: DoorFeatureSettings): DoorFeatures {
  const features: {
    -readonly [K in keyof DoorFeatures]: DoorFeatures[K];
  } = {};
  if (settings.domain) {
    const { wwwRedirect, ...domain } = settings.domain;
    features.domain = wwwRedirect && wwwRedirect !== 'none' ? { ...domain, wwwRedirect } : domain;
  }
  const webAclArn = settings.waf?.webAclArn ?? settings.cdnWebAclArn;
  if (settings.waf?.enabled || webAclArn) {
    features.waf = {
      enabled: settings.waf?.enabled ?? false,
      ...(webAclArn ? { webAclArn } : {}),
      ...(settings.waf?.rateLimit !== undefined ? { rateLimit: settings.waf.rateLimit } : {}),
    };
  }
  if (settings.logging?.enabled) features.logging = settings.logging;
  if (settings.monitoring && settings.monitoring.enabled !== false) features.monitoring = settings.monitoring;
  if (settings.geoRestriction) features.geoRestriction = settings.geoRestriction;
  if (settings.skewProtection?.enabled ?? true) {
    features.skewProtection = { enabled: true, maxAge: settings.skewProtection?.maxAge ?? DEFAULT_SKEW_MAX_AGE };
  }
  return features;
}
