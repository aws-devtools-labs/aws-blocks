// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import { CfnGroup } from 'aws-cdk-lib/aws-resourcegroups';
import { Construct } from 'constructs';
import { pathToFileURL } from 'node:url';
import { DEFAULT_NODE_RUNTIME } from './node-version.js';
import { addBlocksStackMetadata } from './stack-metadata.js';
import { finalizeConfigRegistry, registerConfig } from './config-registry.js';
import { BLOCKS_NAMESPACE, BLOCKS_RPC_PREFIX } from '../constants.js';
import { registerBuiltinRoutes } from '../builtin-routes.js';

/**
 * Validate that the Node.js process was started with `--conditions=cdk`.
 *
 * Without this condition, conditional exports in Building Block packages
 * resolve to their mock/default entry points instead of the CDK entry points.
 * This causes a silent deployment failure: CDK synth "succeeds" but produces
 * no real infrastructure (no tables, no IAM, no Lambda configs).
 */
export function assertCdkConditionActive(): void {
  const nodeOptions = process.env.NODE_OPTIONS ?? '';
  const execArgv = process.execArgv ?? [];

  const hasCdkCondition =
    execArgv.some(arg => arg === '--conditions=cdk') ||
    execArgv.some((arg, i) => (arg === '--conditions' || arg === '-C') && execArgv[i + 1] === 'cdk') ||
    nodeOptions.includes('--conditions=cdk') ||
    /(?:--conditions|-C)\s+cdk/.test(nodeOptions);

  if (!hasCdkCondition) {
    throw new Error(
      'Missing --conditions=cdk: Building Blocks will silently load mock implementations instead of CDK constructs.\n\n' +
      'Fix: Set NODE_OPTIONS="--conditions=cdk" before running CDK synth:\n' +
      '  NODE_OPTIONS="--conditions=cdk" npx cdk synth\n\n' +
      'Or use the Blocks CLI commands (npm run deploy / npm run sandbox) which set this automatically.',
    );
  }
}

export interface BlocksBackendProps {
  backendHandlerPath: string;
  backendCDKPath: string;
}

/** Shared infra setup — creates Lambda + API Gateway on the given scope. */
export function setupBlocksInfra(scope: Construct, props: BlocksBackendProps, id?: string) {
  const handler = new lambda.NodejsFunction(scope, 'Handler', {
    entry: props.backendHandlerPath,
    runtime: DEFAULT_NODE_RUNTIME,
    handler: 'handler',
    memorySize: 2048,
    timeout: cdk.Duration.seconds(60 * 15),
    environment: {
      NODE_ENV: 'production',
      /**
       * BLOCKS_STACK_NAME is used at runtime to derive physical resource names
       * (DynamoDB table names, env var prefixes). It must match the CDK-time
       * fullId of the BlocksStack/BlocksBackend so resource lookups work correctly.
       *
       * For BlocksStack: this equals the stack name (id).
       * For BlocksBackend: the caller overrides this after construction to include
       * the parent stack name for deployment uniqueness.
       */
      BLOCKS_STACK_NAME: id ?? cdk.Stack.of(scope).stackName,
    },
    bundling: {
      minify: true,
      esbuildArgs: { '--conditions': 'aws-runtime' },
    },
  });

  // In sandbox mode, allow localhost origins so the local dev frontend can
  // reach the deployed Lambda API via CORS.
  const isSandbox =
    scope.node.tryGetContext('sandboxMode') === 'true' ||
    scope.node.tryGetContext('sandboxMode') === true;
  if (isSandbox) {
    handler.addEnvironment('CORS_ALLOWED_ORIGINS', '^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$');
  }

  const accessLogGroup = new logs.LogGroup(scope, 'ApiAccessLogs', {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const api = new apigateway.RestApi(scope, 'API', {
    restApiName: 'Blocks API',
    deployOptions: {
      cachingEnabled: false,
      // Steady-state cap: 100 requests/second sustained across the stage,
      // enforced by API Gateway's token-bucket refill rate.
      throttlingRateLimit: 100,
      // Burst cap: token-bucket depth allowing up to 200 concurrent requests
      // to absorb short spikes above the steady-state rate before throttling (429s).
      throttlingBurstLimit: 200,
      accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
      accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
        ip: true,
        httpMethod: true,
        resourcePath: true,
        status: true,
        responseLength: true,
        requestTime: true,
        caller: true,
        user: true,
        protocol: true,
      }),
    },
  });

  const integration = new apigateway.LambdaIntegration(handler);

  // Build the nested resource tree for /aws-blocks/api.
  // Intermediate resource gets a proxy so sub-paths (RawRoutes) still reach Lambda.
  const awsBlocksResource = api.root.addResource(BLOCKS_NAMESPACE.slice(1));
  awsBlocksResource.addProxy({ defaultIntegration: integration, anyMethod: true });
  
  const apiResource = awsBlocksResource.addResource('api');
  apiResource.addMethod('POST', integration);
  apiResource.addMethod('OPTIONS', integration);

  api.root.addProxy({ defaultIntegration: integration, anyMethod: true });

  // ── Resource Groups ────────────────────────────────────────────────────
  let rootStack = cdk.Stack.of(scope);
  while (rootStack.nestedStackParent) rootStack = rootStack.nestedStackParent;
  const groupPrefix = (id && id !== rootStack.stackName) ? `${rootStack.stackName}-${id}` : rootStack.stackName;

  new CfnGroup(scope, 'StackResources', {
    name: `${groupPrefix}-resources`,
    resourceQuery: {
      type: 'CLOUDFORMATION_STACK_1_0',
      query: {
        resourceTypeFilters: [
          'AWS::CloudWatch::Dashboard',
          'AWS::Cognito::UserPool',
          'AWS::DynamoDB::Table',
          'AWS::Logs::LogGroup',
          'AWS::RDS::DBCluster',
          'AWS::RDS::DBInstance',
          'AWS::S3::Bucket',
          'AWS::SQS::Queue',
        ],
        stackIdentifier: cdk.Stack.of(scope).stackId,
      },
    },
  });

  new CfnGroup(scope, 'StackSettings', {
    name: `${groupPrefix}-settings`,
    resourceQuery: {
      type: 'TAG_FILTERS_1_0',
      query: {
        resourceTypeFilters: ['AWS::SSM::Parameter'],
        tagFilters: [{ key: 'aws-blocks-stack', values: [rootStack.stackName] }],
      },
    },
  });

  // ── Console redirect routes ────────────────────────────────────────────
  const region = cdk.Fn.ref('AWS::Region');
  const resourcesUrl = cdk.Fn.join('', [
    'https://', region, '.console.aws.amazon.com/resource-groups/group/',
    `${groupPrefix}-resources`, '?region=', region,
  ]);
  const settingsUrl = cdk.Fn.join('', [
    'https://', region, '.console.aws.amazon.com/resource-groups/group/',
    `${groupPrefix}-settings`, '?region=', region,
  ]);

  registerConfig(scope, 'BB_RESOURCES_GROUP_URL', resourcesUrl);
  registerConfig(scope, 'BB_SETTINGS_GROUP_URL', settingsUrl);

  registerBuiltinRoutes();

  return { handler, gateway: api, apiUrl: `${api.url}${BLOCKS_RPC_PREFIX.slice(1)}` };
}

