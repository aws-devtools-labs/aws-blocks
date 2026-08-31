// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { pathToFileURL } from 'node:url';
import { __PIPELINE_STAGE_SCOPE__ } from '@aws-blocks/pipeline';
import {
  type BlocksStackProps,
  type BlocksStack as BaseBlocksStack,
  type ScopeParent,
  type ScopeOptions,
  computeScopeFullId,
} from '../common/index.js';
import { setupBlocksInfra, BlocksBackend, assertCdkConditionActive } from './blocks-backend.js';
import { addBlocksStackMetadata } from './stack-metadata.js';
import { finalizeConfigRegistry } from './config-registry.js';
import { type BlocksDefaults, BlocksPresets } from './blocks-defaults.js';
import type { Compute } from './compute/compute.js';
import type { DefaultComputeFactory, LambdaShapedCompute } from './compute/default-compute-factory.js';

export {
	BlocksBackend,
	type BlocksBackendProps,
	type CoreBlocksBackendProps,
	SHARED_HANDLER_TIMEOUT_SECONDS,
} from './blocks-backend.js';
export { DEFAULT_NODE_RUNTIME } from './node-version.js';
export { blocksNodejsBundling } from './bundling.js';
export { SandboxDisableDeletionProtection } from './mixins.js';
export { registerConfig, finalizeConfigRegistry } from './config-registry.js';
export { ensureApiGatewayAccount } from './apigateway-account.js';
export {
  type BlocksDefaults,
  type BlocksThrottling,
  BlocksPresets,
} from './blocks-defaults.js';
export { synthGuard } from './synth-guard.js';
export type { ScopeOptions } from '../index.js';
export { ApiError, isBlocksError, hasAuthError, DEFAULT_API_ERROR_NAME } from '../errors.js';

/**
 * Core's `create()` props: the public {@link BlocksStackProps} plus the required
 * `defaultComputeFactory`. The umbrella (`@aws-blocks/blocks`) supplies the
 * factory (which builds a `LambdaCompute`) by spreading it onto the customer's
 * props; customers use {@link BlocksStackProps} and never set the factory.
 *
 * Kept separate (rather than a `create()` argument) so the factory travels with
 * the props object and core stays free of any concrete compute class.
 *
 * @internal
 */
export interface CoreBlocksStackProps extends BlocksStackProps {
  /** Builds the stack's default compute. Injected by `@aws-blocks/blocks`. */
  defaultComputeFactory: DefaultComputeFactory;
}

export class BlocksStack extends cdk.Stack implements BaseBlocksStack {
  public readonly id: string;
  public readonly backendHandlerPath: string;
  /** Shared IAM role assumed by all Blocks compute. Building Blocks grant to this role. */
  public readonly executionRole: cdk.aws_iam.IRole;
  /** Infrastructure defaults for Building Blocks created under this stack. */
  public readonly defaults: BlocksDefaults;
  /** The default compute (owns the Lambda function + API Gateway); set in `create()`. @internal */
  _defaultCompute?: Compute;

  /** The default compute's Lambda function. To be removed once consumers move to the multi-compute model. */
  get handler(): cdk.aws_lambda_nodejs.NodejsFunction {
    return this.requireDefaultCompute().fn;
  }
  /** The default compute's API Gateway REST API. To be removed once consumers move to the multi-compute model. */
  get gateway(): cdk.aws_apigateway.RestApi {
    return this.requireDefaultCompute().apiGateway;
  }
  /** The default compute's RPC endpoint URL. To be removed once consumers move to the multi-compute model. */
  get apiUrl(): string {
    return this.requireDefaultCompute().apiUrl;
  }
  /** The default compute's handler CloudWatch log group. `bb-logger` reconfigures its retention. */
  get handlerLogGroup(): cdk.aws_logs.ILogGroup {
    return this.requireDefaultCompute().logGroup;
  }

  private requireDefaultCompute(): LambdaShapedCompute {
    if (!this._defaultCompute) {
      throw new Error('Blocks stack not fully initialized — access .handler/.gateway/.apiUrl after BlocksStack.create() resolves.');
    }
    return this._defaultCompute as LambdaShapedCompute;
  }

