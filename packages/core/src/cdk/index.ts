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
import type { ComputeApiOrigin, ComputeBindContext, ComputeTarget } from './compute-target.js';

export { BlocksBackend, type BlocksBackendProps } from './blocks-backend.js';
export type {
  ComputeTarget,
  ComputeBindContext,
  ComputeBindResult,
  ComputeApiOrigin,
  ComputePrincipal,
} from './compute-target.js';
export { DEFAULT_NODE_RUNTIME } from './node-version.js';
export { SandboxDisableDeletionProtection } from './mixins.js';
export { registerConfig, finalizeConfigRegistry, getConfigDeployment } from './config-registry.js';
export { synthGuard } from './synth-guard.js';
export type { ScopeOptions } from '../index.js';
export { ApiError, isBlocksError, hasAuthError, DEFAULT_API_ERROR_NAME } from '../errors.js';

export class BlocksStack extends cdk.Stack implements BaseBlocksStack {
  public readonly id: string;
  public readonly apiUrl: string;
  public readonly handler: cdk.aws_lambda_nodejs.NodejsFunction;
  public readonly backendHandlerPath: string;
  /**
   * Structured HTTP origin for the API. Only set in container-compute mode,
   * where `apiUrl` has no API Gateway stage segment for consumers to parse.
   */
  public readonly apiOrigin?: ComputeApiOrigin;
  private readonly _gateway?: cdk.aws_apigateway.RestApi;
  private readonly _compute?: ComputeTarget;
  private readonly _computeCtx?: ComputeBindContext;

  /**
   * The API Gateway REST API fronting the Lambda. Not available when a
   * container compute target is configured — the container's load balancer
   * is the front door and no REST API is created.
   */
  public get gateway(): cdk.aws_apigateway.RestApi {
    if (!this._gateway) {
      throw new Error(
        'BlocksStack.gateway is not available: this stack uses a container compute target, ' +
        'so no API Gateway is created. Use `apiUrl` / `apiOrigin` for the HTTP front door.',
      );
    }
    return this._gateway;
  }

  private constructor(scope: Construct, id: string, props: BlocksStackProps) {
    super(scope, id, props);
    this.id = id;
    this.backendHandlerPath = props.backendHandlerPath;

    // Set globalThis so Building Blocks attach directly to this stack
    (globalThis as any).CURRENT_BLOCKS_STACK = this;

    const infra = setupBlocksInfra(this, props, id);
    this.handler = infra.handler;
    this._gateway = infra.gateway;
    this.apiUrl = infra.apiUrl;
    this.apiOrigin = infra.apiOrigin;
    this._compute = props.compute;
    this._computeCtx = infra.computeCtx;
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

    // Late hook: every Building Block has attached env vars and grants by now,
    // so the compute target can mirror the handler environment into its
    // container definition and sequence container boot after the config upload.
    if (stack._compute && stack._computeCtx) {
      stack._compute.finalize(stack._computeCtx);
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
