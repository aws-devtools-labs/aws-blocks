// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the compute registry's routing-table derivation.
 *
 * `getApiEndpoints` is the surface a front door (Blocks' own, Hosting's, or a
 * customer-built one) reads to path-route `/aws-blocks/api/{namespace}` to the
 * compute that owns the namespace. It is *derived* from two facts the framework
 * already tracks — `compute.namespaces` and `compute.endpoint` — so these tests
 * pin the derivation rules rather than a stored structure.
 *
 * The computes here are minimal stubs: the derivation only reads `namespaces`
 * and `endpoint`, so no Lambda or API Gateway is needed.
 */
import assert from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import type { ScopeParent } from '../../common/index.js';
import { Compute } from './compute.js';
import { getApiEndpoints, getComputes } from './compute-registry.js';

/** Minimal Compute: carries an optional endpoint, no real infrastructure. */
class StubCompute extends Compute {
	override readonly endpoint?: string;
	constructor(scope: ScopeParent, id: string, endpoint?: string) {
		super(id, { parent: scope });
		this.endpoint = endpoint;
	}
	setEnv(): void {}
	protected applyTracing(): void {}
	protected healthWidgets(): IWidget[][] {
		return [];
	}
	protected loggingWidgets(): IWidget[][] {
		return [];
	}
	protected tracingWidgets(): IWidget[][] {
		return [];
	}
}

/**
 * Stand-in for the owning BlocksStack. `Compute` resolves its stack through the
 * construct tree, and `Scope` falls back to `globalThis.CURRENT_BLOCKS_STACK`.
 */
class StubBlocksStack extends cdk.Stack {
	readonly id: string;
	constructor(scope: cdk.App, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
	}
}

function makeStack(id: string): StubBlocksStack {
	return new StubBlocksStack(new cdk.App(), id);
}

beforeEach(() => {
	(globalThis as any).CURRENT_BLOCKS_STACK = undefined;
});

describe('getApiEndpoints', () => {
	test('is empty before any compute exists', () => {
		const stack = makeStack('Empty');
		assert.deepStrictEqual(getApiEndpoints(stack), {});
	});

	test('maps every namespace to its owning compute endpoint', () => {
		const stack = makeStack('TwoComputes');
		const a = new StubCompute(stack as never, 'a', 'https://a.example/prod');
		const b = new StubCompute(stack as never, 'b', 'https://b.example/prod');
		a.namespaces.push('orders', 'billing');
		b.namespaces.push('auth');

		assert.deepStrictEqual(getApiEndpoints(stack), {
			orders: 'https://a.example/prod',
			billing: 'https://a.example/prod',
			auth: 'https://b.example/prod',
		});
	});

	test('skips a compute with no HTTP ingress (worker-only)', () => {
		const stack = makeStack('WorkerOnly');
		const http = new StubCompute(stack as never, 'http', 'https://http.example/prod');
		const worker = new StubCompute(stack as never, 'worker'); // no endpoint
		http.namespaces.push('orders');
		worker.namespaces.push('jobs');

		// `jobs` is absent rather than mapped to undefined — callers fall back to
		// the default route for it.
		assert.deepStrictEqual(getApiEndpoints(stack), { orders: 'https://http.example/prod' });
	});

	test('a namespace recorded twice on the same compute is not a conflict', () => {
		const stack = makeStack('DuplicateSameCompute');
		const only = new StubCompute(stack as never, 'only', 'https://only.example/prod');
		only.namespaces.push('orders', 'orders');

		assert.deepStrictEqual(getApiEndpoints(stack), { orders: 'https://only.example/prod' });
	});

	test('throws when two computes claim the same namespace (routing would be ambiguous)', () => {
		const stack = makeStack('Conflict');
		const a = new StubCompute(stack as never, 'a', 'https://a.example/prod');
		const b = new StubCompute(stack as never, 'b', 'https://b.example/prod');
		a.namespaces.push('orders');
		b.namespaces.push('orders');

		assert.throws(() => getApiEndpoints(stack), /claimed by two computes/);
	});

	test('is scoped per stack — one stack never sees another stack computes', () => {
		const app = new cdk.App();
		const one = new StubBlocksStack(app, 'One');
		const a = new StubCompute(one as never, 'a', 'https://a.example/prod');
		a.namespaces.push('orders');

		const two = new StubBlocksStack(app, 'Two');
		const b = new StubCompute(two as never, 'b', 'https://b.example/prod');
		b.namespaces.push('auth');

		assert.deepStrictEqual(getApiEndpoints(one), { orders: 'https://a.example/prod' });
		assert.deepStrictEqual(getApiEndpoints(two), { auth: 'https://b.example/prod' });
		assert.strictEqual(getComputes(one).length, 1);
	});
});
