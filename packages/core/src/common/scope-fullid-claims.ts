// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one-path-per-`fullId` rule shared by the runtime/mock `Scope`
 * (`./index.ts`) and the CDK `Scope` (`../cdk/index.ts`).
 *
 * `fullId` joins scope ids with `-` and does not escape them, so two different
 * scope paths can resolve to one `fullId`: `user-service › sessions` and
 * `user › service-sessions` both yield `user-service-sessions`. Every name a
 * block derives from its `fullId` — its table, bucket or queue, its SDK
 * identifier registry entry, its local `.bb-data` directory — would then be
 * shared. Each `Scope` claims its `fullId` with the path it came from when it is
 * constructed, and a second claim from a different path is reported as a
 * warning (a future release will reject it). The same path claiming again is
 * the same block constructed again (a test, a reloaded module) and is accepted.
 * Both layers derive the path and word the warning here, so synth and the
 * runtime report the same collisions.
 *
 * Not re-exported from the package root.
 *
 * @module
 * @internal
 */

/**
 * The scope ids a `fullId` was joined from, root first.
 *
 * @internal
 */
export type ScopePath = readonly string[];

/**
 * The claims of one registry (process-wide at runtime, per backend root at synth).
 *
 * @internal
 */
export interface ScopeFullIdClaims {
	/** `fullId` → the path that claimed it first. */
	readonly owners: Map<string, ScopePath>;
	/** Every `fullId` a second path has claimed, so their descendants are not reported again. */
	readonly collided: Set<string>;
}

/** The fields the path walk reads: a scope, a `buildingBlockParent` stand-in, or a root. */
interface PathNode {
	readonly id?: string;
	readonly fullId?: string;
	readonly parent?: unknown;
}

function isPathNode(value: unknown): value is PathNode {
	return typeof value === 'object' && value !== null;
}

/**
 * The path of ids behind `fullId`, root first, such that joining it with `-`
 * gives `fullId` back. Ancestors with a parent of their own contribute their
 * `id`; the root contributes its `fullId` or `id` (none when it has neither,
 * e.g. a local scope with no `BLOCKS_STACK_NAME`). When a parent reports a
 * `fullId` that its ids do not join to, the path is that parent's `fullId` and
 * the scope's own id.
 *
 * @internal
 */
function scopePath(scope: { readonly id: string; readonly parent?: unknown }, fullId: string): ScopePath {
	const ids = [scope.id];
	let node: PathNode = scope;
	while (isPathNode(node.parent) && isPathNode(node.parent.parent) && typeof node.parent.id === 'string') {
		node = node.parent;
		ids.unshift(node.id as string);
	}
	const root = node.parent;
	const rootId = isPathNode(root) ? root.fullId || root.id : undefined;
	if (rootId) ids.unshift(rootId);
	if (ids.join('-') === fullId) return ids;
	return fullId === scope.id ? [scope.id] : [fullId.slice(0, fullId.length - scope.id.length - 1), scope.id];
}

/**
 * Claim `fullId` for the path `scope` came from, in `claims`. A claim from the
 * same path again is accepted. A claim from a different path keeps the first
 * owner and returns a warning that names the `fullId` and both paths, for the
 * caller to report (`console.warn` at runtime, a CDK annotation at synth). A
 * scope whose parent's `fullId` already collided returns no warning even when
 * it collides too (a block's own child scopes, under both colliding paths): the
 * parent's warning already names the paths to rename.
 *
 * @param claims - The registry to claim in.
 * @param scope - The scope being constructed.
 * @param fullId - Its `fullId`.
 * @returns The warning when a different scope path already claimed `fullId`
 *   and its parent's did not collide, else `undefined`.
 * @internal
 */
export function claimScopeFullId(
	claims: ScopeFullIdClaims,
	scope: { readonly id: string; readonly parent?: unknown },
	fullId: string,
): string | undefined {
	const path = scopePath(scope, fullId);
	const owner = claims.owners.get(fullId);
	if (owner === undefined) {
		claims.owners.set(fullId, path);
		return undefined;
	}
	if (owner.length === path.length && owner.every((id, i) => id === path[i])) return undefined;
	claims.collided.add(fullId);
	if (claims.collided.has(path.slice(0, -1).join('-'))) return undefined;
	const [mine, theirs] = [path, owner].map((p) => p.map((id) => `'${id}'`).join(' > '));
	return (
		`Scope ${mine} resolves to the fullId '${fullId}', which Scope ${theirs} already uses. ` +
		"Scope ids are joined with '-', so the two name the same resources (a table, bucket or queue, and " +
		"the local .bb-data directory) and read and overwrite each other's data. Rename one of the scopes " +
		'so their joined ids differ: a future release of AWS Blocks will reject this.'
	);
}
