// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Negative type tests for `fetchAuthSession` JWT-payload narrowing and
 * `forgetDevice` required deviceKey.
 *
 * @internal
 */

import type { BlocksContext } from '@aws-blocks/core';
import type { AuthCognito } from './index.js';
import type { AuthStateApi } from '@aws-blocks/auth-common';

declare const ctx: BlocksContext;
declare const auth: AuthCognito;

async function payloadIsUnknown() {
	const session = await auth.fetchAuthSession(ctx);
	const sub = session.tokens?.idToken.payload.sub;
	// `sub` is `unknown` — narrowing is the feature.
	if (typeof sub === 'string') {
		const s: string = sub;
		void s;
	}
	// @ts-expect-error — implicit `string` use on unknown is a type error.
	const asStringDirect: string = session.tokens?.idToken.payload.sub;
	void asStringDirect;
}

async function forgetDeviceRequiresKey() {
	// @ts-expect-error — `deviceKey` is now required.
	await auth.forgetDevice(ctx);
	await auth.forgetDevice(ctx, 'device-abc');
}

function createApiReturnsAuthStateApi() {
	const api: AuthStateApi = auth.createApi();
	void api;
}

// ─────────────────────────────────────────────────────────────────────────────
// SignInResult — `status` string discriminator (added for native codegen)
// ─────────────────────────────────────────────────────────────────────────────
//
// `status` is a string-literal union, so it stays fully type-safe end to end:
// narrowing on it works and bogus values are rejected. These are compile-time
// assertions — the `@ts-expect-error` lines must stay errors. See
// {@link SignInResult}.

async function signInStatusNarrows() {
	const r = await auth.signIn('user', 'pass', ctx);

	// Narrowing on the string discriminator reaches the signed-in payload.
	if (r.status === 'signedIn') {
		const user = r.user;
		void user;
	}
	// Narrowing on the other arm reaches `nextStep`.
	if (r.status === 'continueSignIn') {
		const next = r.nextStep;
		void next;
	}
}

async function confirmSignInStatusNarrows() {
	// `confirmSignIn` shares the same `SignInResult` shape.
	const r = await auth.confirmSignIn('session', '123456', ctx);
	if (r.status === 'continueSignIn') {
		void r.nextStep;
	}
}

async function signInStatusNegative() {
	const r = await auth.signIn('user', 'pass', ctx);
	// @ts-expect-error — 'loggedIn' is not a valid status value (proves it's a
	// literal union, not wide `string`).
	if (r.status === 'loggedIn') { /* unreachable */ }
	// @ts-expect-error — the old boolean discriminator is gone; only `status`
	// distinguishes the arms now.
	void r.isSignedIn;
	if (r.status === 'continueSignIn') {
		// @ts-expect-error — `user` only exists on the signedIn arm.
		void r.user;
	}
	if (r.status === 'signedIn') {
		// @ts-expect-error — `nextStep` only exists on the nextStep arm.
		void r.nextStep;
	}
}

void payloadIsUnknown; void forgetDeviceRequiresKey; void createApiReturnsAuthStateApi;
void signInStatusNarrows; void confirmSignInStatusNarrows; void signInStatusNegative;