  private constructor(scope: Construct, id: string, props: BlocksStackProps) {
    super(scope, id, props);
    this.id = id;
    this.backendHandlerPath = props.backendHandlerPath;
    this.defaults = props.defaults;

    // Set globalThis so Building Blocks attach directly to this stack
    (globalThis as any).CURRENT_BLOCKS_STACK = this;

    const infra = setupBlocksInfra(this, props, id);
    this.executionRole = infra.executionRole;
  }

  static async create(scope: Construct, id: string, props: CoreBlocksStackProps) {
    assertCdkConditionActive();

    // Detect ambient pipeline stage scope set by Pipeline appFile imports
    const pipelineScope = (globalThis as any)[__PIPELINE_STAGE_SCOPE__];
    const actualScope = pipelineScope || scope;

    const stack = new BlocksStack(actualScope, id, props);
    // Create the default compute before importing the backend: it OWNS the
    // Lambda function + API Gateway (which back .handler/.gateway/.apiUrl), and
    // a block reading `this.compute` in its constructor (during that import)
    // must resolve to it. The factory is supplied by the umbrella
    // @aws-blocks/blocks (which injects LambdaCompute) via props, so core never
    // imports the concrete compute class.
    stack._defaultCompute = props.defaultComputeFactory(stack);
    // file:// URL (not a raw path) so the cache-busting query works on Windows,
    // where an absolute path like `D:\...` is rejected as URL scheme `d:`.
    const backendUrl = pathToFileURL(props.backendCDKPath);
    backendUrl.searchParams.set('stack', id);
    const mod = await import(backendUrl.href);
    if (typeof mod.default === 'function') {
      try {
        await mod.default(stack);
      } catch (error) {
        throw new Error(`Error executing default export function for stack "${id}": ${error instanceof Error ? error.message : error}`, { cause: error });
      }
    }
    // Finalize BB config → S3 (after all BBs have registered their config)
    finalizeConfigRegistry(stack, stack.handler);

    new cdk.CfnOutput(stack, 'ApiUrl', { value: stack.apiUrl });

    addBlocksStackMetadata(stack);

    return stack;
  }
}

export class Scope extends Construct {
  public readonly id: string;
  public readonly parent: ScopeParent;

  readonly bbName?: string;
  readonly bbVersion?: string;

  /**
   * The owning stack/backend (the root of the Blocks construct tree), resolved
   * once at construction: the nearest BlocksStack/BlocksBackend up the construct
   * tree, or the ambient `globalThis.CURRENT_BLOCKS_STACK` fallback. All
   * root-derived accessors below read from this instead of each repeating the
   * tree walk.
   */
  private readonly root: BlocksStack | BlocksBackend;

  /**
   * Compute assigned at this node. Applies to this block and is inherited by
   * descendants (a nearer assignment wins). Covers both a handler assigned to a
   * specific compute and a scope-level default for its subtree. Internal until
   * the customer-facing surface exists.
   * @internal
   */
  _compute?: Compute;

  constructor(id: string, options?: ScopeOptions) {
    const parent = options?.parent || (globalThis as any).CURRENT_BLOCKS_STACK;
    super(parent, id);
    this.id = id;
    this.parent = parent;
    this.root = this.resolveRoot();
  }

  /**
   * Walk up the construct tree to the nearest owning BlocksStack/BlocksBackend;
   * fall back to the ambient `globalThis.CURRENT_BLOCKS_STACK`. Called once from
   * the constructor; the result is cached in {@link root}.
   */
  private resolveRoot(): BlocksStack | BlocksBackend {
    let current: Construct = this;
    while (current.node.scope) {
        current = current.node.scope as Construct;
        if (current instanceof BlocksStack || current instanceof BlocksBackend) {
            return current;
        }
    }
    // Fallback to the ambient stack. In production this is always a real
    // BlocksStack/BlocksBackend; the cast also admits the test doubles that set
    // globalThis.CURRENT_BLOCKS_STACK to a stub exposing the same surface.
    return (globalThis as any).CURRENT_BLOCKS_STACK as BlocksStack | BlocksBackend;
  }

  get handler() {
    return this.root.handler;
  }

  /**
   * The shared IAM role assumed by all Blocks compute. Building Blocks grant
   * their permissions to this role; CDK's `grant*()` / `addToPrincipalPolicy()`
   * route those grants to the role's default (inline) policy.
   */
  get executionRole(): cdk.aws_iam.IRole {
    return this.root.executionRole;
  }

