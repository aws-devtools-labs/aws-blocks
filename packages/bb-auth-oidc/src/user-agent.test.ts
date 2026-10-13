// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { ScopeParent } from '@aws-blocks/core';
import { buildingBlockParent, clearRouteRegistry, computeScopeFullId, Scope } from '@aws-blocks/core';
import { CORE_VERSION } from '@aws-blocks/core/version';
import { AuthOIDC as AuthOIDCAws } from './index.aws.js';
import { AuthOIDC as AuthOIDCMock, google } from './index.mock.js';
import { cognitoEnvPrefix, cookieSecretEnvVar } from './utils.js';
import { BB_NAME, BB_VERSION } from './version.js';

type ChainScope = Scope & { bbName?: string; buildUserAgentChain(): [string, string][] };
type AuthCtor = new (scope: ScopeParent, id: string, options: never) => Scope;

// `Scope` roots at either of these, so a shell that exports one changes every `fullId`.
const prevStackName = process.env.BLOCKS_STACK_NAME;
const prevCurrentStack = (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;

before(() => {
	delete process.env.BLOCKS_STACK_NAME;
	delete (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;
});

after(() => {
	if (prevStackName === undefined) delete process.env.BLOCKS_STACK_NAME;
	else process.env.BLOCKS_STACK_NAME = prevStackName;
	if (prevCurrentStack === undefined) delete (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;
	else (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK = prevCurrentStack;
});

/** The session KVStore. Asserts there is exactly one, so the match is unambiguous. */
function sessionStore(auth: Scope): ChainScope {
	const seen = new Set<object>();
	const found: ChainScope[] = [];
	const walk = (node: unknown): void => {
		if (!node || typeof node !== 'object' || seen.has(node)) return;
		seen.add(node);
		const candidate = node as ChainScope;
		if (candidate.bbName === 'KVStore' && typeof candidate.fullId === 'string') found.push(candidate);
		for (const key of Object.keys(node)) walk((node as Record<string, unknown>)[key]);
	};
	walk(auth);
	assert.strictEqual(found.length, 1, `expected exactly one session KVStore, found ${found.length}`);
	return found[0];
}

function cookieNamePrefix(auth: Scope): string {
	const seen = new Set<object>();
	const found = new Set<string>();
	const walk = (node: unknown): void => {
		if (!node || typeof node !== 'object' || seen.has(node)) return;
		seen.add(node);
		const candidate = (node as { cookieNamePrefix?: unknown }).cookieNamePrefix;
		if (typeof candidate === 'string') found.add(candidate);
		for (const key of Object.keys(node)) walk((node as Record<string, unknown>)[key]);
	};
	walk(auth);
	assert.strictEqual(found.size, 1, `expected one cookie prefix, found ${[...found].join(', ') || 'none'}`);
	return [...found][0];
}

function newAuth(Ctor: AuthCtor, scope: ScopeParent, id: string): Scope {
	clearRouteRegistry();
	return new Ctor(scope, id, { providers: [google({ clientId: 'cid', clientSecret: 'secret' })] } as never);
}

/** Built lazily: a `Scope` resolves its parent at construction, so these must
 * come after the hook that clears the two roots. */
function scopes(): readonly (readonly [string, ScopeParent])[] {
	return [
		['plain root', { id: 'my-app' }],
		['Scope root', new Scope('my-app')],
		['nested Scope', new Scope('inner', { parent: new Scope('my-app') })],
	];
}

describe('AuthOIDC session store attribution', () => {
	beforeEach(() => clearRouteRegistry());

	// Both entries, because the default condition resolves the mock one and it must
	// report the same chain. What reaches the wire is pinned in `user-agent.aws.test.ts`.
	for (const [runtime, Ctor] of [
		['aws', AuthOIDCAws as AuthCtor],
		['mock', AuthOIDCMock as AuthCtor],
	] as const) {
		test(`${runtime}: the session store reports AuthOIDC as its parent block`, () => {
			const chain = sessionStore(newAuth(Ctor, { id: 'my-app' }, 'auth')).buildUserAgentChain();

			assert.strictEqual(chain.length, 3);
			assert.deepStrictEqual(chain.slice(0, 2), [
				['aws-blocks', CORE_VERSION],
				['bb', `${BB_NAME}/${BB_VERSION}`],
			]);
			// KVStore's version is a dependency's, so match its shape, not its value.
			assert.strictEqual(chain[2][0], 'bb');
			assert.match(chain[2][1], /^KVStore\/\d+\.\d+\.\d+/);
		});

		// A renamed session table drops every signed-in user.
		test(`${runtime}: the session table name is unchanged for every parent shape`, () => {
			for (const [label, scope] of scopes()) {
				const auth = newAuth(Ctor, scope, 'auth');
				assert.strictEqual(sessionStore(auth).fullId, `${(auth as Scope).fullId}-sessions`, label);
			}

			// A literal too: the assertion above derives both sides, so it still
			// passes if the rule that builds the ID changes under both of them.
			assert.strictEqual(sessionStore(newAuth(Ctor, { id: 'my-app' }, 'auth')).fullId, 'my-app-auth-sessions');
		});

		test(`${runtime}: the cookie prefix is the block's own fullId for every parent shape`, () => {
			for (const [label, scope] of scopes()) {
				const auth = newAuth(Ctor, scope, 'auth');
				assert.strictEqual(cookieNamePrefix(auth), `oidc_${(auth as Scope).fullId}`, label);
			}
		});
	}

	test('both entries produce an identical chain and table name', () => {
		for (const [label, scope] of scopes()) {
			const aws = sessionStore(newAuth(AuthOIDCAws as AuthCtor, scope, 'auth'));
			const mock = sessionStore(newAuth(AuthOIDCMock as AuthCtor, scope, 'auth'));

			assert.strictEqual(aws.fullId, mock.fullId, label);
			assert.deepStrictEqual(aws.buildUserAgentChain(), mock.buildUserAgentChain(), label);
		}
	});

	// Literals, not the helper re-derived: comparing the helper to `Scope.fullId`
	// passes even when both are broken, because both call `computeScopeFullId`.
	test('the parent the entries build renders a literal fullId per parent shape', () => {
		const expected: Record<string, string> = {
			'plain root': 'my-app-auth',
			'Scope root': 'my-app-auth',
			'nested Scope': 'my-app-inner-auth',
		};
		for (const [label, scope] of scopes()) {
			const self = buildingBlockParent({ id: 'auth', parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
			assert.strictEqual(self.fullId, expected[label], label);
			assert.strictEqual(computeScopeFullId({ id: 'auth', parent: scope }), expected[label], label);
			assert.strictEqual(new Scope('auth', { parent: scope }).fullId, expected[label], label);
		}
	});

	// A deployed app looks up these rendered strings, so pin the literals rather
	// than the helper. `index.cdk.test.ts` pins the writer's side.
	test('the env var names a deployed app reads are derived from its own fullId', () => {
		const self = buildingBlockParent({
			id: 'auth',
			parent: { id: 'my-app' },
			bbName: BB_NAME,
			bbVersion: BB_VERSION,
		});

		assert.strictEqual(self.fullId, 'my-app-auth');
		assert.strictEqual(cookieSecretEnvVar(self.fullId), 'BLOCKS_AUTH_OIDC_COOKIE_SECRET_MY_APP_AUTH');
		assert.strictEqual(cognitoEnvPrefix(self.fullId), 'BLOCKS_AUTH_OIDC_COGNITO_MY_APP_AUTH');
	});
});
