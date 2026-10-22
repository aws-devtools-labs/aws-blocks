/**
 * ALB front-door construct — backs the front door with an Application Load Balancer.
 *
 * Renders a service-agnostic {@link HostingPlan} onto an Application Load
 * Balancer (ALB): a VPC (bring-your-own or a default one), an ALB + listener,
 * Lambda TARGET GROUPS (a static asset-proxy, plus the SSR server and image-opt
 * Lambdas when present), and LISTENER RULES translated from the plan's
 * {@link RouteTable} (pattern → target group; each redirect source → the asset
 * proxy, which answers it), ordered by specificity so the first match wins —
 * the ALB analogue of CloudFront's KVS router. Consecutive paths bound for the
 * same target share a rule (up to 5 condition values each), and trailing rules
 * that only repeat the default target are dropped; synth warns when the rules
 * exceed the default quota of 100 per load balancer
 * (`@aws-blocks/hosting:AlbRuleLimit`).
 *
 * What the ALB does NOT have (it has no edge): global edge caching, skew
 * protection, geo restriction. Unsupported settings are a type error in
 * `frontDoor.features` and a synth error through the deprecated top-level
 * props. See `albDoor`.
 *
 * The app's redirects, per-pattern response headers and error pages are applied
 * by the asset proxy (and the headers by the API forwarder) with the CloudFront
 * door's semantics; responses the ALB sends straight to the server or image
 * function don't pass through them, which synth reports
 * (`@aws-blocks/hosting:DoorRulesNotApplied`).
 *
 * With a custom domain (`domain`) the listener is HTTPS (TLS 1.2+, the
 * `RECOMMENDED_TLS` policy) with a port 80 → 443 redirect, Route 53 alias
 * records point the names at the ALB, and the URL is the primary name.
 */
