// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The routes the CDK layer claims at synth (`cdk/auth-routes.ts`, used by `claimAuthRoutes`) are exactly the routes
 * the runtime mounts, by method and path: a route added to `mountFederationRoutes` or `mountStubIdpRoutes` and not
 * claimed fails here.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { clearRouteRegistry, getRegisteredRoutes } from '@aws-blocks/core';
import { authRoutes } from './cdk/auth-routes.js';
import { Auth, github, stubIdp } from './index.mock.js';
import { resolveOptions } from './resolve-options.js';
import type { AppSettingRef, AuthOptions } from './types.js';

const secret: AppSettingRef = { fullId: 'provider-secret', get: async () => 's3cret' };
const okta = { type: 'oidc', issuer: 'https://dev-1.okta.com', clientId: '0oa1' } as const;

beforeEach(() => {
	clearRouteRegistry();
	rmSync('.bb-data', { recursive: true, force: true });
});
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const CASES: Array<{ name: string; options: AuthOptions; stubKeys: string[] }> = [
	{
		name: 'builtin: stub, two OIDC (one id needing encoding), github(), bearer, own paths',
		options: {
			store: 'builtin',
			allowBearerAuth: true,
			providers: {
				corp: stubIdp(),
				okta,
				'my idp': okta,
				gh: github({ clientId: 'gh-client', clientSecret: secret }),
			},
			redirects: { callbackPath: '/aws-blocks/auth/sso/callback', signOutPath: '/aws-blocks/auth/sso/signout' },
		},
		stubKeys: ['corp'],
	},
	{
		name: 'user pool: social, SAML, bearer, default paths',
		options: {
			emailPassword: false,
			allowBearerAuth: true,
			providers: {
				google: { type: 'google', clientId: 'g', clientSecret: secret },
				acme: { type: 'saml', metadataUrl: 'https://acme.example.com/metadata.xml' },
			},
		},
		stubKeys: [],
	},
	{
		name: 'builtin: two stubs, default paths, no bearer',
		options: { store: 'builtin', providers: { google: stubIdp(), github2: stubIdp() } },
		stubKeys: ['google', 'github2'],
	},
	{
		name: 'builtin: unusual but valid paths (double slash, trailing slash)',
		options: {
			store: 'builtin',
			providers: { corp: stubIdp() },
			redirects: { callbackPath: '/aws-blocks/auth//deep/cb', signOutPath: '/aws-blocks/auth/out/' },
		},
		stubKeys: ['corp'],
	},
];

describe('claimed Auth routes match the mounted ones', () => {
	for (const { name, options, stubKeys } of CASES) {
		test(name, () => {
			new Auth({ id: `routes${process.pid}` }, 'auth', options);
			const mounted = getRegisteredRoutes()
				.map((r) => `${r.method} ${r.path}`)
				.sort();
			const r = authRoutes(resolveOptions(options, 'auth'), stubKeys);
			const claimed = [...r.signIn, ...r.signOut, ...r.stubs.flatMap((s) => s.routes)].sort();
			assert.deepStrictEqual(claimed, mounted);
		});
	}
});
