/**
 * The layer-render contract (Commit 2 of the composable-front-door work).
 *
 * Today a {@link FrontDoorAdapter} returns only a public URL (`FrontDoorResult`).
 * A URL is a fine ADDRESS but not an ATTACH POINT: to put one layer in front of
 * another (CloudFront edge → ALB router → origin), the parent must point its
 * origin at the child, and for that it needs a handle — a hostname (or, later, a
 * VPC-origin target), not a bare string. This adds that seam.
 *
 * `renderLayer` builds the same construct as `render` and returns a
 * {@link LayerHandle}: the public `url` (set only on the ROOT layer) PLUS an
 * {@link OriginHandle} a parent layer can attach to. `render` delegates to it, so
 * a single layer renders byte-identically — nothing is stacked yet (the graph
 * renderer that consumes `originHandle` arrives in a later commit).
 *
 * These types are CDK-aware (constructs layer) — unlike the service-neutral
 * `plan/` layer, an attach handle inevitably references the concrete edge/origin.
 */
import type { Construct } from 'constructs';
import type { AdapterContext, CapabilityId, CapabilityPlan, SupportTier } from '../plan/types.js';

/**
 * How a PARENT layer attaches to this layer as an origin. Minimal by design: a
 * hostname + protocol covers the common HTTP(S)-origin attach (an ALB DNS name,
 * an API Gateway host, a CloudFront domain, an S3-website endpoint). It is
 * extended (e.g. with a VPC-origin target for a private ALB) when a consumer that
 * needs more actually exists — an attach handle with no caller is a guess.
 */
export type OriginHandle = {
  /** Hostname WITHOUT scheme that a parent points an HTTP(S) origin at. */
  domainName: string;
  /** Origin protocol — `http` for the S3-website endpoint, `https` otherwise. */
  protocol: 'http' | 'https';
};

/** What a rendered layer exposes upward. */
export type LayerHandle = {
  /** The deploy's public URL — set ONLY on the root (outermost) layer. */
  url?: string;
  /** How a parent layer attaches to this layer (see {@link OriginHandle}). */
  originHandle: OriginHandle;
};

/**
 * The layer-render seam every front-door service implements. `renderLayer`
 * materializes THIS layer and returns a {@link LayerHandle} a parent can attach
 * to. A one-layer graph (today's doors) renders identically to the current
 * `FrontDoorAdapter.render`; nesting is the graph renderer's job (later commit).
 */
export interface FrontDoorLayerAdapter {
  /** Stable service id (`cloudfront` | `alb` | `api-gateway` | `s3-website`). */
  readonly service: string;
  /** Declare how well this service supports a capability (same matrix as `render`). */
  supports(capability: CapabilityId): SupportTier;
  /** Materialize this layer and return an attach handle. */
  renderLayer(scope: Construct, plan: CapabilityPlan, ctx: AdapterContext): LayerHandle;
}
