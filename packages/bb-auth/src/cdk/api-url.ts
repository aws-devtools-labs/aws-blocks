// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The backend's API Gateway RPC URL, as the CDK layer sees it.
 *
 * Since core's shared stack-level gateway, the REST API belongs to the backend
 * root (`BlocksStack` / `BlocksBackend`), not to the compute, and it is built
 * by `create()` only after the backend module has been imported — so it does
 * not exist yet while `Auth` is being constructed. Reading the root's `apiUrl`
 * then throws ("not fully initialized"). Everything here is therefore lazy: the
 * URL is produced when the template (or the config registry, which `create()`
 * finalizes after building the gateway) resolves the token.
 *
 * @internal
 */

import { type BuildingBlockScope, getBlocksRoot } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';

/** The RPC prefix the backend's `apiUrl` ends with (`BLOCKS_RPC_PREFIX` in core). */
export const RPC_PREFIX = '/aws-blocks/api';

/**
 * The backend's RPC URL (`https://<api>.execute-api.<region>.amazonaws.com/<stage>/aws-blocks/api`),
 * or `undefined` when there is none: the shared gateway of the owning backend
 * root once `create()` has built it, else the legacy `apiUrl` of the block's
 * compute (test doubles still model the compute-owned gateway). Call only at
 * token-resolution time.
 */
export function resolvedBackendApiUrl(scope: BuildingBlockScope): string | undefined {
	let fromRoot: unknown;
	try {
		fromRoot = Reflect.get(getBlocksRoot(scope), 'apiUrl');
	} catch {
		fromRoot = undefined; // gateway not built (not created through `create()`), or no root
	}
	if (typeof fromRoot === 'string') return fromRoot;
	let compute: unknown;
	try {
		compute = scope.compute;
	} catch {
		return undefined; // no stack-level compute (a bare test double)
	}
	const url: unknown = typeof compute === 'object' && compute !== null ? Reflect.get(compute, 'apiUrl') : undefined;
	return typeof url === 'string' ? url : undefined;
}

/**
 * {@link resolvedBackendApiUrl} as a lazy token. When it resolves to nothing,
 * synthesis fails with `missing()`'s message rather than deploying a broken
 * value.
 */
export function lazyBackendApiUrl(scope: BuildingBlockScope, missing: () => string): string {
	return cdk.Lazy.string({
		produce: () => {
			const url = resolvedBackendApiUrl(scope);
			if (url === undefined) throw new Error(missing());
			return url;
		},
	});
}
