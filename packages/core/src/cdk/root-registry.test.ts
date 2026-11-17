// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the backend-root registry primitive — the single mechanism the
 * config/compute/dashboard/tracer/vpc registries and the shared-infra BBs use to
 * key state on the owning `BlocksStack`/`BlocksBackend` instead of on
 * `cdk.Stack.of(scope)`. The contract these tests pin: (1) an unbranded tree has
 * no root; (2) resolution prefers the nearest branded root, then the ambient
 * pointer, then the stack; (3) `getOrCreateOnRoot` memoizes per root, so two
 * roots sharing one stack never collide.
 */
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
	BLOCKS_BACKEND_ROOT,
	findBackendRoot,
	getBlocksRoot,
	getBlocksRootId,
	getOrCreateOnRoot,
	isBlocksBackendRoot,
} from './root-registry.js';

/** Brand a construct as a backend root, the way BlocksStack/BlocksBackend do in their ctors. */
function brand<T extends Construct>(c: T): T {
	(c as unknown as Record<symbol, unknown>)[BLOCKS_BACKEND_ROOT] = true;
	return c;
}

// getBlocksRoot falls back to this ambient pointer; never let one test's value leak into another.
afterEach(() => {
	delete (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;
});

describe('isBlocksBackendRoot', () => {
	test('true only for a branded object', () => {
		const app = new App();
		const stack = new Stack(app, 'S');
		const branded = brand(new Construct(stack, 'Branded'));
		const plain = new Construct(stack, 'Plain');

		assert.strictEqual(isBlocksBackendRoot(branded), true);
		assert.strictEqual(isBlocksBackendRoot(plain), false);
		assert.strictEqual(isBlocksBackendRoot(undefined), false);
		assert.strictEqual(isBlocksBackendRoot(null), false);
		assert.strictEqual(isBlocksBackendRoot({}), false);
	});
});

describe('findBackendRoot', () => {
	test('returns undefined when no branded root is in the tree', () => {
		const app = new App();
		const stack = new Stack(app, 'NoRoot');
		const deep = new Construct(new Construct(stack, 'a'), 'b');
		assert.strictEqual(findBackendRoot(deep), undefined);
	});

	test('walks up to the nearest branded root (inclusive of scope)', () => {
		const app = new App();
		const stack = new Stack(app, 'HasRoot');
		const root = brand(new Construct(stack, 'Backend'));
		const deep = new Construct(new Construct(root, 'a'), 'b');

		assert.strictEqual(findBackendRoot(deep), root);
		// Inclusive: the root itself resolves to itself.
		assert.strictEqual(findBackendRoot(root), root);
	});

	test('returns the nearest root when backends are nested', () => {
		const app = new App();
		const stack = new Stack(app, 'Nested');
		const outer = brand(new Construct(stack, 'Outer'));
		const inner = brand(new Construct(outer, 'Inner'));
		const leaf = new Construct(inner, 'leaf');

		assert.strictEqual(findBackendRoot(leaf), inner);
	});
});

describe('getBlocksRoot resolution order', () => {
	test('(1) prefers a branded root over the ambient pointer and the stack', () => {
		const app = new App();
		const stack = new Stack(app, 'Prefer');
		const root = brand(new Construct(stack, 'Backend'));
		const leaf = new Construct(root, 'leaf');
		(globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK = stack;

		assert.strictEqual(getBlocksRoot(leaf), root);
	});

	test('(2) falls back to the ambient CURRENT_BLOCKS_STACK when the tree has no root', () => {
		const app = new App();
		const stack = new Stack(app, 'Ambient');
		const owner = new Construct(stack, 'Owner'); // unbranded stand-in for the current backend
		const leaf = new Construct(new Construct(stack, 'x'), 'y');
		(globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK = owner;

		assert.strictEqual(getBlocksRoot(leaf), owner);
	});

	test('(3) falls back to the enclosing cdk.Stack when nothing else is set', () => {
		const app = new App();
		const stack = new Stack(app, 'StackFallback');
		const leaf = new Construct(new Construct(stack, 'x'), 'y');

		assert.strictEqual(getBlocksRoot(leaf), stack);
	});
});

describe('getBlocksRootId', () => {
	test('is the resolved root node.path', () => {
		const app = new App();
		const stack = new Stack(app, 'IdStack');
		const root = brand(new Construct(stack, 'Backend'));
		const leaf = new Construct(root, 'leaf');

		assert.strictEqual(getBlocksRootId(leaf), root.node.path);
		assert.strictEqual(getBlocksRootId(leaf), 'IdStack/Backend');
	});

	test('a top-level stack root yields its stack name', () => {
		const app = new App();
		const stack = new Stack(app, 'TopLevel');
		const leaf = new Construct(stack, 'leaf');
		// No branded root → the stack itself is the root; its node.path is its id.
		assert.strictEqual(getBlocksRootId(leaf), 'TopLevel');
	});
});

describe('getOrCreateOnRoot', () => {
	const KEY = Symbol.for('blocks:test:slot');

	test('runs the factory once per root and returns the same value thereafter', () => {
		const app = new App();
		const stack = new Stack(app, 'Memo');
		const root = brand(new Construct(stack, 'Backend'));
		const leaf = new Construct(root, 'leaf');

		let calls = 0;
		const first = getOrCreateOnRoot(root, KEY, (r) => {
			calls++;
			// The factory receives the resolved root as its parent.
			assert.strictEqual(r, root);
			return { id: calls };
		});
		// A deeper caller resolves to the same root → same memoized value, no re-run.
		const second = getOrCreateOnRoot(leaf, KEY, () => {
			calls++;
			return { id: -1 };
		});

		assert.strictEqual(first, second);
		assert.strictEqual(calls, 1);
	});

	test('two backend roots sharing one stack get independent slots (the core guarantee)', () => {
		const app = new App();
		const stack = new Stack(app, 'TwoBackends');
		const a = brand(new Construct(stack, 'BackendA'));
		const b = brand(new Construct(stack, 'BackendB'));

		const va = getOrCreateOnRoot(new Construct(a, 'x'), KEY, () => ({ owner: 'a' }));
		const vb = getOrCreateOnRoot(new Construct(b, 'y'), KEY, () => ({ owner: 'b' }));

		assert.notStrictEqual(va, vb, 'each backend root must own its own slot');
		assert.strictEqual(va.owner, 'a');
		assert.strictEqual(vb.owner, 'b');
	});
});
