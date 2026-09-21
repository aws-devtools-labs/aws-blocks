// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * Brand identifying a Blocks **backend root** — a `BlocksStack` or an embedded
 * `BlocksBackend`. Set as an own-property on each root in its constructor.
 *
 * A `Symbol.for(...)` (process-global) brand rather than `instanceof`, for two
 * reasons: it lets this module identify a root **without importing** the
 * `BlocksStack`/`BlocksBackend` classes (which import from here — an
 * `instanceof` check would be a cycle), and it survives duplicate copies of
 * `@aws-blocks/core` in a dependency tree (two class copies fail `instanceof`;
 * one interned symbol does not). Mirrors the existing brand convention
 * (`Symbol.for('blocks:LambdaCompute')`, `Symbol.for('blocks:ApiNamespace')`).
 */
export const BLOCKS_BACKEND_ROOT = Symbol.for('blocks:BackendRoot');

/** Whether `x` is a branded Blocks backend root (`BlocksStack`/`BlocksBackend`). */
export function isBlocksBackendRoot(x: unknown): x is Construct {
	return typeof x === 'object' && x !== null && (x as Record<symbol, unknown>)[BLOCKS_BACKEND_ROOT] === true;
}

/**
 * Walk up the construct tree from `scope` (inclusive) to the nearest branded
 * backend root, or `undefined` if none is in the tree. The pure tree-walk with
 * no ambient/stack fallback — {@link getBlocksRoot} adds those.
 */
export function findBackendRoot(scope: Construct): Construct | undefined {
	let current: Construct | undefined = scope;
	while (current) {
		// Check the brand inline rather than via `isBlocksBackendRoot` — the latter
		// is a type predicate, which would narrow `current` to `never` on the
		// no-match branch and reject the `current.node.scope` walk below.
		if ((current as unknown as Record<symbol, unknown>)[BLOCKS_BACKEND_ROOT] === true) return current;
		current = current.node.scope as Construct | undefined;
	}
	return undefined;
}

/**
 * Resolve the **backend root** that owns `scope` — the single unit that owns a
 * Blocks application's shared state. Every registry and shared-infra helper keys
 * on this (never on `cdk.Stack.of(scope)`), so that two `BlocksBackend`s sharing
 * one `cdk.Stack` stay fully independent.
 *
 * Resolution order: (1) the nearest branded root up the construct tree; (2) the
 * ambient `globalThis.CURRENT_BLOCKS_STACK` (set while a root's `create()` runs);
 * (3) `cdk.Stack.of(scope)` as a last resort for isolated unit tests that build a
 * construct outside any Blocks backend. For the common single-`BlocksStack` app,
 * all three coincide — so keying on the root is byte-identical to keying on the
 * stack there.
 *
 * @param scope - Any construct in (or under) a Blocks backend.
 */
export function getBlocksRoot(scope: Construct): Construct {
	const found = findBackendRoot(scope);
	if (found) return found;
	const ambient = (globalThis as { CURRENT_BLOCKS_STACK?: Construct }).CURRENT_BLOCKS_STACK;
	if (ambient) return ambient;
	return Stack.of(scope);
}

/**
 * The owning backend root's construct-tree path — a stable, per-root-unique id
 * (a `BlocksStack` yields its stack name; an embedded `BlocksBackend` yields
 * `StackName/BackendId`). Used to tag a RawRoute with its owner at synth so
 * `Hosting` can build CloudFront behaviors from only its own backend's routes.
 *
 * @param scope - Any construct in (or under) a Blocks backend.
 */
export function getBlocksRootId(scope: Construct): string {
	return getBlocksRoot(scope).node.path;
}

/**
 * Get-or-create a `Symbol`-keyed slot stored on the backend root that owns
 * `scope`. The factory runs once per root; later callers (in any construction
 * order) get the same value. Use for shared, per-backend synth infrastructure.
 *
 * @param scope - Any construct in (or under) a Blocks backend.
 * @param key - The `Symbol` slot to memoize under.
 * @param factory - Builds the value, given the resolved root as its parent.
 */
export function getOrCreateOnRoot<T>(scope: Construct, key: symbol, factory: (root: Construct) => T): T {
	const root = getBlocksRoot(scope);
	const store = root as unknown as Record<symbol, unknown>;
	if (!Object.hasOwn(store, key)) {
		store[key] = factory(root);
	}
	return store[key] as T;
}
