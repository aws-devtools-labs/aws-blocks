// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/bb-auth-cognito — browser stub.
 *
 * Resolved when the package is imported under `--conditions=browser`
 * (the e2e test runner + any consumer that bundles for the browser).
 * Re-exports all public types so frontends can share interfaces with the
 * backend, and exposes a no-op `AuthCognito` class so bundlers that scan
 * imports don't fail. The real server-side implementation lives in
 * `./index.ts` (mock) and `./index.aws.ts` (AWS runtime).
 *
 * Why no-op: tokens are `HttpOnly` server-side session cookies in Blocks —
 * the browser never instantiates `AuthCognito` directly. It calls the
 * typed `createApi()` namespace the backend exports, same as any other
 * `ApiNamespace`.
 */

import { ApiNamespace } from '@aws-blocks/core';
import type { AuthStateApi } from '@aws-blocks/auth-common';
import { makeExternalUserPoolRef, type AuthCognitoOptions, type AdminGetterOf } from './types.js';

export type { BlocksAuth, AuthUser, AuthState, AuthAction, AuthField, AuthActionInput, AuthStateApi } from '@aws-blocks/auth-common';
export * from './types.js';

// The generic parameter mirrors the server-side runtimes so customer code
// that references `AuthCognito<typeof options>` typechecks identically under
// `--conditions=browser`. The browser stub never executes any method —
// bundlers scan imports, they don't call anything.
export class AuthCognito<const O extends AuthCognitoOptions = AuthCognitoOptions> {
	constructor(..._args: unknown[]) { /* no-op */ }
	/**
	 * Server-only admin surface. Present so `auth.admin` typechecks under
	 * `--conditions=browser`; never reachable at runtime (the browser never
	 * instantiates `AuthCognito`). Throws if somehow called.
	 */
	get admin(): AdminGetterOf<O> {
		throw new Error('AuthCognito.admin is server-only; the browser should call the generated client');
	}
	createApi(): AuthStateApi {
		// Real state-machine lives on the server. Browsers invoke the typed
		// generated client, not this stub — these methods only exist so the
		// shape typechecks under `--conditions=browser`.
		return new ApiNamespace({ id: 'auth' }, 'auth', () => ({
			getAuthState: async () => {
				throw new Error('AuthCognito.createApi() is server-only; the browser should call the generated client');
			},
			setAuthState: async () => {
				throw new Error('AuthCognito.createApi() is server-only; the browser should call the generated client');
			},
		}));
	}
	static fromExisting = makeExternalUserPoolRef;
}
