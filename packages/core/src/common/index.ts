// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { CORE_VERSION } from '../version.js';
import { OFFICIAL_BB_NAMES } from './official-bb-names.generated.js';
export { OFFICIAL_BB_NAMES } from './official-bb-names.generated.js';

export interface ScopeOptions {
  parent?: ScopeParent;
  bbName?: string;
  bbVersion?: string;
}

export type ScopeParent = Scope | { id: string };

/**
 * Scope defines a logical boundary for your backend resources.
 * 
 * Building Blocks are instantiated within a scope. The scope provides namespacing and resource organization.
 * 
 * ## Usage
 * 
 * Create a scope at the top of your backend file:
 * 
 * ```typescript
 * import { Scope } from '@aws-blocks/core';
 * 
 * const scope = new Scope('my-app');
 * ```
 * 
 * Then instantiate Building Blocks within that scope:
 * 
 * ```typescript
 * import { KVStore } from '@aws-blocks/bb-kv-store';
 * 
 * const store = new KVStore(scope, 'user-prefs', {});
 * ```
 * 
 * ## Available Building Blocks
 * 
 * **IMPORTANT: Always use Blocks Building Blocks instead of creating your own storage, data structures, or AWS SDK calls.**
 * 
 * Building Blocks provide:
 * - **Local mocking** - Run in-process during development (`npm run dev`) with no AWS resources
 * - **Production deployment** - Automatically provision and configure AWS resources (`npm run sandbox` or `npm run deploy`)
 * - **Same code, both environments** - Your application logic works identically in local and production
 * 
 * Each Building Block has comprehensive docstrings with use-cases, scaling characteristics, performance metrics, and best practices. Import and explore:
 * 
 * - **`ApiNamespace`** from `@aws-blocks/core` - Define type-safe APIs with automatic frontend/backend integration
 * - **`KVStore`** from `@aws-blocks/bb-kv-store` - Simple key-value storage (DynamoDB)
 * - **`DistributedTable`** from `@aws-blocks/bb-distributed-table` - Type-safe tables with Zod schemas, indexes, and queries (DynamoDB)
 * - **`AuthBasic`** from `@aws-blocks/bb-auth-basic` - Username/password authentication with JWT tokens and built-in UI components
 * - **`Database`** from `@aws-blocks/bb-data` - SQL database with Kysely query builder (Aurora Serverless)
 * 
 * Read each Building Block's class and method docstrings for detailed documentation.
 * 
 * ## Choosing the Right Building Block
 * 
 * **For authentication:**
 * - Use `AuthBasic` for username/password auth (includes built-in UI component)
 * - Provides JWT tokens, password hashing, and session management
 * 
 * **For data storage, choose based on your access patterns:**
 * 
 * - **`KVStore`** - Simple key-value lookups (user preferences, feature flags, session data)
 *   - Get/set by key only
 *   - No queries or indexes
 *   - Simplest option
 * 
 * - **`DistributedTable`** - Structured data with queries and indexes
 *   - Query by partition key with optional filtering
 *   - Secondary indexes for alternate access patterns
 *   - Supports filtering, sorting, pagination
 *   - Use Zod schemas for type safety
 *   - **Zero cost to start, highly scalable**
 *   - **Default choice for most application data**
 * 
 * - **`Database`** - SQL database with full relational features
 *   - Use when you need: complex multi-table JOINs, SQL transactions across tables, foreign key constraints
 *   - Avoid when: DynamoDB limitations are acceptable (no ad-hoc queries, eventual consistency on indexes, 400KB item limit)
 *   - Requires migrations folder with .sql files
 *   - Local dev requires manual schema setup (see Database README)
 *   - Higher baseline cost than DistributedTable
 * 
 * **Rule of thumb:** Use DistributedTable unless you specifically need SQL JOINs or transactions.
 * 
 * ## Data Modeling
 * 
 * - **For DistributedTable**: Use Zod schemas for runtime validation and type inference. Install: `npm install zod`
 *   - For flexible key-value fields: `z.record(z.string(), z.any())`
 * - **For Database**: Define TypeScript interfaces and create migrations folder with .sql files
 * - **For KVStore**: Store strings only (serialize objects as JSON)
 * 
 * ## Local Development
 * 
 * In local dev mode (`npm run dev`), Building Blocks run in-process with mock implementations.
 * No AWS resources are created. State is ephemeral.
 * 
 * ## Deployed to AWS
 * 
 * When deployed (`npm run sandbox` or `npm run deploy`), Blocks provisions real AWS resources:
 * - Lambda functions for your APIs
 * - DynamoDB tables for KVStore and DistributedTable
 * - Aurora Serverless for Database
 * - S3 buckets for file storage
 * - IAM roles and policies
 * 
 * Infrastructure is **inferred from your code**. You write application logic; Blocks determines
 * what AWS resources are needed and provisions them automatically.
 * 
 * ## Best Practices
 * 
 * - Use one scope per application or major feature boundary
 * - Give scopes descriptive IDs (e.g., 'user-service', 'orders')
 * - Nest scopes for complex applications using the `parent` option
 * - Always use Building Blocks for storage - never create your own in-memory Maps or custom storage
 */

