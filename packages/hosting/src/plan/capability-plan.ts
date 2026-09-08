/**
 * `buildCapabilityPlan` — the service-agnostic core.
 *
 * Turns a framework-agnostic {@link DeployManifest} into a {@link CapabilityPlan}
 * (origins + route table + policies + release) with ZERO service vocabulary. A
 * front-door adapter (CloudFront, ALB, …) consumes the plan and renders it.
 *
 * This is the generalization of the routing/origin/policy computation that today
 * lives inside the CloudFront construct: the same inputs, lifted above any single
 * front door. It imports no `aws-cdk-lib` and no service SDK.
 */
import type { DeployManifest } from '../manifest/types.js';
import { normalizeBasePath, prependBasePath } from '../adapters/shared/basepath.js';
import { buildRouteTable } from './route-table.js';
import type { BackendOrigin, CapabilityPlan, HeaderRule, Origin, RedirectRule } from './types.js';

/** Stable origin ids shared by every renderer (a CloudFront behavior, an ALB target, …). */
export const ORIGIN_IDS = {
  static: 'blocks-s3',
  server: 'blocks-server',
  image: 'blocks-image',
} as const;

/** Inputs to {@link buildCapabilityPlan}. All service-agnostic. */
export type BuildCapabilityPlanInput = {
  manifest: DeployManifest;
  buildId: string;
  /** Whether the deploy has a server (compute) origin. */
  hasServer: boolean;
  /** Whether an image-optimization origin exists. */
  hasImage: boolean;
  /** apex/www canonical-redirect mode (from the Hosting `domain` config). */
  wwwRedirect?: 'toApex' | 'toWww' | 'none';
  /** Whether cookie-based skew protection is enabled. */
  skewEnabled?: boolean;
  /**
   * Compute names that are Lambda@Edge route functions (OpenNext `runtime:
   * 'edge'`). Excluded from the route table (they get a dedicated behavior).
   */
  edgeTargets?: Set<string>;
  /**
   * Backend/API ingresses the front door should route to same-origin (each
   * namespace → its owning compute). Omit for cross-origin (the client reaches
   * the backend via `BLOCKS_API_URL`). A single `{ namespace: '*' }` entry is
   * the common single-compute same-origin case. See {@link BackendPlan}.
   */
  backendOrigins?: BackendOrigin[];
  /** The app needs backend requests longer than a router's short timeout (agent loops, big jobs). */
  backendNeedsLongRequests?: boolean;
  /** The app needs backend payloads above a router's size cap (large uploads/downloads). */
  backendNeedsLargePayloads?: boolean;
};

const normalizePattern = (pattern: string, basePath?: string): string => {
  const p = pattern.startsWith('/') ? pattern : `/${pattern}`;
  return prependBasePath(basePath, p);
};

/**
 * Build the service-agnostic {@link CapabilityPlan} from a manifest.
 *
 * The plan captures the same routing/origin/policy decisions the CloudFront
 * construct makes today, but in neutral form: any adapter can render it. The
 * route entries come from {@link buildRouteTable} (shared with the CloudFront
 * KVS renderer, so classification/coalescing/ordering stay in one place).
 */
export const buildCapabilityPlan = (input: BuildCapabilityPlanInput): CapabilityPlan => {
  const { manifest, buildId, hasServer, hasImage } = input;
  const basePath = manifest.basePath ? normalizeBasePath(manifest.basePath) : undefined;
  const imagePrefix = hasImage ? manifest.imageOptimization?.baseURL : undefined;

  // ── Origins ──
  const origins: Origin[] = [{ id: ORIGIN_IDS.static, kind: 'static' }];
  if (hasServer) origins.push({ id: ORIGIN_IDS.server, kind: 'server' });
  if (hasImage) origins.push({ id: ORIGIN_IDS.image, kind: 'image' });

  // ── Route table (entries + redirects + headers), basePath-resolved ──
  const entries = buildRouteTable({
    manifest,
    hasServer,
    hasImage,
    imagePrefix,
    basePath,
    edgeTargets: input.edgeTargets,
    isrActive: hasServer && manifest.cache !== undefined,
  });

  const redirects: RedirectRule[] = (manifest.redirects ?? []).map((r) => ({
    source: prependBasePath(basePath, r.source),
    destination: prependBasePath(basePath, r.destination),
    statusCode: r.statusCode,
  }));

  const headers: HeaderRule[] = (manifest.headers ?? []).map((h) => ({
    pattern: normalizePattern(h.source, basePath),
    headers: h.headers,
  }));

  // ── Backend/API routing (same-origin only; undefined = cross-origin) ──
  const backend =
    input.backendOrigins && input.backendOrigins.length > 0
      ? {
          origins: input.backendOrigins,
          needsLongRequests: input.backendNeedsLongRequests === true,
          needsLargePayloads: input.backendNeedsLargePayloads === true,
        }
      : undefined;

  return {
    origins,
    routes: { entries, redirects, headers },
    policies: {
      basePath,
      assetPrefix: manifest.assetPrefix,
      imagePrefix,
      spaFallback: manifest.staticAssets.spaFallback === true,
      hasServer,
      wwwRedirect: input.wwwRedirect,
      skewEnabled: input.skewEnabled === true,
    },
    release: { buildId },
    ...(backend ? { backend } : {}),
  };
};
