// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub - actual implementation runs server-side
import { ApiNamespace } from '@aws-blocks/core';

export type { BlocksAuth, AuthUser, AuthState, AuthAction, AuthField } from '@aws-blocks/auth-common';
export type { AuthBasicUser, PasswordPolicy, AuthBasicOptions } from './index.js';
export { AuthBasicErrors } from './errors.js';

export class AuthBasic {
	constructor(...args: any[]) {}
	createApi() {
		return new ApiNamespace({ id: 'auth' }, 'auth', null as any);
	}
	buildApi() {
		return new ApiNamespace({ id: 'auth' }, 'auth', null as any);
	}
}
