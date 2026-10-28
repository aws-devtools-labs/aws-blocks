// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub - actual implementation runs server-side

import type { AuthStateApi } from '@aws-blocks/auth-common';

export type { BlocksAuth, AuthUser, AuthState, AuthAction, AuthField } from '@aws-blocks/auth-common';
export type { AuthBasicUser, PasswordPolicy, AuthBasicOptions } from './index.js';
export { AuthBasicErrors } from './errors.js';

export class AuthBasic {
	constructor(...args: any[]) {}
	// Server-only: the browser calls the generated client, never these. They throw
	// rather than build an ApiNamespace, which the browser build of core does not ship.
	// `createApi()` keeps the `AuthStateApi` shape (like bb-auth-cognito's stub) so code
	// referencing it typechecks under `--conditions=browser`; `buildApi()` is deprecated.
	createApi(): AuthStateApi {
		throw new Error('AuthBasic.createApi() is server-only; the browser should call the generated client');
	}
	buildApi(): never {
		throw new Error('AuthBasic.buildApi() is server-only; the browser should call the generated client');
	}
}
