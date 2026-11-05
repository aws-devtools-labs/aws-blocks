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
 * constructed, and a second claim from a different path throws. The same path
 * claiming again is the same block constructed again (a test, a reloaded
 * module) and is accepted. Both layers derive the path and word the error here,
 * so a configuration that synth accepts is one the runtime accepts too.
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
 * The error for a scope whose `fullId` is already claimed by a different path.
 * Names the `fullId` and both paths.
 */
function fullIdCollisionError(fullId: string, path: ScopePath, ownerPath: ScopePath): Error {
	const [mine, theirs] = [path, ownerPath].map((p) => p.map((id) => `'${id}'`).join(' > '));
	return new Error(
		`Scope ${mine} resolves to the fullId '${fullId}', which Scope ${theirs} already uses. ` +
			"Scope ids are joined with '-', so the two would name the same resources (a table, bucket or " +
			"queue, and the local .bb-data directory) and read and overwrite each other's data. Rename one " +
			'of the scopes so their joined ids differ.',
	);
}

/**
 * Claim `fullId` for the path `scope` came from, in `claims`. A claim from the
 * same path again is accepted; one from a different path throws.
 *
 * @param claims - `fullId` → the path that claimed it (process-wide at runtime, per backend root at synth).
 * @param scope - The scope being constructed.
 * @param fullId - Its `fullId`.
 * @throws {Error} When a different scope path already claimed `fullId`.
 * @internal
 */
export function claimScopeFullId(
	claims: Map<string, ScopePath>,
	scope: { readonly id: string; readonly parent?: unknown },
	fullId: string,
): void {
	const path = scopePath(scope, fullId);
	const owner = claims.get(fullId);
	if (owner === undefined) {
		claims.set(fullId, path);
		return;
	}
	const same = owner.length === path.length && owner.every((id, i) => id === path[i]);
	if (!same) throw fullIdCollisionError(fullId, path, owner);
}