  /**
   * The compute this block runs on: the nearest `_compute` assigned on this
   * block or an ancestor scope, else the owning stack/backend's default compute.
   *
   * For any app that doesn't assign a compute, this always resolves to the
   * default — so reads are a no-op refactor. `_compute` is internal
   * (test/framework) until the customer-facing surface exists; there is no
   * public option to set it yet.
   */
  get compute(): Compute {
    for (let current: ScopeParent | undefined = this; current; current = (current as Scope).parent) {
      const assigned = (current as Scope)._compute;
      if (assigned) return assigned;
    }
    const defaultCompute = this.root._defaultCompute;
    if (!defaultCompute) {
      throw new Error('Default compute not initialized — BlocksStack/BlocksBackend.create() must run before resolving `compute`.');
    }
    return defaultCompute;
  }

  /**
   * The backend entry file the owning BlocksStack/BlocksBackend runs — the
   * single handler entry shared across the whole app.
   */
  get backendHandlerPath(): string {
    return this.root.backendHandlerPath;
  }

  /**
   * The owning stack/backend's token-free root identity. This is the value the
   * runtime receives as `BLOCKS_STACK_NAME` and rebuilds `fullId` from, so
   * physical resource names (DynamoDB tables, env-var keys, IAM ARNs) derived
   * from `fullId` match byte-for-byte between synth and runtime — otherwise the
   * runtime looks up names that were never created. `BlocksBackend` exposes this
   * as `fullId` ({@link BlocksBackend.fullId}); `BlocksStack` as `id`.
   */
  get backendStackName(): string {
    const name = this.root instanceof BlocksBackend ? this.root.fullId : this.root.id;
    if (!name) {
      throw new Error('Owning Blocks stack/backend has no id to derive BLOCKS_STACK_NAME');
    }
    return name;
  }

  /**
   * The shared handler Lambda's CloudWatch log group (the default compute's).
   * Resolves the same way as {@link handler} — via the owning
   * BlocksStack/BlocksBackend. `bb-logger` uses this to reconfigure retention on
   * the single, framework-owned group rather than creating a second one that
   * would collide on the log-group name.
   */
  get handlerLogGroup(): cdk.aws_logs.ILogGroup {
    return this.root.handlerLogGroup;
  }

  get fullId(): string {
    return computeScopeFullId(this);
  }

  /**
   * The stack-wide infrastructure {@link BlocksDefaults} registered by
   * `BlocksStack.create` / `BlocksBackend.create`. Read these in a Building
   * Block's CDK constructor to resolve a durability value, letting a per-block
   * option override:
   *
   * ```ts
   * const removalPolicy = options?.removalPolicy ?? this.defaults.removalPolicy;
   * ```
   */
  get defaults(): BlocksDefaults {
    // Resolve the same way as handler/executionRole: walk up to the owning
    // BlocksStack/BlocksBackend and read its defaults, so several backends in
    // one stack each keep their own posture. Falls back to the ambient stack,
    // then to the production preset when none was registered.
    let current: Construct = this;
    while (current.node.scope) {
        current = current.node.scope as Construct;
        if (current instanceof BlocksStack || current instanceof BlocksBackend) {
            return current.defaults;
        }
    }
    const ambient = ((globalThis as any).CURRENT_BLOCKS_STACK as { defaults?: BlocksDefaults } | undefined)?.defaults;
    if (ambient) return ambient;
    // No owning BlocksStack/BlocksBackend in the tree and none ambient — this is
    // usually a deliberate test stub, but could be a real misconfiguration (a
    // block built outside any Blocks backend). Fall back to the safe production
    // posture, and log so it's debuggable if it fires unexpectedly.
    console.warn(
      `[Blocks] Scope "${this.id}" resolved infrastructure defaults with no owning ` +
      'BlocksStack/BlocksBackend in scope; falling back to BlocksPresets.production.',
    );
    return BlocksPresets.production;
  }

  protected buildUserAgentChain(): [string, string][] {
    return [];
  }

  // Plugin registration — no-ops in CDK context (plugins are only used at dev/build time)
  registerClientMiddleware(_packageSpecifier: string): void {}
  registerDevAttachment(_packageSpecifier: string): void {}
  registerLambdaEventHandler(_eventSource: string, _identifier: string, _handler: (record: any) => Promise<void>): void {}
  get clientMiddleware(): readonly string[] { return []; }
  get devAttachments(): readonly string[] { return []; }
}
