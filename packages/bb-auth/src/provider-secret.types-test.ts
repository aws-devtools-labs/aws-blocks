// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile-time proof of what a provider secret (`clientSecret`, Apple's
 * `privateKey`) accepts: an `AppSetting` created with `secret: true`, or a
 * string-valued `Secret` (AWS Secrets Manager). Never a plain string, and never
 * a `Secret` with a `schema` (it holds JSON, not one string).
 *
 * The compile is the test — nothing here runs. Every `@ts-expect-error`
 * asserts that the next line is a type error; if the type starts accepting it,
 * the directive is unused and the build fails with TS2578.
 *
 * Runs against the real `Auth`, and the `Secret` / `AppSetting` types from
 * their default (types) entries, as an app sees them.
 *
 * @internal
 */

import type { AppSetting } from '@aws-blocks/bb-app-setting';
import type { KVStore } from '@aws-blocks/bb-kv-store';
import type { Secret, WritableSecret } from '@aws-blocks/bb-secret';
import type { Scope, ScopeParent } from '@aws-blocks/core';
import type { AuthOptions, ProviderSecretRef } from './index.mock.js';
import { Auth, customOauth2, github } from './index.mock.js';

declare const scope: ScopeParent;
/** What `new Secret(scope, id)` returns — with or without `name`, or wrapping `Secret.fromExisting(arn)`. */
declare const googleSecret: Secret;
declare const named: Secret<string>;
declare const existing: Secret;
/** What `new Secret(scope, id, { allowRuntimeWrite: true })` returns. */
declare const writable: WritableSecret;
/** What `new AppSetting(scope, id, { secret: true })` returns. */
declare const setting: AppSetting<string>;
/** What `new Secret(scope, id, { schema })` returns: a JSON-valued secret. */
declare const jsonSecret: Secret<{ clientSecret: string }>;
/** Other blocks: `ProviderSecretRef` is structural, so these pin that nothing else fits it. */
declare const store: KVStore<string>;
declare const plainScope: Scope;

function providerSecretsAccepted() {
	// A `Secret` and an `AppSetting` both fit every provider-secret slot.
	new Auth(scope, 'social', {
		providers: {
			google: { type: 'google', clientId: 'g', clientSecret: googleSecret },
			facebook: { type: 'facebook', clientId: 'f', clientSecret: named },
			amazon: { type: 'amazon', clientId: 'a', clientSecret: setting },
			apple: { type: 'apple', clientId: 'com.example.web', teamId: 'T', keyId: 'K', privateKey: existing },
			okta: { type: 'oidc', issuer: 'https://dev-1.okta.com', clientId: 'o', clientSecret: writable },
		},
	});
	new Auth(scope, 'oidc', {
		store: 'builtin',
		providers: {
			entra: { type: 'oidc', issuer: 'https://login.example.com', clientId: 'e', clientSecret: googleSecret },
			gh: github({ clientId: 'Iv1.abc', clientSecret: googleSecret }),
			custom: customOauth2({
				name: 'custom',
				clientId: 'c',
				clientSecret: named,
				scopes: ['read'],
				endpoints: {
					authorization: 'https://x.example/a',
					token: 'https://x.example/t',
					userInfo: 'https://x.example/u',
				},
				mapClaims: () => ({ providerSub: '1', email: null, name: null }),
			}),
		},
	});

	// The union is the public name for the slot.
	const asRef: ProviderSecretRef = googleSecret;
	const fromSetting: ProviderSecretRef = setting;
	void [asRef, fromSetting];
}

function providerSecretsRefused() {
	const literal: AuthOptions = {
		// @ts-expect-error a plain string is never a provider secret: it would be committed to source.
		providers: { google: { type: 'google', clientId: 'g', clientSecret: 'plain-text' } },
	};
	const structured: AuthOptions = {
		// @ts-expect-error a `Secret` with a schema holds JSON, not the single string a provider needs.
		providers: { google: { type: 'google', clientId: 'g', clientSecret: jsonSecret } },
	};
	const direct: AuthOptions = {
		store: 'builtin',
		// @ts-expect-error a plain string is not a secret on the 'builtin' store either.
		providers: { okta: { type: 'oidc', issuer: 'https://x.example', clientId: 'o', clientSecret: 'plain-text' } },
	};
	// @ts-expect-error a KVStore is not a secret: its `get(key)` takes an argument.
	const kv: ProviderSecretRef = store;
	// @ts-expect-error a plain Scope has no `get()`.
	const bare: ProviderSecretRef = plainScope;
	void [literal, structured, direct, kv, bare];
}

void [providerSecretsAccepted, providerSecretsRefused];
