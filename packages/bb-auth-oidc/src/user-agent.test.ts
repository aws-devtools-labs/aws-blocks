// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { beforeEach, describe, test } from 'node:test';
import type { ScopeParent } from '@aws-blocks/core';
import { clearRouteRegistry, Scope } from '@aws-blocks/core';
import { CORE_VERSION } from '@aws-blocks/core/version';
import { AuthOIDC as AuthOIDCAws } from './index.aws.js';
import { AuthOIDC as AuthOIDCMock, google } from './index.mock.js';
import { cookieSecretEnvVar, scopeFullId } from './utils.js';
import { BB_NAME, BB_VERSION } from './version.js';

/** See `scopeFullId` in `utils.ts` for why the store cannot take `this`. */

type ChainScope = Scope & { bbName?: string; buildUserAgentChain(): [string, string][] };
type AuthCtor = new (scope: ScopeParent, id: string, options: never) => Scope;

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

function newAuth(Ctor: AuthCtor, scope: ScopeParent, id: string): Scope {
	clearRouteRegistry();
	return new Ctor(scope, id, { providers: [google({ clientId: 'cid', clientSecret: 'secret' })] } as never);
}

/** Rendered form of the chain, with the SDK's `/`-to-`-` escaping applied. */
function renderedChain(store: ChainScope): string {
	return store
		.buildUserAgentChain()
		.map(([key, value]) => `${key}/${value.replace(/\//g, '-')}`)
		.join(' ');
}

const SCOPES: readonly (readonly [string, ScopeParent, string])[] = [
	['plain root', { id: 'my-app' }, 'my-app-auth'],
	['Scope root', new Scope('my-app'), 'my-app-auth'],
	['nested Scope', new Scope('inner', { parent: new Scope('my-app') }), 'my-app-inner-auth'],
];

describe('AuthOIDC session store attribution', () => {
	beforeEach(() => clearRouteRegistry());

	// Both runtimes, because only the AWS one signs a real request — a mock-only
	// test cannot substantiate an attribution fix.
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
			assert.deepStrictEqual(chain[2][0], 'bb');
			assert.match(chain[2][1], /^KVStore\/\d+\.\d+\.\d+/);
		});

		test(`${runtime}: the rendered chain carries both blocks root-to-leaf`, () => {
			const chain = renderedChain(sessionStore(newAuth(Ctor, { id: 'my-app' }, 'auth')));
			const parentAt = chain.indexOf(`bb/${BB_NAME}-${BB_VERSION}`);
			const selfAt = chain.indexOf('bb/KVStore-');

			assert.ok(parentAt >= 0 && selfAt >= 0, `missing chain token: ${chain}`);
			assert.ok(parentAt < selfAt, `chain out of root-to-leaf order: ${chain}`);
		});

		// A renamed session table drops every signed-in user.
		test(`${runtime}: the session table name is unchanged for every parent shape`, () => {
			for (const [label, scope, authFullId] of SCOPES) {
				const auth = newAuth(Ctor, scope, 'auth');
				const store = sessionStore(auth);
				assert.strictEqual(store.fullId, `${authFullId}-sessions`, label);
				// Ties the store's id to the block's own, not just to the literal.
				assert.strictEqual(store.fullId, `${auth.fullId}-sessions`, label);
			}
		});
	}

	// The two runtimes reach the same `fullId` by different routes, so pin parity
	// rather than each one's own value.
	test('both runtimes produce an identical chain and table name', () => {
		for (const [label, scope] of SCOPES) {
			const aws = sessionStore(newAuth(AuthOIDCAws as AuthCtor, scope, 'auth'));
			const mock = sessionStore(newAuth(AuthOIDCMock as AuthCtor, scope, 'auth'));

			assert.strictEqual(aws.fullId, mock.fullId, label);
			assert.deepStrictEqual(aws.buildUserAgentChain(), mock.buildUserAgentChain(), label);
		}
	});

	// The CDK half writes this name from `Scope.fullId`, so a reader that derives it
	// differently reads a name nobody set and the secret resolves to an empty string.
	test('the cookie-secret env var name matches Scope.fullId for every parent shape', () => {
		for (const [label, scope, authFullId] of SCOPES) {
			assert.strictEqual(scopeFullId(scope, 'auth'), authFullId, label);
			assert.strictEqual(
				cookieSecretEnvVar(scopeFullId(scope, 'auth')),
				cookieSecretEnvVar(new Scope('auth', { parent: scope }).fullId),
				label,
			);
		}
	});
});