/**
 * Standalone CDK construct that provisions the Blocks backend: a single Lambda
 * function fronted by API Gateway with RPC + catch-all proxy routing.
 *
 * Use this to embed a Blocks backend into any existing CDK stack. Building Blocks
 * instantiated during the `backendCDKPath` import will automatically attach to
 * this construct's Lambda handler.
 *
 * @example Drop into an existing stack
 * ```ts
 * const blocks = await BlocksBackend.create(myStack, 'Blocks', {
 *   backendHandlerPath: join(__dirname, 'handler.ts'),
 *   backendCDKPath: join(__dirname, 'infra.ts'),
 * });
 * // blocks.apiUrl, blocks.handler, blocks.gateway available
 * ```
 */
export class BlocksBackend extends Construct {
  public readonly apiUrl: string;
  public readonly gateway: apigateway.RestApi;
  public readonly handler: cdk.aws_lambda_nodejs.NodejsFunction;
  public readonly backendHandlerPath: string;

  /**
   * The fullId used by child Scopes to compute their env var names,
   * construct IDs, and physical resource names (e.g., DynamoDB table names).
   *
   * Includes the CDK stack name to ensure physical resources are unique
   * per deployment. This matches what the runtime sees via BLOCKS_STACK_NAME.
   *
   * IMPORTANT: this value MUST be token-free. Child Scopes embed `fullId` in
   * CDK construct IDs (e.g. `${fullId}DsqlMigrationFn`), and CDK forbids
   * unresolved tokens in construct IDs ("ID components may not include
   * unresolved tokens"). It is also used to build env-var keys that must match
   * byte-for-byte between synth time and runtime.
   *
   * A nested stack (e.g. Amplify Gen2 `backend.createStack('blocks')`) has a
   * tokenized `stackName` that only resolves at deploy time. We therefore walk
   * up to the top-level stack, whose name is concrete at synth time and still
   * unique per deployment. The `Token.isUnresolved` guard is a defensive
   * fallback to the (token-free) construct id should no resolvable name exist.
   */
  get fullId(): string {
    let stack = cdk.Stack.of(this);
    while (stack.nestedStackParent) {
      stack = stack.nestedStackParent;
    }
    const stackName = stack.stackName;
    if (cdk.Token.isUnresolved(stackName)) {
      return this.node.id;
    }
    return `${stackName}-${this.node.id}`;
  }

  private constructor(scope: Construct, id: string, props: BlocksBackendProps) {
    super(scope, id);

    this.backendHandlerPath = props.backendHandlerPath;

    // Expose self to Building Blocks at CDK time
    (globalThis as any).CURRENT_BLOCKS_STACK = this;

    const infra = setupBlocksInfra(this, props, id);
    this.handler = infra.handler;
    this.gateway = infra.gateway;
    this.apiUrl = infra.apiUrl;

    // Override BLOCKS_STACK_NAME to include the parent stack name so runtime
    // resource lookups (DynamoDB table names) match the CDK-time fullId
    // and are unique per deployment.
    this.handler.addEnvironment('BLOCKS_STACK_NAME', this.fullId);
  }

  static async create(scope: Construct, id: string, props: BlocksBackendProps) {
    assertCdkConditionActive();
    const backend = new BlocksBackend(scope, id, props);
    // file:// URL (not a raw path) so the cache-busting query works on Windows,
    // where an absolute path like `D:\...` is rejected as URL scheme `d:`.
    const backendUrl = pathToFileURL(props.backendCDKPath);
    backendUrl.searchParams.set('stack', id);
    const mod = await import(backendUrl.href);
    if (typeof mod.default === 'function') {
      try {
        await mod.default(backend);
      } catch (error) {
        throw new Error(`Error executing default export function for backend "${id}": ${error instanceof Error ? error.message : error}`, { cause: error });
      }
    }
    addBlocksStackMetadata(cdk.Stack.of(backend));

    // Finalize BB config → S3 (after all BBs have registered their config)
    finalizeConfigRegistry(backend, backend.handler);

    return backend;
  }
}
