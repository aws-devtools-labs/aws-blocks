import { Construct } from 'constructs';
import { Duration, RemovalPolicy, Stack, Token } from 'aws-cdk-lib';
import {
  Alias,
  Architecture,
  Code,
  FunctionUrl,
  FunctionUrlAuthType,
  InvokeMode,
  Function as LambdaFunction,
  LayerVersion,
  Runtime,
} from 'aws-cdk-lib/aws-lambda';
import { experimental } from 'aws-cdk-lib/aws-cloudfront';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { HostingError } from '../hosting_error.js';
import { ComputeResource } from '../manifest/types.js';
import { SSR_DEFAULT_PORT } from '../defaults.js';

// ---- Constants ----

/**
 * Account ID for the public Lambda Web Adapter layer.
 * Maintained by AWS Labs: https://github.com/awslabs/aws-lambda-web-adapter
 */
const LAMBDA_WEB_ADAPTER_ACCOUNT = '753240598075';

/**
 * Layer name for the Lambda Web Adapter (x86-64).
 */
const LAMBDA_WEB_ADAPTER_LAYER_NAME = 'LambdaAdapterLayerX86';

/**
 * Default Lambda Web Adapter layer version.
 */
const DEFAULT_WEB_ADAPTER_VERSION = 22;

/** Default Lambda memory in MB */
const DEFAULT_LAMBDA_MEMORY_MB = 1024;

/** Default Lambda timeout in seconds */
const DEFAULT_LAMBDA_TIMEOUT_SECONDS = 30;

/**
 * Regions known to host the Lambda Web Adapter public layer.
 */
const LAMBDA_WEB_ADAPTER_SUPPORTED_REGIONS = new Set([
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-north-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'sa-east-1',
  'ca-central-1',
  'me-south-1',
  'af-south-1',
  'eu-south-1',
]);

// ---- Public types ----

/**
 * Props for the ComputeConstruct.
 */
export type ComputeConstructProps = {
  /** Logical name of this compute resource. */
  name: string;
  /** The compute resource definition from the deploy manifest. */
  computeResource: ComputeResource;
  /** Lambda memory size override (MB). Default: from manifest or 1024. */
  memorySize?: number;
  /** Lambda timeout override. Default: from manifest or 30 seconds. */
  timeout?: Duration;
  /** Reserved concurrent executions. Default: undefined (no reservation). */
  reservedConcurrency?: number;
  /**
   * Provisioned concurrency for cold-start elimination. When > 0, a `live`
   * alias is created with this many always-warm execution environments, and
   * the alias becomes the routing target (Function URL and — for SSR — the
   * caller's REST API integration via the exposed {@link alias}). Default:
   * undefined (no provisioning; `$LATEST` serves traffic).
   */
  provisionedConcurrency?: number;
  /** Lambda Web Adapter layer version. Default: 22. */
  webAdapterVersion?: number;
  /** CloudWatch log retention. Default: TWO_WEEKS. */
  logRetention?: RetentionDays;
  /** Skip the Lambda Web Adapter region validation check. */
  skipRegionValidation?: boolean;
  /** Lambda architecture override. Default: X86_64. */
  architecture?: Architecture;
  /**
   * Skip creating a Function URL. Set by the L3 for SSR compute, which is
   * fronted by API Gateway REST API instead (no orphaned Function URL).
   */
  skipFunctionUrl?: boolean;
  /**
   * Invoke an `http-server` (Lambda Web Adapter) compute in BUFFERED mode
   * instead of `response_stream`. Set by the L3 for preview `bypassCdn`, where
   * the SSR compute is fronted by a buffered API Gateway `HttpLambdaIntegration`
   * (no streaming Function URL). Preview trades away SSR streaming (a perf
   * feature) for a functional, secure single-origin — the Lambda stays private
   * (no public Function URL). No effect on `handler`/`edge` computes.
   */
  bufferedInvoke?: boolean;
  /**
   * Additional environment variables to inject into the Lambda function.
   * Merged with (and overrides) the manifest's compute resource environment.
   */
  environment?: Record<string, string>;
};

