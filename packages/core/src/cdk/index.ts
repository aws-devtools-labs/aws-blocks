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
import { initializeVpc, finalizeVpc } from './vpc.js';
import type { BlocksVpcOptions, VpcRequirements } from './vpc-types.js';

export {
	BlocksBackend,
	type BlocksBackendProps,
	SHARED_HANDLER_TIMEOUT_SECONDS,
} from './blocks-backend.js';
export { DEFAULT_NODE_RUNTIME } from './node-version.js';
export { blocksNodejsBundling } from './bundling.js';
export { SandboxDisableDeletionProtection } from './mixins.js';
export { registerConfig, finalizeConfigRegistry } from './config-registry.js';
export {
  type BlocksDefaults,
  BlocksPresets,
} from './blocks-defaults.js';
export { synthGuard } from './synth-guard.js';
export type { ScopeOptions } from '../index.js';
export { ApiError, isBlocksError, hasAuthError, DEFAULT_API_ERROR_NAME } from '../errors.js';
export { getVpcContext } from './vpc.js';
export type { BlocksVpcOptions, VpcRequirements, VpcContext, SubnetRole } from './vpc-types.js';

export class BlocksStack extends cdk.Stack implements BaseBlocksStack {
  public readonly id: string;
  public readonly apiUrl: string;
  public readonly gateway: cdk.aws_apigateway.RestApi;
  public readonly handler: cdk.aws_lambda_nodejs.NodejsFunction;
  public readonly backendHandlerPath: string;
  /** Shared IAM role assumed by all Blocks compute. Building Blocks grant to this role. */
  public readonly executionRole: cdk.aws_iam.IRole;
  /** Infrastructure defaults for Building Blocks created under this stack. */
  public readonly defaults: BlocksDefaults;

  private _vpcOptions?: BlocksVpcOptions;

  private constructor(scope: Construct, id: string, props: BlocksStackProps) {
    super(scope, id, props);
    this.id = id;
    this.backendHandlerPath = props.backendHandlerPath;
    this.defaults = props.defaults;
    this._vpcOptions = props.vpc;

    // Set globalThis so Building Blocks attach directly to this stack
    (globalThis as any).CURRENT_BLOCKS_STACK = this;

    // Initialize VPC context before BBs are constructed (so BBs can discover it),
    // then set up infra once. Single path — the only difference is whether a VPC
    // context is threaded through.
    const vpcContext = props.vpc ? initializeVpc(this, props.vpc) : undefined;
    const infra = setupBlocksInfra(this, props, id, vpcContext);
    this.handler = infra.handler;
    this.gateway = infra.gateway;
    this.apiUrl = infra.apiUrl;
    this.executionRole = infra.executionRole;
  }

  static async create(scope: Construct, id: string, props: BlocksStackProps) {
    assertCdkConditionActive();

    // Detect ambient pipeline stage scope set by Pipeline appFile imports
    const pipelineScope = (globalThis as any)[__PIPELINE_STAGE_SCOPE__];
    const actualScope = pipelineScope || scope;

    const stack = new BlocksStack(actualScope, id, props);
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

    // Finalize VPC: pull requirements from BBs → deduplicate → provision endpoints
    if (stack._vpcOptions) {
      finalizeVpc(stack, stack._vpcOptions);
    }

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

/**
 * Abstract base class for Building Block CDK constructs that declare VPC requirements.
 *
 * BBs extend this instead of `Scope` directly. The framework calls
 * `getVpcRequirements()` at finalization time (only when a VPC is configured)
 * to collect gateway/interface endpoint needs and provision them centrally.
 */
export abstract class BuildingBlockScope extends Scope {
  /**
   * Declare what VPC resources this BB needs when deployed in a VPC.
   * Called at finalization time ONLY when a VPC is configured.
   *
   * Return an empty object `{}` if no VPC-specific resources are needed.
   */
  abstract getVpcRequirements(): VpcRequirements;
}
