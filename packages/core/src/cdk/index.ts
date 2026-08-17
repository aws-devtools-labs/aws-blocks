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

export {
	BlocksBackend,
	type BlocksBackendProps,
	SHARED_HANDLER_TIMEOUT_SECONDS,
} from './blocks-backend.js';
export { DEFAULT_NODE_RUNTIME } from './node-version.js';
export { SandboxDisableDeletionProtection } from './mixins.js';
export { registerConfig, finalizeConfigRegistry } from './config-registry.js';
export { synthGuard } from './synth-guard.js';
export type { ScopeOptions } from '../index.js';
export { ApiError, isBlocksError, hasAuthError, DEFAULT_API_ERROR_NAME } from '../errors.js';

export class BlocksStack extends cdk.Stack implements BaseBlocksStack {
  public readonly id: string;
  public readonly apiUrl: string;
  public readonly gateway: cdk.aws_apigateway.RestApi;
  public readonly handler: cdk.aws_lambda_nodejs.NodejsFunction;
  public readonly backendHandlerPath: string;
  /** Shared IAM role assumed by all Blocks compute. Building Blocks grant to this role. */
  public readonly executionRole: cdk.aws_iam.IRole;

  private constructor(scope: Construct, id: string, props: BlocksStackProps) {
    super(scope, id, props);
    this.id = id;
    this.backendHandlerPath = props.backendHandlerPath;

    // Set globalThis so Building Blocks attach directly to this stack
    (globalThis as any).CURRENT_BLOCKS_STACK = this;

    const infra = setupBlocksInfra(this, props, id);
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

  constructor(id: string, options?: ScopeOptions) {
    const parent = options?.parent || (globalThis as any).CURRENT_BLOCKS_STACK;
    super(parent, id);
    this.id = id;
    this.parent = parent;
  }

  get handler() {
    // Walk up the construct tree to find the owning BlocksStack/BlocksBackend
    let current: Construct = this;
    while (current.node.scope) {
        current = current.node.scope as Construct;
        if (current instanceof BlocksStack || current instanceof BlocksBackend) {
            return current.handler;
        }
    }
    // Fallback to globalThis for backward compatibility
    return ((globalThis as any).CURRENT_BLOCKS_STACK as { handler: cdk.aws_lambda_nodejs.NodejsFunction }).handler;
  }

  /**
   * The shared IAM role assumed by all Blocks compute. Building Blocks grant
   * their permissions to this role instead of to an individual function's
   * auto-role. CDK's `grant*()` / `addToPrincipalPolicy()` route those grants
   * to the role's default (inline) policy — exactly where they landed on the
   * auto-generated role before.
   *
   * Resolves the same way as {@link handler}: walk up to the owning
   * BlocksStack/BlocksBackend, falling back to the ambient stack.
   */
  get executionRole(): cdk.aws_iam.IRole {
    let current: Construct = this;
    while (current.node.scope) {
        current = current.node.scope as Construct;
        if (current instanceof BlocksStack || current instanceof BlocksBackend) {
            return current.executionRole;
        }
    }
    // Fallback to globalThis for backward compatibility
    return ((globalThis as any).CURRENT_BLOCKS_STACK as { executionRole: cdk.aws_iam.IRole }).executionRole;
  }

  get fullId(): string {
    return computeScopeFullId(this);
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
