// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The CDK `Scope`: two scope paths that resolve to one `fullId` fail synth.
 * Scope ids are joined with `-`, so `user-service › sessions` and
 * `user › service-sessions` both yield `…-user-service-sessions`, and every
 * resource name derived from it (a DynamoDB table, a bucket) would be shared.
 * The construct tree only rejects two children with the same id under one
 * parent, so without this claim synth succeeds with duplicate names.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { App, Stack } from 'aws-cdk-lib';
import { Scope } from './index.js';
import { BLOCKS_BACKEND_ROOT } from './root-registry.js';

/** A stack branded as a backend root, with the `id` a BlocksStack sets, which roots each `fullId`. */
function root(id: string): Stack {
	const stack = Object.assign(new Stack(new App(), id), { id });
	(stack as unknown as Record<symbol, unknown>)[BLOCKS_BACKEND_ROOT] = true;
	return stack;
}

describe('CDK Scope: one fullId per scope path, enforced at synth', () => {
	test('a hyphen in a parent id and a hyphen in a child id collide, and the error names both paths', () => {
		const stack = root('App');
		const first = new Scope('sessions', { parent: new Scope('user-service', { parent: stack as never }) });
		assert.throws(
			() => new Scope('service-sessions', { parent: new Scope('user', { parent: stack as never }) }),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, new RegExp(`fullId '${first.fullId}'`));
				assert.match(e.message, /'App' > 'user' > 'service-sessions'/, 'names the second path');
				assert.match(e.message, /'App' > 'user-service' > 'sessions'/, 'names the first path');
				return true;
			},
		);
	});

	test('one hyphenated id and two nested ids collide', () => {
		const stack = root('App');
		new Scope('b-c', { parent: stack as never });
		assert.throws(
			() => new Scope('c', { parent: new Scope('b', { parent: stack as never }) }),
			/fullId 'App-b-c'/,
		);
	});

	test('claims are per backend root: colliding paths under two backends do not see each other', () => {
		const a = new Scope('sessions', { parent: new Scope('user-service', { parent: root('App') as never }) });
		const b = new Scope('service-sessions', { parent: new Scope('user', { parent: root('App') as never }) });
		assert.strictEqual(a.fullId, b.fullId);
	});
});
