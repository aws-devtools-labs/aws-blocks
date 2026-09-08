/**
 * ALB front-door construct — the first NON-CloudFront door.
 *
 * Renders a service-agnostic {@link CapabilityPlan} onto an Application Load
 * Balancer (ALB): a VPC (bring-your-own or a default one), an ALB + listener,
 * Lambda TARGET GROUPS (a static asset-proxy, plus the SSR server and image-opt
 * Lambdas when present), and LISTENER RULES translated from the plan's
 * {@link RouteTable} (pattern → target group, redirects → redirect actions),
 * ordered by specificity so the first match wins — the ALB analogue of
 * CloudFront's KVS router.
 *
 * What ALB does NOT do (declared `degraded`/handled by the negotiator, not
 * silently dropped): global edge caching, per-route response-header injection,
 * skew-pin cookies, geo restriction. See {@link AlbAdapter}.
 */
import { CfnOutput, Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Code, Function as LambdaFunction, type IFunction } from 'aws-cdk-lib/aws-lambda';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { Fn } from 'aws-cdk-lib';
import type { CapabilityPlan, RouteKind } from '../plan/types.js';
import { generateAlbAssetProxyCode } from './alb_asset_proxy.js';
import { generateAlbApiProxyCode } from './alb_api_proxy.js';
import { DEFAULT_NODE_RUNTIME } from './node_runtime.js';

export type AlbConstructProps = {
  /** The service-agnostic plan (routes + origins + policies). */
  plan: CapabilityPlan;
  /** Private assets bucket (the asset-proxy Lambda reads `builds/<buildId>/…`). */
  bucket: IBucket;
  /** Compute functions by manifest name (SSR server, image-opt), if any. */
  computeFunctions?: Map<string, IFunction>;
  /** Name of the SSR/server compute in `computeFunctions` (e.g. `default`/`server`). */
  serverComputeName?: string;
  /** Name of the image-opt compute in `computeFunctions` (e.g. `image-optimization`). */
  imageComputeName?: string;
  /** Bring-your-own VPC. When omitted, a default 2-AZ VPC is created. */
  vpc?: ec2.IVpc;
  /** Internal (private) ALB vs internet-facing. Default: false (internet-facing). */
  internal?: boolean;
  /** ACM certificate (regional, same region as the ALB) for an HTTPS listener. */
  certificate?: ICertificate;
};

/** ALB listener rule priority bands (lower number = evaluated first). */
const API_PRIORITY_BASE = 1;
const REDIRECT_PRIORITY_BASE = 100;
const ROUTE_PRIORITY_BASE = 1000;

export class AlbConstruct extends Construct {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly vpc: ec2.IVpc;
  /** Public URL of the deploy (`http[s]://<alb-dns>`). */
  readonly url: string;

