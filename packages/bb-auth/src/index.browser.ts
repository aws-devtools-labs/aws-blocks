// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/bb-auth` — `browser` entry.
 *
 * `Auth` runs server-side only. This stub keeps every name importable from a
 * browser bundle (so shared code type-checks and links) and re-exports the
 * error constants a frontend matches with `isAuthError`. Each method throws:
 * browser code talks to the backend through the generated client instead.
 *
 * Deliberately imports nothing from `./index.mock.js` or the runtime stub, so
 * no server code reaches a browser bundle: its only runtime imports are the
 * error constants (`@aws-blocks/auth-common`, which resolves `@aws-blocks/core`
 * to core's browser entry) and the pure `fromExisting` helper.
 * `index.browser.test.ts` walks the built import graph and loads this entry
 * under `--conditions=browser` to keep it that way.
 *
 * Must stay a named-export superset of the default entry
 * (`conditional-exports.test.ts` in `packages/blocks`). When the default entry
 * gains an export, add it here — a re-export for constants and pure helpers, a
 * throwing stub for anything server-side.
 *
 * The sign-in UI lives in `@aws-blocks/bb-auth/ui`.
 */

import { makeExternalUserPoolRef } from './external-pool.js';
import type { ExternalUserPoolRef } from './types.js';

export type { AuthBase } from './auth-base.js';
export type { AuthErrorName } from './errors.js';
export { AuthErrors, isAuthError } from './errors.js';
export { customOauth2, github, stubIdp } from './providers.js';
export { relayOrigin } from './relay.js';
export type * from './types.js';

function serverSide(method: string): Error {
	return new Error(
		`Auth.${method}() is server-side; call the generated client (the namespace your backend exports ` +
			'from `auth.createApi()`) instead.',
	);
}

/** Browser stub of the server-side `Auth` Building Block. Every method throws. */
export class Auth {
	/** Pure helper, safe in the browser. See the server-side `Auth.fromExisting`. */
	static fromExisting(userPoolId: string, clientId?: string): ExternalUserPoolRef {
		return makeExternalUserPoolRef(userPoolId, clientId);
	}

	createApi(): never {
		throw serverSide('createApi');
	}
	requireAuth(): never {
		throw serverSide('requireAuth');
	}
	requireRole(): never {
		throw serverSide('requireRole');
	}
	checkAuth(): never {
		throw serverSide('checkAuth');
	}
	getCurrentUser(): never {
		throw serverSide('getCurrentUser');
	}
	getAuthSession(): never {
		throw serverSide('getAuthSession');
	}
	signOut(): never {
		throw serverSide('signOut');
	}
	getSignInUrl(): never {
		throw serverSide('getSignInUrl');
	}
	signUp(): never {
		throw serverSide('signUp');
	}
	confirmSignUp(): never {
		throw serverSide('confirmSignUp');
	}
	resendSignUpCode(): never {
		throw serverSide('resendSignUpCode');
	}
	signIn(): never {
		throw serverSide('signIn');
	}
	resetPassword(): never {
		throw serverSide('resetPassword');
	}
	confirmResetPassword(): never {
		throw serverSide('confirmResetPassword');
	}
	updatePassword(): never {
		throw serverSide('updatePassword');
	}
	confirmSignIn(): never {
		throw serverSide('confirmSignIn');
	}
	autoSignIn(): never {
		throw serverSide('autoSignIn');
	}
	getUserAttributes(): never {
		throw serverSide('getUserAttributes');
	}
	updateUserAttributes(): never {
		throw serverSide('updateUserAttributes');
	}
	confirmUserAttribute(): never {
		throw serverSide('confirmUserAttribute');
	}
	sendUserAttributeVerificationCode(): never {
		throw serverSide('sendUserAttributeVerificationCode');
	}
	deleteUser(): never {
		throw serverSide('deleteUser');
	}
	setUpTotp(): never {
		throw serverSide('setUpTotp');
	}
	verifyTotpSetup(): never {
		throw serverSide('verifyTotpSetup');
	}
	updateMfaPreference(): never {
		throw serverSide('updateMfaPreference');
	}
	getMfaPreference(): never {
		throw serverSide('getMfaPreference');
	}
	scanDevices(): never {
		throw serverSide('scanDevices');
	}
	rememberDevice(): never {
		throw serverSide('rememberDevice');
	}
	forgetDevice(): never {
		throw serverSide('forgetDevice');
	}
	startPasskeyRegistration(): never {
		throw serverSide('startPasskeyRegistration');
	}
	completePasskeyRegistration(): never {
		throw serverSide('completePasskeyRegistration');
	}
	listPasskeys(): never {
		throw serverSide('listPasskeys');
	}
	deletePasskey(): never {
		throw serverSide('deletePasskey');
	}
	get admin(): never {
		throw serverSide('admin');
	}
}
