/**
 * CloudFront front door, defined with hooks — the full-feature default door.
 *
 * It defines every feature hook and `route` reports every routing-level
 * capability (streaming SSR, image optimization, redirects, error pages, edge
 * caching, response headers, atomic release, session pinning), so CloudFront
 * delivers the whole capability vocabulary.
 *
 * {@link CdnConstruct} is one construct built around its behaviors, so the hooks
 * split its props: `route` carries the routing inputs, and each feature hook
 * adds ONLY its own props (`customDomain` → certificate + aliases, `waf` → the
 * web ACL, `restrictGeo` → geo restriction, `accessLogs` → the log bucket). A
 * feature whose hook isn't called (the app didn't demand it) is never passed to
 * the construct. `handle` materializes the distribution.
 */
import type { Construct } from 'constructs';
import type { AdapterContext } from '../plan/types.js';
import { CdnConstruct, type CdnConstructProps } from './cdn_construct.js';
import { defineFrontDoor } from './door_hooks.js';

/**
 * Context the CloudFront door needs beyond the neutral plan: the CDK handles the
 * plan cannot carry (the assets bucket, compute functions, certificate, WAF, …)
 * — exactly the {@link CdnConstruct} props.
 */
export type CloudFrontRenderContext = AdapterContext & {
  /** The underlying CloudFront construct props (CDK handles + the manifest). */
  cdnProps: CdnConstructProps;
};

/** Props owned by a feature hook — withheld from the construct unless that hook runs. */
type FeatureProps = 'webAcl' | 'webAclArn' | 'certificate' | 'domainName' | 'accessLogBucket' | 'geoRestriction';

/** The door's state: construct props the hooks fill in, and the construct once built. */
export type CloudFrontDoorState = {
  scope: Construct;
  props: Omit<CdnConstructProps, FeatureProps> & Partial<Pick<CdnConstructProps, FeatureProps>>;
  /** Set by `handle` — the distribution construct. */
  cdn?: CdnConstruct;
};

export const cloudFrontDoor = defineFrontDoor<CloudFrontDoorState, CloudFrontRenderContext>({
  service: 'cloudfront',

  /**
   * Composition: front each nested child layer (e.g. an ALB router) as a public
   * HTTP origin at its path. The child's `match` selector is the behavior
   * pattern; its `originHandle` gives the host + protocol.
   */
  create(scope, ctx, children) {
    const { webAcl, webAclArn, certificate, domainName, accessLogBucket, geoRestriction, ...routing } = ctx.cdnProps;
    const childOrigins = [...(children ?? new Map()).entries()].map(([match, handle]) => ({
      pattern: match,
      domainName: handle.originHandle.domainName,
      protocol: handle.originHandle.protocol,
    }));
    const props =
      childOrigins.length > 0
        ? { ...routing, extraHttpOrigins: [...(routing.extraHttpOrigins ?? []), ...childOrigins] }
        : routing;
    return { scope, props };
  },

  // CdnConstruct builds its behaviors + KVS route table from the manifest it was
  // given; every routing-level capability is delivered.
  route: (_door, plan) => ({
    ssr: plan.policies.hasServer ? 'streaming' : false,
    images: true,
    redirects: true,
    errorPages: true,
    cache: true,
    responseHeaders: true,
    atomicRelease: true,
    pinSession: true,
  }),

  handle(door) {
    const cdn = new CdnConstruct(door.scope, 'Cdn', door.props);
    door.cdn = cdn;
    return {
      url: cdn.distributionUrl,
      originHandle: { domainName: cdn.distribution.distributionDomainName, protocol: 'https' },
    };
  },

  // API behaviors (`/aws-blocks/*`, one per namespace) are added onto the
  // distribution by the Blocks layer from `plan.backend`.
  sameOriginApi: () => 'namespaced',
  customDomain(door, ctx) {
    door.props.certificate = ctx.cdnProps.certificate;
    door.props.domainName = ctx.cdnProps.domainName;
  },
  waf(door, ctx) {
    door.props.webAcl = ctx.cdnProps.webAcl;
    door.props.webAclArn = ctx.cdnProps.webAclArn;
    return 'edge';
  },
  restrictGeo(door, ctx) {
    door.props.geoRestriction = ctx.cdnProps.geoRestriction;
  },
  accessLogs(door, ctx) {
    door.props.accessLogBucket = ctx.cdnProps.accessLogBucket;
  },
  // CloudFront alarms (5xx, Lambda errors/throttles, DLQ depth) are built by the
  // HostingConstruct's MonitoringConstruct on the distribution this door returns.
  alarms() {},
});