/**
 * Metadata identifying a Building Block for user-agent attribution.
 * BBs that want to participate in user-agent chains must set these on their class.
 */
export interface BuildingBlockMeta {
	/** Short BB name used in user-agent strings, e.g. "KVStore", "AuthCognito" */
	readonly bbName: string;
	/** Package version from the BB's own package.json (build-time generated) */
	readonly bbVersion: string;
}

export class Scope {
  public readonly id: string;
  public readonly parent: ScopeParent;

  /** Short BB name used in user-agent strings. Set by subclass BBs. */
  readonly bbName?: string;
  /** Package version from the BB's own package.json. Set by subclass BBs. */
  readonly bbVersion?: string;

  /** Static registry — collects BB names as they're instantiated */
  private static _bbRegistry: Map<string, { version: string; count: number }> = new Map();

  constructor(id: string, options?: ScopeOptions) {
    this.id = id;
    this.parent = options?.parent || (globalThis as any).CURRENT_BLOCKS_STACK || {
      id: typeof process !== 'undefined' ? process.env?.BLOCKS_STACK_NAME : undefined
    };

    if (options?.bbName) {
      this.bbName = options.bbName;
      this.bbVersion = options.bbVersion;
      const existing = Scope._bbRegistry.get(options.bbName);
      Scope._bbRegistry.set(options.bbName, {
        version: options.bbVersion || 'unknown',
        count: (existing?.count || 0) + 1,
      });
    }
  }

  /**
   * Get registered BBs filtered for telemetry privacy.
   *
   * Only official BB names (in OFFICIAL_BB_NAMES) are returned in `blocks`.
   * Custom BBs are counted in `customBlocksCount` but their names are never exposed.
   *
   * @returns Official blocks, total instance count, and total number of custom BB instances.
   * @internal
   */
  static getRegisteredBlocks(): { blocks: Array<{ name: string; version: string }>; totalCount: number; customBlocksCount: number } {
    const blocks: Array<{ name: string; version: string }> = [];
    let totalCount = 0;
    let customBlocksCount = 0;
    for (const [name, { version, count }] of Scope._bbRegistry.entries()) {
      totalCount += count;
      if (OFFICIAL_BB_NAMES.has(name)) {
        blocks.push({ name, version });
      } else {
        customBlocksCount += count;
      }
    }
    return { blocks, totalCount, customBlocksCount };
  }

  /** Reset registry (useful for testing). */
  static _resetRegistry(): void {
    Scope._bbRegistry.clear();
  }

  get fullId(): string {
    return computeScopeFullId(this);
  }