  constructor(scope: Construct, id: string, props: AlbConstructProps) {
    super(scope, id);
    const { plan, bucket } = props;
    const buildId = plan.release.buildId;
    const compute = props.computeFunctions ?? new Map<string, IFunction>();

    const serverFn = props.serverComputeName ? compute.get(props.serverComputeName) : undefined;
    const imageFn = props.imageComputeName ? compute.get(props.imageComputeName) : undefined;

    // ── VPC (BYO or a default 2-AZ VPC) ──
    this.vpc = props.vpc ?? new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 });

    // ── Static asset-proxy Lambda (ALB can't target S3 directly) ──
    const stripPrefix = plan.policies.basePath ?? plan.policies.assetPrefix ?? '';
    const spaFallback = plan.policies.spaFallback && !serverFn;
    const assetProxy = new LambdaFunction(this, 'AssetProxy', {
      runtime: DEFAULT_NODE_RUNTIME,
      handler: 'index.handler',
      code: Code.fromInline(generateAlbAssetProxyCode({ stripPrefix, spaFallback })),
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        ASSET_BUCKET: bucket.bucketName,
        ASSET_KEY_PREFIX: `builds/${buildId}`,
      },
    });
    bucket.grantRead(assetProxy);

    // ── Target groups (Lambda targets; health checks off — Lambda TGs are healthy) ──
    const staticTg = new elbv2.ApplicationTargetGroup(this, 'StaticTg', {
      targets: [new targets.LambdaTarget(assetProxy)],
      healthCheck: { enabled: false },
    });
    const serverTg = serverFn
      ? new elbv2.ApplicationTargetGroup(this, 'ServerTg', {
          targets: [new targets.LambdaTarget(serverFn)],
          healthCheck: { enabled: false },
        })
      : undefined;
    const imageTg = imageFn
      ? new elbv2.ApplicationTargetGroup(this, 'ImageTg', {
          targets: [new targets.LambdaTarget(imageFn)],
          healthCheck: { enabled: false },
        })
      : undefined;

    const tgForKind = (kind: RouteKind): elbv2.ApplicationTargetGroup => {
      if (kind === 'server') return serverTg ?? staticTg;
      if (kind === 'image') return imageTg ?? staticTg;
      return staticTg;
    };

    // ── ALB + listener ──
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: this.vpc,
      internetFacing: !props.internal,
    });

    // Default target: the server (SSR catch-all) if present, else static.
    const defaultTg = serverTg ?? staticTg;
    const httpsCert = props.certificate;
    const listener = this.loadBalancer.addListener('Listener', {
      port: httpsCert ? 443 : 80,
      protocol: httpsCert ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      certificates: httpsCert ? [httpsCert] : undefined,
      defaultTargetGroups: [defaultTg],
    });

    // ── Same-origin backend routing (highest precedence) ──
    // Each backend origin path-routes its namespace to that compute's ingress via
    // a small forwarder Lambda target (ALB can't target an external HTTPS URL, so
    // a Lambda relays it) — the ALB analogue of CloudFront's addApiBehaviors, so
    // the API is same-origin with the frontend (session cookies flow, no CORS). A
    // lone `'*'` origin is the single-compute case (`/aws-blocks/*` + auth subtree
    // → one backend); a named namespace routes `/aws-blocks/api/{ns}/*`. These
    // rules win over the route/catch-all rules (lowest priority numbers).
    let apiPriority = API_PRIORITY_BASE;
    for (const origin of plan.backend?.origins ?? []) {
      const ns = origin.namespace;
      const paths = ns === '*' ? ['/aws-blocks/*', '/aws-blocks-auth/*'] : [`/aws-blocks/api/${ns}/*`];
      const idSuffix = ns === '*' ? 'Default' : ns;
      const apiProxy = new LambdaFunction(this, `ApiProxy${idSuffix}`, {
        runtime: DEFAULT_NODE_RUNTIME,
        handler: 'index.handler',
        code: Code.fromInline(generateAlbApiProxyCode()),
        timeout: Duration.seconds(30),
        memorySize: 256,
        environment: {
          // Ingress base WITHOUT the `/aws-blocks/api` suffix (token-safe: split
          // the resolved URL on the suffix and take the base). Works for a Lambda
          // API Gateway, a container ALB, or a BYOC endpoint alike.
          API_GW_BASE: Fn.select(0, Fn.split('/aws-blocks/api', origin.ingress.url)),
        },
      });
      const apiTg = new elbv2.ApplicationTargetGroup(this, `ApiProxyTg${idSuffix}`, {
        targetType: elbv2.TargetType.LAMBDA,
        targets: [new targets.LambdaTarget(apiProxy)],
        healthCheck: { enabled: false },
        // Preserve multiple Set-Cookie response headers (auth session cookies).
        // Requires the LAMBDA target type (set explicitly above for the validator).
        multiValueHeadersEnabled: true,
      });
      for (const pattern of paths) {
        listener.addTargetGroups(`ApiRoute${apiPriority}`, {
          priority: apiPriority++,
          conditions: [elbv2.ListenerCondition.pathPatterns([pattern])],
          targetGroups: [apiTg],
        });
      }
    }

    // ── Listener rules from the plan's RouteTable ──
    // Redirects first (lowest priority numbers = evaluated first), then routes
    // in the plan's specificity order (already most-specific-first).
    let priority = REDIRECT_PRIORITY_BASE;
    for (const r of plan.routes.redirects) {
      listener.addAction(`Redirect${priority}`, {
        priority: priority++,
        conditions: [elbv2.ListenerCondition.pathPatterns([r.source])],
        action: elbv2.ListenerAction.redirect({
          path: r.destination,
          permanent: r.statusCode === 301 || r.statusCode === 308,
        }),
      });
    }

    priority = ROUTE_PRIORITY_BASE;
    for (const entry of plan.routes.entries) {
      // The default action already covers the implicit catch-all; a rule whose
      // target equals the default is redundant, but harmless and keeps the
      // mapping explicit. ALB path patterns support '*'/'?' — the plan's
      // glob patterns map directly.
      listener.addTargetGroups(`Route${priority}`, {
        priority: priority++,
        conditions: [elbv2.ListenerCondition.pathPatterns([entry.pattern])],
        targetGroups: [tgForKind(entry.kind)],
      });
    }

    this.url = `${httpsCert ? 'https' : 'http'}://${this.loadBalancer.loadBalancerDnsName}`;
    new CfnOutput(this, 'AlbUrl', { value: this.url, description: 'ALB front-door URL' });
    new CfnOutput(this, 'AlbDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'ALB DNS name — point a CNAME/ALIAS here for a custom domain.',
    });
  }
}
