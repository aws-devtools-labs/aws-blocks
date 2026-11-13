// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The CDK `Scope`: two scope paths that resolve to one `fullId` get a synth
 * warning (`blocks:scope:fullIdCollision`). Scope ids are joined with `-`, so
 * `user-service › sessions` and `user › service-sessions` both yield
 * `…-user-service-sessions`, and every resource name derived from it (a
 * DynamoDB table, a bucket) would be shared. The construct tree only rejects
 * two children with the same id under one parent, so without this claim synth
 * succeeds silently with duplicate names.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { Scope } from './index.js';
import { BLOCKS_BACKEND_ROOT } from './root-registry.js';

/** A stack branded as a backend root, with the `id` a BlocksStack sets, which roots each `fullId`. */
function root(id: string): Stack {
	const stack = Object.assign(new Stack(new App(), id), { id });
	(stack as unknown as Record<symbol, unknown>)[BLOCKS_BACKEND_ROOT] = true;
	return stack;
}

/** The fullId-collision warnings synth reports for `stack`: construct path → message. */
function collisions(stack: Stack): Array<{ path: string; message: string }> {
	return Annotations.fromStack(stack)
		.findWarning('*', Match.stringLikeRegexp('blocks:scope:fullIdCollision'))
		.map((w) => ({ path: w.id, message: String(w.entry.data) }));
}

describe('CDK Scope: two scope paths resolving to one fullId are reported at synth', () => {
	test('a hyphen in a parent id and a hyphen in a child id collide, and the warning names both paths', () => {
		const stack = root('App');
		const first = new Scope('sessions', { parent: new Scope('user-service', { parent: stack as never }) });
		new Scope('service-sessions', { parent: new Scope('user', { parent: stack as never }) });
		const found = collisions(stack);
		assert.strictEqual(found.length, 1);
		assert.strictEqual(found[0].path, '/App/user/service-sessions', 'on the scope that claimed second');
		assert.match(found[0].message, new RegExp(`fullId '${first.fullId}'`));
		assert.match(found[0].message, /'App' > 'user' > 'service-sessions'/, 'names the second path');
		assert.match(found[0].message, /'App' > 'user-service' > 'sessions'/, 'names the first path');
	});

	test('one hyphenated id and two nested ids collide', () => {
		const stack = root('App');
		new Scope('b-c', { parent: stack as never });
		new Scope('c', { parent: new Scope('b', { parent: stack as never }) });
		const found = collisions(stack);
		assert.strictEqual(found.length, 1);
		assert.match(found[0].message, /fullId 'App-b-c'/);
	});

	test('a collision is reported once, not again for each scope beneath it', () => {
		const stack = root('App');
		new Scope('logger', { parent: new Scope('sessions', { parent: new Scope('user-service', { parent: stack as never }) }) });
		new Scope('logger', { parent: new Scope('service-sessions', { parent: new Scope('user', { parent: stack as never }) }) });
		const found = collisions(stack);
		assert.strictEqual(found.length, 1);
		assert.strictEqual(found[0].path, '/App/user/service-sessions');
	});

	test('distinct fullIds are not reported', () => {
		const stack = root('App');
		const service = new Scope('user-service', { parent: stack as never });
		new Scope('sessions', { parent: service });
		new Scope('orders', { parent: service });
		assert.deepStrictEqual(collisions(stack), []);
	});

	test('claims are per backend root: colliding paths under two backends do not see each other', () => {
		const first = root('App');
		const second = root('App');
		new Scope('sessions', { parent: new Scope('user-service', { parent: first as never }) });
		new Scope('service-sessions', { parent: new Scope('user', { parent: second as never }) });
		// Each root still enforces its own claims: a colliding path under the second root is reported.
		new Scope('sessions', { parent: new Scope('user-service', { parent: second as never }) });
		const found = collisions(second);
		assert.strictEqual(found.length, 1, 'only the collision inside the second root');
		assert.strictEqual(found[0].path, '/App/user-service/sessions');
		assert.match(found[0].message, /fullId 'App-user-service-sessions'/);
	});
});
