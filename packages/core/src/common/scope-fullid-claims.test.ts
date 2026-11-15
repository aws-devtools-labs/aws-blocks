// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime/mock `Scope`: two scope paths that resolve to one `fullId` are
 * reported with a warning when the second is constructed. Scope ids are joined
 * with `-`, so `user-service › sessions` and `user › service-sessions` both
 * yield `user-service-sessions`, and the two blocks share their SDK identifier
 * registry entry and local `.bb-data` directory.
 *
 * The claims are process-wide, so each test uses its own root id.
 */
import assert from 'node:assert';
import { describe, type TestContext, test } from 'node:test';
import { buildingBlockParent, Scope } from './index.js';

/** The `console.warn` messages logged while `build` runs. */
function warnings(t: TestContext, build: () => void): string[] {
	const warn = t.mock.method(console, 'warn', () => {});
	build();
	const messages = warn.mock.calls.map((call) => String(call.arguments[0]));
	warn.mock.restore();
	return messages;
}

describe('Scope fullId claims: two scope paths resolving to one fullId are reported', () => {
	test('a hyphen in a parent id and a hyphen in a child id collide, and the warning names both paths', (t) => {
		const root = { id: 'claims-split' };
		const first = new Scope('sessions', { parent: new Scope('user-service', { parent: root }) });
		const logged = warnings(t, () => new Scope('service-sessions', { parent: new Scope('user', { parent: root }) }));
		assert.strictEqual(logged.length, 1);
		assert.match(logged[0], new RegExp(`fullId '${first.fullId}'`));
		assert.match(logged[0], /'claims-split' > 'user' > 'service-sessions'/, 'names the second path');
		assert.match(logged[0], /'claims-split' > 'user-service' > 'sessions'/, 'names the first path');
		assert.match(logged[0], /future release/);
	});

	test('one hyphenated id and two nested ids collide', (t) => {
		const root = { id: 'claims-depth' };
		new Scope('b-c', { parent: root });
		const logged = warnings(t, () => new Scope('c', { parent: new Scope('b', { parent: root }) }));
		assert.strictEqual(logged.length, 1);
		assert.match(logged[0], /fullId 'claims-depth-b-c'/);
	});

	test('a collision is reported once, not again for each scope beneath it', (t) => {
		const root = { id: 'claims-nested' };
		const firstLogger = new Scope('logger', {
			parent: new Scope('sessions', { parent: new Scope('user-service', { parent: root }) }),
		});
		new Scope('sink', { parent: firstLogger });
		const logged = warnings(t, () => {
			const logger = new Scope('logger', {
				parent: new Scope('service-sessions', { parent: new Scope('user', { parent: root }) }),
			});
			new Scope('sink', { parent: logger });
		});
		assert.strictEqual(logged.length, 1, 'neither the child nor the grandchild is reported');
		assert.match(logged[0], /fullId 'claims-nested-user-service-sessions'/);
	});

	test('a second, independent collision under an already-colliding fullId is still reported', (t) => {
		const root = { id: 'claims-independent' };
		const ab = new Scope('a-b', { parent: root });
		const a = new Scope('a', { parent: root });
		const first = warnings(t, () => new Scope('b', { parent: a }));
		assert.strictEqual(first.length, 1);
		assert.match(first[0], /fullId 'claims-independent-a-b'/);
		new Scope('b-c', { parent: a });
		// 'a-b' > 'c' and 'a' > 'b-c' collide on their own: renaming 'a' > 'b' leaves them colliding.
		const second = warnings(t, () => new Scope('c', { parent: ab }));
		assert.strictEqual(second.length, 1);
		assert.match(second[0], /fullId 'claims-independent-a-b-c'/);
		assert.match(second[0], /'claims-independent' > 'a-b' > 'c'/);
		assert.match(second[0], /'claims-independent' > 'a' > 'b-c'/);
	});

	test('the same path constructed again is the same block, not a collision', (t) => {
		new Scope('sessions', { parent: new Scope('user-service', { parent: { id: 'claims-same' } }) });
		const again = warnings(
			t,
			() => new Scope('sessions', { parent: new Scope('user-service', { parent: { id: 'claims-same' } }) }),
		);
		assert.deepStrictEqual(again, []);
		// The fullId is still claimed: a different path to it is reported.
		const other = warnings(
			t,
			() => new Scope('service-sessions', { parent: new Scope('user', { parent: { id: 'claims-same' } }) }),
		);
		assert.strictEqual(other.length, 1);
		assert.match(other[0], /fullId 'claims-same-user-service-sessions'/);
	});

	test('a child built under buildingBlockParent and under the real block share one path', (t) => {
		const root = { id: 'claims-synthetic' };
		const self = buildingBlockParent({ id: 'auth', parent: root, bbName: 'AuthOidc', bbVersion: '0.2.1' });
		new Scope('sessions', { parent: self });
		const real = warnings(t, () => new Scope('sessions', { parent: new Scope('auth', { parent: root }) }));
		assert.deepStrictEqual(real, []);
		// The fullId is still claimed: a different path to it is reported.
		const other = warnings(t, () => new Scope('auth-sessions', { parent: root }));
		assert.strictEqual(other.length, 1);
		assert.match(other[0], /fullId 'claims-synthetic-auth-sessions'/);
	});
});
