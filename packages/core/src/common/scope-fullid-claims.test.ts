// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime/mock `Scope`: two scope paths that resolve to one `fullId` are
 * rejected when the second is constructed. Scope ids are joined with `-`, so
 * `user-service › sessions` and `user › service-sessions` both yield
 * `user-service-sessions`, and the two blocks would share their SDK identifier
 * registry entry and local `.bb-data` directory.
 *
 * The claims are process-wide, so each test uses its own root id.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { buildingBlockParent, Scope } from './index.js';

describe('Scope fullId claims: two scope paths cannot resolve to one fullId', () => {
	test('a hyphen in a parent id and a hyphen in a child id collide, and the error names both paths', () => {
		const root = { id: 'claims-split' };
		const first = new Scope('sessions', { parent: new Scope('user-service', { parent: root }) });
		assert.throws(
			() => new Scope('service-sessions', { parent: new Scope('user', { parent: root }) }),
			(e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, new RegExp(`fullId '${first.fullId}'`));
				assert.match(e.message, /'claims-split' > 'user' > 'service-sessions'/, 'names the second path');
				assert.match(e.message, /'claims-split' > 'user-service' > 'sessions'/, 'names the first path');
				return true;
			},
		);
	});

	test('one hyphenated id and two nested ids collide', () => {
		const root = { id: 'claims-depth' };
		new Scope('b-c', { parent: root });
		assert.throws(() => new Scope('c', { parent: new Scope('b', { parent: root }) }), /fullId 'claims-depth-b-c'/);
	});

	test('the same path constructed again is the same block, not a collision', () => {
		const a = new Scope('sessions', { parent: new Scope('user-service', { parent: { id: 'claims-same' } }) });
		const b = new Scope('sessions', { parent: new Scope('user-service', { parent: { id: 'claims-same' } }) });
		assert.strictEqual(a.fullId, b.fullId);
	});

	test('a child built under buildingBlockParent and under the real block share one path', () => {
		const root = { id: 'claims-synthetic' };
		const self = buildingBlockParent({ id: 'auth', parent: root, bbName: 'AuthOidc', bbVersion: '0.2.1' });
		new Scope('sessions', { parent: self });
		const real = new Scope('auth', { parent: root });
		assert.strictEqual(new Scope('sessions', { parent: real }).fullId, 'claims-synthetic-auth-sessions');
	});
});