import { Annotations, CfnOutput, Duration, Fn, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { Code, Function as LambdaFunction, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { AaaaRecord, ARecord, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { HostingError } from '../hosting_error.js';
import type { HostingPlan, RouteKind } from '../plan/types.js';
import { generateAlbAssetProxyCode } from './alb_asset_proxy.js';
import { generateAlbApiProxyCode } from './alb_api_proxy.js';
import { type ApiGwCustomDomain, resolveApiGwDomain } from './apigw_domain.js';
import { routableApiPaths } from './apigw_routes.js';
import { warnRulesNotApplied } from './proxy_rules.js';
import type { OriginHandle } from './layer.js';
import { assetProxyEnvironment } from './asset_proxy_core.js';
import { DEFAULT_NODE_RUNTIME } from './node_runtime.js';

export type AlbConstructProps = {
  /** The service-agnostic plan (routes + origins + policies). */
  plan: HostingPlan;
  /** Private assets bucket (the asset-proxy Lambda reads `builds/<buildId>/…`). */
  bucket: IBucket;
  /** Compute functions by manifest name (SSR server, image-opt), if any. */
  computeFunctions?: Map<string, IFunction>;
  /** Name of the SSR/server compute in `computeFunctions` (e.g. `default`/`server`). */
  serverComputeName?: string;
  /** Name of the image-opt compute in `computeFunctions` (e.g. `image-optimization`). */
  imageComputeName?: string;
  /**
   * Bring-your-own VPC. When omitted, a default 2-AZ VPC is created: public
   * subnets only (no NAT Gateway), plus isolated private subnets for an
   * `internal` ALB.
   */
  vpc?: ec2.IVpc;
  /**
   * Internal (private) ALB vs internet-facing. Default: false (internet-facing).
   * An internal ALB is placed in the VPC's private subnets (the default VPC's
   * isolated ones). The API forwarder is not VPC-attached: it still reaches
   * the backend at its public endpoint.
   */
  internal?: boolean;
  /**
   * ACM certificate (regional, same region as the ALB) for the HTTPS listener.
   * With `domain`, it must cover the domain's names (else `domain.certificate`,
   * else a DNS-validated one is used).
   */
  certificate?: ICertificate;
  /**
   * Custom domain(s): the HTTPS listener's certificate (see `certificate`),
   * Route 53 A/AAAA alias records to the ALB when a hosted zone is given, and
   * the URL `https://<first name>`.
   */
  domain?: ApiGwCustomDomain;
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
   * router; `HostingConstruct` sets it only for `kind: 'stackedRouter'`).
   * Every listener rule then also requires the
   * {@link ORIGIN_VERIFY_HEADER} secret (see {@link AlbConstruct.originVerifySecret}), and the default action is a 403. A
   * public ALB's security group admits only the CloudFront origin-facing
   * managed prefix list; an internal ALB is reached through a CloudFront VPC
   * origin, which the door in front admits into the security group (see
   * {@link OriginHandle.privateLoadBalancer}). The secret travels to that door
   * as {@link OriginHandle.customHeaders}.
   * @default false — a standalone ALB door is public by design.
   */
  restrictToCloudFront?: boolean;
  /**
   * The app's error pages, as object keys under the build prefix: the asset
   * proxy serves `notFound` (404) for a missing file and `serverError` (500)
   * when S3 fails.
   */
  errorPages?: { notFound?: string; serverError?: string };
};

/**
 * The header a CloudFront door in front of a locked ALB sends with the
 * generated secret (see {@link AlbConstructProps.restrictToCloudFront}).
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
/** The default quota of listener rules per Application Load Balancer (adjustable; the default rule not counted). */
export const ALB_DEFAULT_RULE_QUOTA = 100;

export class AlbConstruct extends Construct {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly vpc: ec2.IVpc;
  /**
   * The static asset-proxy Lambda. Its `ASSET_KEY_PREFIX` environment names
   * the build, so it is the door's switch to a new build (its `cutover`).
   */
  readonly assetProxy: LambdaFunction;
  /** Public URL of the deploy: `https://<first domain name>` with a domain, else `http[s]://<alb-dns>`. */
  readonly url: string;
  /**
   * How a door in front reaches this ALB: its DNS name, plus — when
   * {@link AlbConstructProps.restrictToCloudFront} — the origin-verify header
   * to send and, for an internal ALB, the balancer for a VPC origin.
   */
  readonly originHandle: OriginHandle;
  /**
   * The origin-verify secret of a router locked to CloudFront
   * ({@link AlbConstructProps.restrictToCloudFront}): a random value Secrets
   * Manager generates once. The listener rules and the CloudFront origin both
   * resolve it at deploy time. To rotate it, put a new value and then update
   * both the distribution and the listener rules in one deploy — CloudFormation
   * re-reads a dynamic reference only for a resource it updates, so updating
   * one without the other makes the edge's requests 403 until both match.
   */
  readonly originVerifySecret?: Secret;

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
    // An internal ALB in the default VPC goes into isolated private subnets
    // (still no NAT): a CloudFront VPC origin targets a balancer in private
    // subnets, and the public ones keep the internet gateway it requires.
    const defaultVpcInternal = !props.vpc && props.internal === true;
    this.vpc =
      props.vpc ??
      new ec2.Vpc(this, 'Vpc', {
        maxAzs: 2,
        natGateways: 0,
        subnetConfiguration: [
          { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
          ...(defaultVpcInternal ? [{ name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }] : []),
        ],
      });

    // ── Static asset-proxy Lambda (ALB can't target S3 directly) ──
    const stripPrefix = plan.policies.basePath ?? plan.policies.assetPrefix ?? '';
    const spaFallback = plan.policies.spaFallback && !serverFn;
    const assetProxy = new LambdaFunction(this, 'AssetProxy', {
      runtime: DEFAULT_NODE_RUNTIME,
      handler: 'index.handler',
      // The app's redirects, header rules and error pages, applied as on the
      // CloudFront door (see `asset_proxy_core.ts`).
      code: Code.fromInline(
        generateAlbAssetProxyCode({
          stripPrefix,
          spaFallback,
          redirects: plan.routes.redirects,
          headers: plan.routes.headers,
          errorPages: props.errorPages,
        }),
      ),
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: assetProxyEnvironment({ bucket, prefix: `builds/${buildId}` }),
    });
    bucket.grantRead(assetProxy);
    this.assetProxy = assetProxy;

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
      ...(defaultVpcInternal ? { vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED } } : {}),
    });

    // Default target: the server (SSR catch-all) if present, else static.
    const defaultTg = serverTg ?? staticTg;
    // A custom domain: its certificate (the door's, the domain's, or a
    // DNS-validated one) and hosted zone.
    const domain = props.domain
      ? resolveApiGwDomain(this, 'Domain', { ...props.domain, certificate: props.certificate ?? props.domain.certificate })
      : undefined;
    const httpsCert = domain?.certificate ?? props.certificate;
    const port = httpsCert ? 443 : 80;

    // Locked to a CloudFront door in front (the stacked door's router): a
    // secret the door sends as a header, required by every rule; without it the
    // default action answers 403. Generated once by Secrets Manager (random,
    // not derivable from the stack name or construct path), and referenced —
    // never written into the template — by both the listener rules and the
    // CloudFront origin's custom header, as a `{{resolve:secretsmanager:…}}`
    // dynamic reference. Alphanumeric only: an ALB header condition treats `*`
    // and `?` as wildcards. It changes only when the secret is rotated (see
    // `originVerifySecret`).
    //
    // Don't change `generateSecretString` (or this construct's id): either
    // makes CloudFormation generate a new value on upgrade, and only the
    // resources an update happens to touch re-read the dynamic reference, so
    // the edge and the listener rules could disagree and the router answer 403.
    this.originVerifySecret = props.restrictToCloudFront
      ? new Secret(this, 'OriginVerifySecret', {
          description: 'The header value the stacked door\'s CloudFront edge sends to its ALB router (x-blocks-origin-verify).',
          generateSecretString: { passwordLength: 64, excludePunctuation: true, includeSpace: false },
        })
      : undefined;
    const originSecret = this.originVerifySecret?.secretValue.unsafeUnwrap();
    const verify = originSecret ? [elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [originSecret])] : [];
    const pathsPerRule = MAX_CONDITION_VALUES - verify.length;

    const listener = this.loadBalancer.addListener('Listener', {
      port,
      protocol: httpsCert ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      certificates: httpsCert ? [httpsCert] : undefined,
      // TLS 1.2+ (ELB's own default policy still accepts TLS 1.0 / 1.1).
      ...(httpsCert ? { sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS } : {}),
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

    // HTTPS: send plain-HTTP visitors to it (a public, unlocked ALB only).
    if (httpsCert && !originSecret) {
      this.loadBalancer.addRedirect({ sourcePort: 80, targetPort: 443 });
    }

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
    let ruleCount = 0;
    for (const origin of plan.backend?.origins ?? []) {
      const ns = origin.namespace;
      const paths = ns === '*' ? routableApiPaths(this, 'ALB', props.apiPaths ?? ['/aws-blocks/*']) : [`/aws-blocks/api/${ns}/*`];
      const idSuffix = ns === '*' ? 'Default' : ns;
      const apiProxy = new LambdaFunction(this, `ApiProxy${idSuffix}`, {
        runtime: DEFAULT_NODE_RUNTIME,
        handler: 'index.handler',
        code: Code.fromInline(generateAlbApiProxyCode({ headers: plan.routes.headers })),
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
        ruleCount++;
      }
    }

    // ── Listener rules from the plan's RouteTable ──
    // Redirects first (lowest priority numbers = evaluated first), then routes
    // in the plan's specificity order (already most-specific-first). A redirect
    // source routes to the asset proxy, which answers the redirect with the
    // CloudFront door's semantics (exact status, wildcard tail spliced into the
    // destination) — a native ALB redirect action can't splice the tail. Every
    // redirect source goes to the same target, so they share rules (up to
    // `pathsPerRule` sources each); the proxy picks the first matching redirect.
    let priority = REDIRECT_PRIORITY_BASE;
    const redirectSources = [...new Set(plan.routes.redirects.map((r) => r.source))];
    for (let i = 0; i < redirectSources.length; i += pathsPerRule) {
      if (priority >= ROUTE_PRIORITY_BASE) {
        throw new HostingError('TooManyRedirectsError', {
          message:
            `The ALB front door needs more than ${ROUTE_PRIORITY_BASE - REDIRECT_PRIORITY_BASE} listener rules for the ` +
            `app's ${redirectSources.length} redirects (${pathsPerRule} sources per rule).`,
          resolution: 'Group the redirects under wildcard sources (`/old/*` → `/new/*`), or use the CloudFront door.',
        });
      }
      listener.addTargetGroups(`Redirect${priority}`, {
        priority: priority++,
        conditions: [...verify, elbv2.ListenerCondition.pathPatterns(redirectSources.slice(i, i + pathsPerRule))],
        targetGroups: [staticTg],
      });
      ruleCount++;
    }

    // Routes: consecutive patterns bound for the same target group share a rule
    // (order between targets is kept, so the first match still wins). Trailing
    // routes that go where the catch-all goes add nothing, so they are dropped.
    const groups: Array<{ tg: elbv2.ApplicationTargetGroup; patterns: string[] }> = [];
    for (const entry of plan.routes.entries) {
      const tg = tgForKind(entry.kind);
      const last = groups[groups.length - 1];
      if (last && last.tg === tg && last.patterns.length < pathsPerRule) last.patterns.push(entry.pattern);
      else groups.push({ tg, patterns: [entry.pattern] });
    }
    while (groups.length > 0 && groups[groups.length - 1].tg === defaultTg) groups.pop();
    priority = ROUTE_PRIORITY_BASE;
    for (const group of groups) {
      listener.addTargetGroups(`Route${priority}`, {
        priority: priority++,
        conditions: [...verify, elbv2.ListenerCondition.pathPatterns(group.patterns)],
        targetGroups: [group.tg],
      });
      ruleCount++;
    }
    // A locked ALB's catch-all: the default target, for requests carrying the secret.
    if (originSecret) {
      listener.addTargetGroups('CatchAll', { priority: CATCH_ALL_PRIORITY, conditions: verify, targetGroups: [defaultTg] });
      ruleCount++;
    }
    if (ruleCount > ALB_DEFAULT_RULE_QUOTA) {
      Annotations.of(this).addWarningV2(
        '@aws-blocks/hosting:AlbRuleLimit',
        `The ALB front door needs ${ruleCount} listener rules; a load balancer allows ${ALB_DEFAULT_RULE_QUOTA} by default, ` +
          'so the deploy fails unless the quota (Elastic Load Balancing: Rules per Application Load Balancer) was raised. ' +
          'Group routes and redirects under fewer path prefixes, or use the CloudFront door.',
      );
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

    // The rules the proxies can't apply (responses the ALB sends straight to a
    // function). Behind the stacked door's edge, the edge applies them.
    if (!props.restrictToCloudFront) {
      warnRulesNotApplied(this, {
        door: 'ALB',
        headers: plan.routes.headers,
        errorPages: Boolean(props.errorPages?.notFound || props.errorPages?.serverError),
        server: Boolean(serverFn),
        image: Boolean(imageFn),
        nativeApi: false,
        api: (plan.backend?.origins.length ?? 0) > 0,
      });
    }

    // A custom domain's records: each name → the ALB (alias A + AAAA).
    const zone = domain?.hostedZone;
    if (domain && zone) {
      const target = RecordTarget.fromAlias(new LoadBalancerTarget(this.loadBalancer));
      domain.names.forEach((name, i) => {
        new ARecord(this, `DomainA${i}`, { zone, recordName: name, target });
        new AaaaRecord(this, `DomainAAAA${i}`, { zone, recordName: name, target });
      });
    }

    this.url = domain
      ? `https://${domain.names[0]}`
      : `${httpsCert ? 'https' : 'http'}://${this.loadBalancer.loadBalancerDnsName}`;
    this.originHandle = {
      // A door in front connects to the name the certificate covers.
      domainName: domain ? domain.names[0] : this.loadBalancer.loadBalancerDnsName,
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
