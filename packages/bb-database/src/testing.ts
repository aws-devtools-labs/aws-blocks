// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test helpers for `@aws-blocks/bb-database`. Import them from
 * `@aws-blocks/bb-database/testing`; they are not part of the block's runtime API.
 */
import { internalAccess } from './internal.js';
import type { ClusterRef } from './types.js';

/** The shape every entry point's `Database` satisfies. */
interface DatabaseLike {
	readonly cluster: ClusterRef;
	readonly schemaName: string;
}

/**
 * Local mode only: make `db`'s next commit fail with `SerializationFailure`
 * (SQLSTATE `40001`, HTTP 409, retriable), so retry logic can be exercised
 * without a deployed cluster. Throws in the Lambda runtime, where a conflict
 * comes from the cluster itself, and during CDK synth.
 *
 * @example
 * import { simulateConflict } from '@aws-blocks/bb-database/testing';
 *
 * simulateConflict(shop);
 * // The callback runs twice: the first commit conflicts, the retry commits.
 * await shop.transaction(async (tx) => { await tx.execute(sql`UPDATE orders SET total = 0`); }, { retryOnConflict: true });
 */
export function simulateConflict(db: DatabaseLike): void {
	internalAccess(db, 'simulateConflict()').simulateConflict();
}
