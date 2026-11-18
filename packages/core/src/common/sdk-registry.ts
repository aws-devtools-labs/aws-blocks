// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * SDK Identifier Registry — centralized map of Building Block AWS resource identifiers.
 *
 * Each Building Block registers its AWS resource identifiers (table names, bucket names,
 * queue URLs, etc.) upon construction. Application code retrieves these identifiers via
 * {@link getSdkIdentifiers} to interact with BB-managed resources using the raw AWS SDK.
 *
 * This module serves a complementary role to `mock-data.ts`:
 * - `mock-data.ts` → provides local file paths for mock persistence (`.bb-data/`)
 * - `sdk-registry.ts` → provides AWS resource identifiers for SDK access
 *
 * Together, these two modules form the runtime discovery layer — `mock-data.ts` for
 * local development, and `sdk-registry.ts` for deployed AWS environments.
 *
 * @see {@link docs/guides/extending-with-existing-aws-resources.md} — "SDK Identifiers" section
 * @module
 */

type ResourceEntry = Record<string, string>;

const registry = new Map<string, ResourceEntry>();

/**
 * Register SDK identifiers for a Building Block instance.
 *
 * Called internally by Building Blocks during construction — **not intended for
 * application code**. Each BB registers its resolved AWS resource identifiers
 * (e.g., DynamoDB table name, S3 bucket name) so they can be retrieved later
 * via {@link getSdkIdentifiers}.
 *
 * If the same `fullId` is registered multiple times (e.g., a BB that manages
 * multiple resources), entries are merged — later calls augment rather than
 * replace earlier ones.
 *
 * @param fullId - The Building Block's fully-qualified scope ID (e.g., `"myapp-users"`).
 * @param identifiers - Key-value map of resource identifiers to register.
 *
 * @example
 * ```typescript
 * // Inside a Building Block constructor (internal use only):
 * registerSdkIdentifiers(this.fullId, { tableName: 'myapp-users' });
 * ```
 */
export function registerSdkIdentifiers(fullId: string, identifiers: Record<string, string>): void {
  registry.set(fullId, { ...registry.get(fullId), ...identifiers });
}

/**
 * Retrieve the SDK identifiers for a specific Building Block instance.
 *
 * This is the base (untyped) version that returns `Record<string, string>`.
 * For full type safety with per-BB return types, import the overloaded
 * `getSdkIdentifiers` from `@aws-blocks/blocks` instead.
 *
 * @param bb - Any object with a `fullId` property (typically a Building Block instance).
 * @returns A record of the BB's registered resource identifiers.
 *
 * @example
 * ```typescript
 * import { getSdkIdentifiers } from '@aws-blocks/blocks';
 * import { KVStore } from '@aws-blocks/bb-kv-store';
 * import { DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
 *
 * const store = new KVStore(scope, 'users', {});
 *
 * // Retrieve the underlying DynamoDB table name (typed via overloads)
 * const { tableName } = getSdkIdentifiers(store);
 *
 * // Use it with the raw AWS SDK for advanced operations
 * const client = new DynamoDBClient({});
 * const result = await client.send(new QueryCommand({
 *   TableName: tableName,
 *   KeyConditionExpression: 'pk = :pk',
 *   ExpressionAttributeValues: { ':pk': { S: 'user#123' } },
 * }));
 * ```
 *
 * @example
 * ```typescript
 * import { getSdkIdentifiers } from '@aws-blocks/blocks';
 * import { FileBucket } from '@aws-blocks/bb-file-bucket';
 * import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
 * import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
 *
 * const bucket = new FileBucket(scope, 'uploads', {});
 * const { bucketName } = getSdkIdentifiers(bucket);
 *
 * // Generate a presigned download URL
 * const url = await getSignedUrl(
 *   new S3Client({}),
 *   new GetObjectCommand({ Bucket: bucketName, Key: 'report.pdf' }),
 *   { expiresIn: 3600 },
 * );
 * ```
 */
export function getSdkIdentifiers(bb: { fullId: string }): Record<string, string> {
  return registry.get(bb.fullId) ?? {};
}

/**
 * Return a read-only snapshot of all registered SDK identifiers.
 *
 * Primarily useful for debugging, tooling, and diagnostics — lists every
 * Building Block that has registered identifiers in the current process.
 * The returned map is keyed by `fullId` with each value being the identifier
 * record for that BB.
 *
 * @returns A read-only `Map<fullId, identifiers>` of all registered entries.
 *
 * @example
 * ```typescript
 * import { getAllSdkIdentifiers } from '@aws-blocks/core';
 *
 * // Log all registered identifiers for debugging
 * for (const [fullId, ids] of getAllSdkIdentifiers()) {
 *   console.log(`${fullId}:`, ids);
 * }
 * // Output:
 * //   myapp-users: { tableName: 'myapp-users' }
 * //   myapp-uploads: { bucketName: 'myapp-uploads' }
 * //   myapp-auth: { userPoolId: 'us-east-1_abc', clientId: '123abc' }
 * ```
 */
export function getAllSdkIdentifiers(): ReadonlyMap<string, Record<string, string>> {
  return new Map(registry);
}

/**
 * Clear the SDK identifier registry. **For test cleanup only.**
 *
 * Resets the global registry to an empty state. Use this in test teardown
 * (`afterEach`) to prevent state leakage between test cases that construct
 * Building Blocks.
 *
 * @example
 * ```typescript
 * import { _resetSdkRegistry } from '@aws-blocks/core';
 * import { afterEach } from 'node:test';
 *
 * afterEach(() => {
 *   _resetSdkRegistry();
 * });
 * ```
 */
export function _resetSdkRegistry(): void {
  registry.clear();
}