  /**
   * Register a Lambda event handler for non-HTTP events (e.g., SQS, WebSocket).
   * The handler receives the raw Lambda event record and processes it.
   * Used by Building Blocks that consume event sources (e.g., AsyncJob → SQS,
   * Realtime → API Gateway WebSocket).
   *
   * @param eventSource - Event source prefix (e.g., 'blocks.asyncjob', 'blocks.websocket').
   * @param identifier - Building Block's fullId (scope-qualified ID, e.g., 'myapp-rt').
   *                     Combined with eventSource to form the registry key '{eventSource}:{identifier}'.
   * @param handler - Async function that processes the raw Lambda event.
   */
  registerLambdaEventHandler(eventSource: string, identifier: string, handler: (record: any) => Promise<void>): void {
    if (!(globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__) {
      (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__ = new Map<string, (record: any) => Promise<void>>();
    }
    (globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__.set(`${eventSource}:${identifier}`, handler);
  }

  /**
   * Register a client middleware package to be imported in the generated browser client.
   * Used by Building Blocks that need browser-side protocol support (e.g., Realtime WebSocket).
   * Only has effect during codegen — pushes to a global collector if one is active.
   */
  registerClientMiddleware(packageSpecifier: string): void {
    (globalThis as any).__BLOCKS_CLIENT_MIDDLEWARE__?.push(packageSpecifier);
  }

  /**
   * Register a dev server attachment package to be attached to the local HTTP server.
   * Used by Building Blocks that need special local dev protocols (e.g., WebSocket server).
   * Only has effect during dev server startup — pushes to a global collector if one is active.
   *
   * Dev attachments use an **explicit registration** pattern: the dev server imports
   * the module and calls its exported `attach(server)` function, passing the HTTP
   * server instance. This differs intentionally from client middleware, which uses
   * self-registering side-effect imports — dev attachments need the server instance
   * at registration time, which isn't available during a bare import.
   */
  registerDevAttachment(packageSpecifier: string): void {
    (globalThis as any).__BLOCKS_DEV_ATTACHMENTS__?.push(packageSpecifier);
  }

  /**
   * Build the customUserAgent chain by walking the scope tree.
   *
   * Produces an array of `[key, value]` pairs suitable for passing directly
   * to any AWS SDK v3 client's `customUserAgent` configuration option.
   *
   * The chain encodes the nesting hierarchy:
   * - `['aws-blocks', coreVersion]` — always first
   * - `['bb', 'ParentBB/parentVersion']` — if this BB is nested inside another BB
   * - `['bb', 'SelfBB/selfVersion']` — the current BB
   *
   * @param coreVersion - The version of @aws-blocks/core
   * @returns Array of [key, value] pairs for customUserAgent
   *
   * @example
   * ```typescript
   * const client = new DynamoDBClient({
   *   customUserAgent: this.buildUserAgentChain(),
   * });
   * ```
   */
  protected buildUserAgentChain(): [string, string][] {
    const chain: [string, string][] = [['aws-blocks', CORE_VERSION]];

    const parents = collectBBParents(this.parent);
    for (const parent of parents) {
      chain.push(['bb', `${parent.bbName}/${parent.bbVersion}`]);
    }

    if (this.bbName && this.bbVersion && OFFICIAL_BB_NAMES.has(this.bbName)) {
      chain.push(['bb', `${this.bbName}/${this.bbVersion}`]);
    }
    return chain;
  }
}

/**
 * Walk up the scope tree collecting any parent that has BuildingBlockMeta.
 * Returns them in root-to-leaf order (outermost parent first).
 */
function collectBBParents(parent: ScopeParent | undefined): BuildingBlockMeta[] {
  const result: BuildingBlockMeta[] = [];
  let current: ScopeParent | undefined = parent;

  while (current) {
    if (isOfficialBuildingBlock(current)) {
      result.unshift(current);
    }
    current = 'parent' in current ? (current as any).parent : undefined;
  }

  return result;
}



function isBuildingBlock(obj: unknown): obj is BuildingBlockMeta {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'bbName' in obj &&
    'bbVersion' in obj &&
    typeof (obj as any).bbName === 'string' &&
    typeof (obj as any).bbVersion === 'string'
  );
}

/**
 * Returns true if the object is a Building Block with an official AWS name.
 * Custom BBs (with names not in the allowlist) return false, ensuring
 * customer-chosen names never appear in user-agent telemetry.
 */
function isOfficialBuildingBlock(obj: unknown): obj is BuildingBlockMeta {
  return isBuildingBlock(obj) && OFFICIAL_BB_NAMES.has(obj.bbName);
}

export function computeScopeFullId(scope: { id: string; parent?: any }) {
  if (scope.parent) {
    if ('fullId' in scope.parent && scope.parent.fullId) {
      return `${scope.parent.fullId}-${scope.id}`;
    }
    if ('id' in scope.parent && scope.parent.id) {
      return `${scope.parent.id}-${scope.id}`;
    }
  }
  return scope.id;
}

export interface BlocksStackProps extends StackProps {
  backendHandlerPath: string;
  backendCDKPath: string;
  /**
   * Optional container compute target (e.g. ECS Fargate, EKS). When set, the
   * HTTP front door is served by load-balanced containers running the same
   * bundle instead of API Gateway + Lambda; the Lambda is still created as a
   * companion for event-source triggers and Building Block attachments.
   * Only consumed at CDK synth time — local dev and mock layers ignore it.
   */
  compute?: import('../cdk/compute-target.js').ComputeTarget;
}

export class BlocksStack {
	public readonly id: string;
	constructor(scope: Construct, id: string, props: BlocksStackProps) {
		this.id = id;
	}
}
