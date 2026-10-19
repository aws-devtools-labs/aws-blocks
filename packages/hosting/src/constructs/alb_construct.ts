/**
 * ALB front-door construct — backs the front door with an Application Load Balancer.
 *
 * Renders a service-agnostic {@link CapabilityPlan} onto an Application Load
 * Balancer (ALB): a VPC (bring-your-own or a default one), an ALB + listener,
 * Lambda TARGET GROUPS (a static asset-proxy, plus the SSR server and image-opt
 * Lambdas when present), and LISTENER RULES translated from the plan's
 * {@link RouteTable} (pattern → target group, redirects → redirect actions),
 * ordered by specificity so the first match wins — the ALB analogue of
 * CloudFront's KVS router.
 *
 * What ALB does NOT do (it has no edge; an app that asks for these deploys
 * without them — there is no feature check): global edge caching, per-route
 * response-header injection, skew-pin cookies, geo restriction. See `albDoor`.
 */
import { createHash } from 'node:crypto';
import { CfnOutput, Duration, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Code, Function as LambdaFunction, type IFunction } from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { HostingError } from '../hosting_error.js';
import type { CapabilityPlan, RouteKind } from '../plan/types.js';
import { generateAlbAssetProxyCode } from './alb_asset_proxy.js';
import { generateAlbApiProxyCode } from './alb_api_proxy.js';
import type { OriginHandle } from './layer.js';
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
  /**
   * Enable native ALB access logging (`AccessLogging`) — provisions an S3 log
   * bucket and turns on the ALB's own access logs (not a CloudFront-format
   * imitation).
   */
  accessLogging?: boolean;
  /**
   * WAF for the ALB — a native WAFv2 **REGIONAL** WebACL associated with the
   * load balancer (`FilterRequests`). Provide `webAclArn` to reuse an existing
   * WebACL, or set `enabled` to have the construct create one (rate-based rule).
   */
  waf?: { enabled?: boolean; rateLimit?: number; webAclArn?: string };
  /**
   * Emit CloudWatch alarms on the ALB's OWN metrics (5xx, target response time)
   * — the native ALB metrics (`Alarms`), not CloudFront's metric set.
   */
  monitoring?: boolean;
  /**
   * Every path pattern the single-compute (`'*'`) backend serves — the
   * `DoorInput.origins.api.paths`: `/aws-blocks/*` plus the backend's raw
   * routes. Each reaches the API forwarder, as each gets a CloudFront behavior
   * on the CloudFront door.
   * @default ['/aws-blocks/*']
   */
  apiPaths?: readonly string[];
  /**
   * Admit only a CloudFront door in front of this ALB (the stacked door's
   * router). Every listener rule then also requires the per-deploy
   * {@link ORIGIN_VERIFY_HEADER} secret, and the default action is a 403. A
   * public ALB's security group admits only the CloudFront origin-facing
   * managed prefix list; an internal ALB is reached through a CloudFront VPC
   * origin, which the door in front admits into the security group (see
   * {@link OriginHandle.privateLoadBalancer}). The secret travels to that door
   * as {@link OriginHandle.customHeaders}.
   * @default false — a standalone ALB door is public by design.
   */
  restrictToCloudFront?: boolean;
};

/**
 * The header a CloudFront door in front of a locked ALB sends with the
 * per-deploy secret (see {@link AlbConstructProps.restrictToCloudFront}).
 */
export const ORIGIN_VERIFY_HEADER = 'x-blocks-origin-verify';

/** The AWS-managed prefix list of CloudFront's origin-facing addresses (one per region, same name). */
export const CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST = 'com.amazonaws.global.cloudfront.origin-facing';

/** ALB listener rule priority bands (lower number = evaluated first). */
const API_PRIORITY_BASE = 1;
const REDIRECT_PRIORITY_BASE = 100;
const ROUTE_PRIORITY_BASE = 1000;
/** An ALB listener rule holds at most 5 condition values (a hard limit), the header check included. */
const MAX_CONDITION_VALUES = 5;
/** The last listener rule priority: the header-checked catch-all of a locked ALB. */
const CATCH_ALL_PRIORITY = 50000;

export class AlbConstruct extends Construct {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly vpc: ec2.IVpc;
  /** Public URL of the deploy (`http[s]://<alb-dns>`). */
  readonly url: string;
  /**
   * How a door in front reaches this ALB: its DNS name, plus — when
   * {@link AlbConstructProps.restrictToCloudFront} — the origin-verify header
   * to send and, for an internal ALB, the balancer for a VPC origin.
   */
  readonly originHandle: OriginHandle;