// ---- Construct ----

/**
 * Lambda compute construct — creates Lambda functions from manifest compute resources.
 *
 * Supports three compute types:
 * - **handler**: Direct Lambda invocation (native Node.js handler, no Web Adapter).
 *   Used by OpenNext server functions.
 * - **http-server**: Lambda + Web Adapter layer. Runs an HTTP server process inside Lambda.
 *   Used for frameworks that produce HTTP servers (SvelteKit, Astro, custom servers).
 * - **edge**: Lambda@Edge (placeholder — deployed via CloudFront).
 */
export class ComputeConstruct extends Construct {
  readonly function: LambdaFunction | experimental.EdgeFunction;
  readonly functionUrl: FunctionUrl | undefined;
  /**
   * The `live` alias backing provisioned concurrency, when
   * `provisionedConcurrency > 0`. Exposed so the L3 can point an
   * API Gateway integration at the warm alias for SSR compute (which has
   * no Function URL). Undefined when provisioned concurrency is not set.
   */
  readonly alias: Alias | undefined;

  /**
   * Creates a compute resource (Lambda function) based on the compute type.
   */
  constructor(scope: Construct, id: string, props: ComputeConstructProps) {
    super(scope, id);

    const { computeResource } = props;
    const region = Stack.of(this).region;

    const memorySize =
      props.memorySize ??
      computeResource.memorySize ??
      DEFAULT_LAMBDA_MEMORY_MB;
    // Defensive: the public L3 surface accepts `Duration | number` and
    // normalizes upstream, but a non-Duration value reaching us here
    // (e.g. internal caller mis-typed, or a permissive JS wrapper
    // bypassing the L3) would crash deep in aws-cdk-lib with
    // `props.timeout.toSeconds is not a function`. Throw a clear
    // error pointing at the misuse instead.
    if (props.timeout !== undefined && !(props.timeout instanceof Duration)) {
      throw new HostingError('InvalidTimeoutError', {
        message: `compute.timeout must be a cdk.Duration; received ${typeof props.timeout} (${String(props.timeout)}).`,
        resolution:
          'Pass `cdk.Duration.seconds(N)` or, at the L3 surface, a plain number of seconds (the L3 normalizes both).',
      });
    }
    const timeout =
      props.timeout ??
      Duration.seconds(
        computeResource.timeout ?? DEFAULT_LAMBDA_TIMEOUT_SECONDS,
      );

    // Explicit least-privilege role — only CloudWatch Logs
    const ssrRole = new Role(this, 'FunctionRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    const architecture = props.architecture ?? Architecture.X86_64;

    // Pre-create the Lambda log group with the desired retention. Replaces
    // the deprecated `Function#logRetention` prop (which transitively
    // creates a singleton custom-resource Lambda + log group); CDK warns
    // on every synth that the prop will be removed in the next major.
    // The explicit `LogGroup` lives at the canonical /aws/lambda/<fn>
    // path Lambda would default to, so wiring is byte-identical from
    // Lambda's POV — only the CFN graph changes shape.
    // 30-day default trades off CloudWatch storage cost (cheap; logs
    // are <$0.50/GB/month) against debugability of past incidents.
    // The previous TWO_WEEKS default routinely deleted the build that
    // first introduced a regression by the time the regression report
    // landed. Users can still override via `compute.logRetention`.
    const retention = props.logRetention ?? RetentionDays.ONE_MONTH;
    // Lambda@Edge does NOT get an explicit LogGroup: `experimental.EdgeFunction`
    // hoists into the us-east-1 edge-lambda-stack, but this LogGroup lives in
    // the stack's region — passing it cross-environment fails synth
    // ("Cannot use resource ... in a cross-environment fashion"). Edge logs
    // are written per-replica-region under CloudWatch's default
    // `/aws/lambda/us-east-1.<fn>` groups anyway, which the stack region's
    // LogGroup could never represent.
    const logGroup =
      computeResource.type === 'edge'
        ? undefined
        : new LogGroup(this, 'FunctionLogGroup', {
            retention,
            // Match the prior `logRetention`-driven default — the singleton
            // log-retention provider didn't retain log groups on stack delete.
            removalPolicy: RemovalPolicy.DESTROY,
          });

    // B2 (preview) — a `type: 'edge'` resource with `placement: 'regional'`
    // keeps the Next.js edge runtime bundle but runs as an ordinary regional
    // Lambda (fronted by a Function URL) instead of Lambda@Edge. Placement is
    // the source of truth for WHERE it runs, so route it through the plain
    // handler builder below and skip the `experimental.EdgeFunction` path.
    const isRegionalEdge =
      computeResource.type === 'edge' && computeResource.placement === 'regional';

    if (computeResource.type === 'handler' || isRegionalEdge) {
      // Native Lambda handler — no Web Adapter needed
      this.function = new LambdaFunction(this, 'Function', {
        runtime: this.resolveRuntime(computeResource.runtime, props.name),
        handler: computeResource.handler ?? 'index.handler',
        code: Code.fromAsset(computeResource.bundle),
        architecture,
        memorySize,
        timeout,
        reservedConcurrentExecutions: props.reservedConcurrency,
        role: ssrRole,
        logGroup,
        environment: {
          ...computeResource.environment,
          ...props.environment,
        },
      });
    } else if (computeResource.type === 'http-server') {
      // HTTP server mode — Lambda Web Adapter proxies HTTP traffic
      this.validateWebAdapterRegion(region, props.skipRegionValidation);

      const webAdapterVersion =
        props.webAdapterVersion ?? DEFAULT_WEB_ADAPTER_VERSION;
      const webAdapterLayerArn = `arn:aws:lambda:${region}:${LAMBDA_WEB_ADAPTER_ACCOUNT}:layer:${LAMBDA_WEB_ADAPTER_LAYER_NAME}:${webAdapterVersion}`;
      const port = computeResource.port ?? SSR_DEFAULT_PORT;

      this.function = new LambdaFunction(this, 'Function', {
        runtime: this.resolveRuntime(computeResource.runtime, props.name),
        handler: computeResource.entrypoint ?? 'run.sh',
        code: Code.fromAsset(computeResource.bundle),
        architecture,
        memorySize,
        timeout,
        reservedConcurrentExecutions: props.reservedConcurrency,
        role: ssrRole,
        logGroup,
        layers: [
          LayerVersion.fromLayerVersionArn(
            this,
            'WebAdapterLayer',
            webAdapterLayerArn,
          ),
        ],
        environment: {
          AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
          // Buffered when invoked via API Gateway's buffered HttpLambdaIntegration
          // (preview bypassCdn — no streaming Function URL); streaming otherwise
          // (Function URL / REST-API STREAM). A response_stream reply behind a
          // buffered invoke can't be parsed by API Gateway → 500.
          AWS_LWA_INVOKE_MODE: props.bufferedInvoke ? 'buffered' : 'response_stream',
          PORT: String(port),
          ...computeResource.environment,
          ...props.environment,
        },
      });
    } else if (computeResource.type === 'edge') {
      // Edge function — Lambda@Edge does not support env vars or Function URLs
      const hasManifestEnv =
        computeResource.environment &&
        Object.keys(computeResource.environment).length > 0;
      const hasPropsEnv =
        props.environment && Object.keys(props.environment).length > 0;
      if (hasManifestEnv || hasPropsEnv) {
        process.stderr.write(
          `⚠️  Edge compute '${props.name}' has environment variables which Lambda@Edge does not support. They will be stripped.\n`,
        );
      }
      const edgeMaxTimeout = 5; // viewer-request limit
      const requestedTimeout = computeResource.timeout ?? 5;
      if (requestedTimeout > edgeMaxTimeout) {
        process.stderr.write(
          `Warning: Lambda@Edge viewer-request timeout capped at ${edgeMaxTimeout}s (requested ${requestedTimeout}s)\n`,
        );
      }
      // Child id MUST be unique per edge compute. On the cross-region path
      // (stack region !== us-east-1) `experimental.EdgeFunction` hoists every
      // instance into ONE shared `edge-lambda-stack`; a literal `'EdgeFunction'`
      // id then collides on the 2nd edge route with "already a Construct with
      // name 'EdgeFunction'". Scoping the id by `props.name` (e.g. `edge1`,
      // `edge2`) gives each a distinct id in that shared stack. (In-region
      // deploys never collided — they scope under the unique outer construct.)
      this.function = new experimental.EdgeFunction(
        this,
        `EdgeFunction-${props.name}`,
        {
          runtime: this.resolveRuntime(computeResource.runtime, props.name),
          handler: computeResource.handler ?? 'index.handler',
          code: Code.fromAsset(computeResource.bundle),
          architecture,
          memorySize,
          timeout: Duration.seconds(Math.min(requestedTimeout, edgeMaxTimeout)),
          logGroup,
        },
      );
      // Note: EdgeFunction auto-deploys to us-east-1 regardless of stack region
    } else {
      throw new HostingError('UnsupportedComputeTypeError', {
        message: `Unsupported compute type: "${String(computeResource.type)}"`,
        resolution:
          'Use a supported compute type: handler, http-server, or edge.',
      });
    }

    // Provisioned-concurrency alias. The prop (L3 user surface) takes
    // precedence over the manifest value (adapter-derived). Created for any
    // non-edge compute when provisioning is requested — INCLUDING SSR, where
    // `skipFunctionUrl` is set: the REST API integration must target the warm
    // `live` alias (not `$LATEST`), or the provisioned instances sit idle.
    const provisionedConcurrency =
      props.provisionedConcurrency ?? computeResource.provisionedConcurrency;
    if (
      computeResource.type !== 'edge' &&
      provisionedConcurrency &&
      provisionedConcurrency > 0
    ) {
      this.alias = (this.function as LambdaFunction).addAlias('live', {
        provisionedConcurrentExecutions: provisionedConcurrency,
      });
    }

    // Function URL — skipped for Lambda@Edge (unsupported) or SSR (REST API
    // instead). A regional-placed edge route (B2) IS a normal Lambda, so it
    // gets a Function URL like any other regional compute origin.
    if ((computeResource.type !== 'edge' || isRegionalEdge) && !props.skipFunctionUrl) {
      const invokeMode =
        computeResource.streaming !== false
          ? InvokeMode.RESPONSE_STREAM
          : InvokeMode.BUFFERED;

      // Point the Function URL at the warm alias when one exists.
      const urlTarget = this.alias ?? this.function;
      this.functionUrl = urlTarget.addFunctionUrl({
        authType: FunctionUrlAuthType.AWS_IAM,
        invokeMode,
      });
    }
  }

  private resolveRuntime(runtime: string | undefined, name: string): Runtime {
    if (!runtime) {
      return Runtime.NODEJS_24_X;
    }
    if (runtime === 'nodejs24.x') {
      return Runtime.NODEJS_24_X;
    }
    if (runtime === 'nodejs22.x') {
      return Runtime.NODEJS_22_X;
    }
    if (runtime === 'nodejs20.x') {
      return Runtime.NODEJS_20_X;
    }
    if (runtime === 'nodejs18.x') {
      return Runtime.NODEJS_18_X;
    }
    throw new HostingError('UnsupportedRuntimeError', {
      message: `Compute resource '${name}' declares an unsupported runtime '${runtime}'.`,
      resolution:
        'Use one of: nodejs24.x, nodejs22.x, nodejs20.x, nodejs18.x. ' +
        'Omit the runtime to use the default (nodejs24.x).',
    });
  }

  private validateWebAdapterRegion(
    region: string,
    skipValidation?: boolean,
  ): void {
    if (
      !skipValidation &&
      !Token.isUnresolved(region) &&
      !LAMBDA_WEB_ADAPTER_SUPPORTED_REGIONS.has(region)
    ) {
      throw new HostingError('UnsupportedRegionError', {
        message: `Lambda Web Adapter layer is not available in region '${region}'.`,
        resolution:
          'SSR hosting requires a supported region. ' +
          'See https://github.com/awslabs/aws-lambda-web-adapter for supported regions.',
      });
    }
  }
}
