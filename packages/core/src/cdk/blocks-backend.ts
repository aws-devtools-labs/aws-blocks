// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnGroup } from 'aws-cdk-lib/aws-resourcegroups';
import { Construct } from 'constructs';
import { pathToFileURL } from 'node:url';
import { addBlocksStackMetadata } from './stack-metadata.js';
import { finalizeConfigRegistry, registerConfig } from './config-registry.js';
import type { BlocksDefaults } from './blocks-defaults.js';
import { registerBuiltinRoutes } from '../builtin-routes.js';
import type { Compute } from './compute/compute.js';
import { getComputes } from './compute/compute-registry.js';
import type { DefaultComputeFactory, LambdaShapedCompute } from './compute/default-compute-factory.js';

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
  /**
   * Stack-wide infrastructure defaults applied to every Building Block (removal
   * policy, deletion protection, …). See {@link BlocksDefaults}. Start from
   * `BlocksPresets.sandbox` or `BlocksPresets.production` and override
   * individual fields as needed. A per-block option always wins over the
   * corresponding stack default.
   */
  defaults: BlocksDefaults;
}

/**
 * Shared infra setup — provisions the stack-level resources that are NOT owned
 * by a compute: the shared execution role, resource groups, and console-redirect
 * routes.
 */
export function setupBlocksInfra(scope: Construct, props: BlocksBackendProps, id?: string) {
  // Fail fast with an actionable message at the create() call site if `defaults`
  // is missing (e.g. a plain-JS caller, `as any`, or a dynamically-built props
  // object) — otherwise the first Building Block to read `scope.defaults` throws
  // a cryptic `Cannot read properties of undefined (reading 'removalPolicy')`.
  if (!props.defaults) {
    throw new Error(
      'BlocksStack/BlocksBackend requires a `defaults` field. Pass a posture from ' +
      '`@aws-blocks/core/cdk` — typically `defaults: sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`.',
    );
  }

  // ── Shared execution role ───────────────────────────────────────────────
  // A single IAM role that every Building Block grants to. Provisioned here so
  // it exists before the backend module is imported (Building Blocks reach it
  // via `scope.executionRole`). Block grants sit on the role's default (inline)
  // policy. AWSLambdaBasicExecutionRole is attached so compute functions retain
  // CloudWatch Logs permissions.
  const executionRole = new iam.Role(scope, 'BlocksRole', {
    // CompositePrincipal (rather than a bare ServicePrincipal) so additional
    // compute types can assume this same shared role as they are introduced
    // (e.g. ECS tasks via ecs-tasks.amazonaws.com), by adding principals here.
    assumedBy: new iam.CompositePrincipal(new iam.ServicePrincipal('lambda.amazonaws.com')),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    ],
  });

  // ── Resource Groups ───────────────────────────────────────────────────
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

  // ── Console redirect routes ───────────────────────────────────────────
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

  return { executionRole };
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
  public readonly backendHandlerPath: string;
  /** Shared IAM role assumed by all Blocks compute. Building Blocks grant to this role. */
  public readonly executionRole: iam.IRole;
  /** Infrastructure defaults for Building Blocks created under this backend. */
  public readonly defaults: BlocksDefaults;
  /** The default compute (owns the Lambda function + API Gateway); set in `create()`. @internal */
  _defaultCompute?: Compute;

  /**
   * The computes in this backend.
   * @internal
   */
  get computes(): readonly Compute[] {
    return getComputes(this);
  }

  /** The default compute's Lambda function. To be removed once consumers move to the multi-compute model. */
  get handler(): cdk.aws_lambda_nodejs.NodejsFunction {
    return this.requireDefaultCompute().fn;
  }
  /** The default compute's API Gateway REST API. To be removed once consumers move to the multi-compute model. */
  get gateway(): apigateway.RestApi {
    return this.requireDefaultCompute().apiGateway;
  }
  /** The default compute's RPC endpoint URL. To be removed once consumers move to the multi-compute model. */
  get apiUrl(): string {
    return this.requireDefaultCompute().apiUrl;
  }

  private requireDefaultCompute(): LambdaShapedCompute {
    if (!this._defaultCompute) {
      throw new Error('Blocks backend not fully initialized — access .handler/.gateway/.apiUrl after BlocksBackend.create() resolves.');
    }
    return this._defaultCompute as LambdaShapedCompute;
  }

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

    // Store defaults on the backend (not the stack) so several BlocksBackends
    // in one stack each keep their own posture; Building Blocks resolve them by
    // walking up to their owning backend (see Scope.defaults).
    this.defaults = props.defaults;

    const infra = setupBlocksInfra(this, props, id);
    this.executionRole = infra.executionRole;
    // The default compute (and thus handler/gateway) is created in create(),
    // after construction — it derives BLOCKS_STACK_NAME from this.fullId.
  }

  static async create(scope: Construct, id: string, props: BlocksBackendProps, defaultComputeFactory: DefaultComputeFactory) {
    assertCdkConditionActive();
    const backend = new BlocksBackend(scope, id, props);
    // Create the default compute before importing the backend: it OWNS the
    // Lambda function + API Gateway (which back .handler/.gateway/.apiUrl), and
    // a block reading `this.compute` in its constructor (during that import)
    // must resolve to it. The factory is supplied by the umbrella
    // @aws-blocks/blocks (which injects LambdaCompute), so core never imports
    // the concrete compute class.
    backend._defaultCompute = defaultComputeFactory(backend);
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
    finalizeConfigRegistry(backend, backend.executionRole, backend.computes);

    return backend;
  }
}