  constructor(scope: Construct, id: string, props: AlbConstructProps) {
    super(scope, id);
    const { plan, bucket } = props;
    const buildId = plan.release.buildId;
    const compute = props.computeFunctions ?? new Map<string, IFunction>();

    const serverFn = props.serverComputeName ? compute.get(props.serverComputeName) : undefined;
    const imageFn = props.imageComputeName ? compute.get(props.imageComputeName) : undefined;

    // ── VPC (BYO or a default 2-AZ, PUBLIC-ONLY VPC) ──
    // A public ALB lives in public subnets and the front-door Lambdas are not
    // VPC-attached, so the default VPC needs no private subnets and — crucially —
    // no NAT Gateway. `ec2.Vpc`'s defaults would add a PRIVATE_WITH_EGRESS tier
    // plus a billed-but-idle NAT Gateway (~$32/mo + per-GB) that nothing here
    // uses; a public-only `subnetConfiguration` avoids that cost. A future
    // VPC-attached (container / private-Lambda) backend can bring its own VPC
    // with private egress instead.
    this.vpc =
      props.vpc ??
      new ec2.Vpc(this, 'Vpc', {
        maxAzs: 2,
        natGateways: 0,
        subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      });

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
    // The server answers with multi-value headers so several `Set-Cookie`
    // headers survive (a Lambda Web Adapter server reads and answers both
    // shapes; a native handler gets the ALB event shim, see
    // `alb_lambda_event.ts`).
    const serverTg = serverFn
      ? new elbv2.ApplicationTargetGroup(this, 'ServerTg', {
          targetType: elbv2.TargetType.LAMBDA,
          targets: [new targets.LambdaTarget(serverFn)],
          healthCheck: { enabled: false },
          multiValueHeadersEnabled: true,
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
    const port = httpsCert ? 443 : 80;

    // Locked to a CloudFront door in front (the stacked door's router): a
    // per-deploy secret the door sends as a header, required by every rule;
    // without it the default action answers 403. Deterministic per stack and
    // construct path (like the CloudFront door's origin-verify secret for its
    // REST origin) so it doesn't churn on every deploy; bump the suffix to rotate.
    const originSecret = props.restrictToCloudFront
      ? createHash('sha256').update(Stack.of(this).stackName).update(this.node.path).update('alb-origin-verify-v1').digest('hex')
      : undefined;
    const verify = originSecret ? [elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [originSecret])] : [];
    const pathsPerRule = MAX_CONDITION_VALUES - verify.length;

    const listener = this.loadBalancer.addListener('Listener', {
      port,
      protocol: httpsCert ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      certificates: httpsCert ? [httpsCert] : undefined,
      ...(originSecret
        ? {
            // Not open to the world: the ingress below admits CloudFront only.
            open: false,
            defaultAction: elbv2.ListenerAction.fixedResponse(403, {
              contentType: 'text/plain',
              messageBody: 'Forbidden',
            }),
          }
        : { defaultTargetGroups: [defaultTg] }),
    });

    // Only CloudFront reaches a locked ALB. A public one admits the
    // origin-facing managed prefix list, looked up per region at deploy time
    // (its id differs by region; a custom resource needs no synth-time
    // context). An internal one is reached through a CloudFront VPC origin —
    // the door in front admits it (see `OriginHandle.privateLoadBalancer`).
    if (originSecret && !props.internal) {
      const prefixList = new AwsCustomResource(this, 'CloudFrontOriginFacing', {
        onUpdate: {
          service: 'EC2',
          action: 'describeManagedPrefixLists',
          parameters: { Filters: [{ Name: 'prefix-list-name', Values: [CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST] }] },
          physicalResourceId: PhysicalResourceId.of(CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST),
          outputPaths: ['PrefixLists.0.PrefixListId'],
        },
        policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
        installLatestAwsSdk: false,
      });
      this.loadBalancer.connections.allowFrom(
        ec2.Peer.prefixList(prefixList.getResponseField('PrefixLists.0.PrefixListId')),
        ec2.Port.tcp(port),
        'CloudFront origin-facing addresses only',
      );
    }

    // ── Same-origin backend routing (highest precedence) ──
    // Each backend origin path-routes its namespace to that compute's ingress via
    // a small forwarder Lambda target (ALB can't target an external HTTPS URL, so
    // a Lambda relays it) — the ALB analogue of CloudFront's addApiBehaviors, so
    // the API is same-origin with the frontend (session cookies flow, no CORS). A
    // lone `'*'` origin is the single-compute case: every API path (`/aws-blocks/*`,
    // which covers sign-in at `/aws-blocks/auth/*`, plus the backend's raw routes)
    // → one backend; a named namespace routes `/aws-blocks/api/{ns}/*`. These
    // rules win over the route/catch-all rules (lowest priority numbers). A rule
    // holds at most 5 condition values, so the paths are packed 5 to a rule (4
    // beside the origin-verify header of a locked ALB).
    let apiPriority = API_PRIORITY_BASE;
    for (const origin of plan.backend?.origins ?? []) {
      const ns = origin.namespace;
      const paths = ns === '*' ? [...new Set(props.apiPaths ?? ['/aws-blocks/*'])] : [`/aws-blocks/api/${ns}/*`];
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
      for (let i = 0; i < paths.length; i += pathsPerRule) {
        if (apiPriority >= REDIRECT_PRIORITY_BASE) {
          throw new HostingError('TooManyApiPathsError', {
            message:
              `The ALB front door needs more than ${REDIRECT_PRIORITY_BASE - API_PRIORITY_BASE} listener rules ` +
              `for the backend's API paths (${paths.length} paths, ${pathsPerRule} per rule).`,
            resolution:
              'Group the raw routes under fewer path prefixes (a parameterized route `/hooks/{id}` is one `/hooks/*` ' +
              'pattern), or move them under `/aws-blocks/`.',
          });
        }
        listener.addTargetGroups(`ApiRoute${apiPriority}`, {
          priority: apiPriority++,
          conditions: [...verify, elbv2.ListenerCondition.pathPatterns(paths.slice(i, i + pathsPerRule))],
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
        conditions: [...verify, elbv2.ListenerCondition.pathPatterns([r.source])],
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
        conditions: [...verify, elbv2.ListenerCondition.pathPatterns([entry.pattern])],
        targetGroups: [tgForKind(entry.kind)],
      });
    }
    // A locked ALB's catch-all: the default target, for requests carrying the secret.
    if (originSecret) {
      listener.addTargetGroups('CatchAll', { priority: CATCH_ALL_PRIORITY, conditions: verify, targetGroups: [defaultTg] });
    }

    // ── Native ALB cross-cutting features (NOT CloudFront imitations) ──

    // Access logging: the native ALB access-log feature → a dedicated S3 bucket.
    if (props.accessLogging) {
      const logBucket = new s3.Bucket(this, 'AccessLogs', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      this.loadBalancer.logAccessLogs(logBucket);
    }

    // WAF: a native WAFv2 REGIONAL WebACL associated with the ALB (BYO ARN, or
    // create a rate-limited one). This is the first-class AWS mechanism — not a
    // proxy Lambda faking request filtering.
    if (props.waf?.webAclArn || props.waf?.enabled) {
      let webAclArn = props.waf.webAclArn;
      if (!webAclArn) {
        const acl = new CfnWebACL(this, 'WebAcl', {
          scope: 'REGIONAL',
          defaultAction: { allow: {} },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'AlbWebAcl', sampledRequestsEnabled: true },
          rules: [
            {
              name: 'RateLimit',
              priority: 0,
              action: { block: {} },
              statement: { rateBasedStatement: { limit: props.waf.rateLimit ?? 1000, aggregateKeyType: 'IP' } },
              visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'AlbRateLimit', sampledRequestsEnabled: true },
            },
          ],
        });
        webAclArn = acl.attrArn;
      }
      new CfnWebACLAssociation(this, 'WebAclAssoc', {
        resourceArn: this.loadBalancer.loadBalancerArn,
        webAclArn,
      });
    }

    // Alarms: CloudWatch alarms on the ALB's OWN metrics (5xx + latency).
    if (props.monitoring) {
      this.loadBalancer.metrics
        .httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT)
        .createAlarm(this, 'Alb5xxAlarm', { threshold: 5, evaluationPeriods: 1 });
      this.loadBalancer.metrics
        .targetResponseTime()
        .createAlarm(this, 'AlbLatencyAlarm', { threshold: 5, evaluationPeriods: 3 });
    }

    this.url = `${httpsCert ? 'https' : 'http'}://${this.loadBalancer.loadBalancerDnsName}`;
    this.originHandle = {
      domainName: this.loadBalancer.loadBalancerDnsName,
      protocol: httpsCert ? 'https' : 'http',
      ...(originSecret ? { customHeaders: { [ORIGIN_VERIFY_HEADER]: originSecret } } : {}),
      ...(originSecret && props.internal ? { privateLoadBalancer: this.loadBalancer } : {}),
    };
    new CfnOutput(this, 'AlbUrl', { value: this.url, description: 'ALB front-door URL' });
    new CfnOutput(this, 'AlbDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'ALB DNS name — point a CNAME/ALIAS here for a custom domain.',
    });
  }
}
