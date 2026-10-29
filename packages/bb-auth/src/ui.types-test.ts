// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile-only checks for `@aws-blocks/bb-auth/ui`'s typed overrides. Each
 * `@ts-expect-error` asserts the next line is a type error; if it stops being
 * one, the build fails.
 *
 * @internal
 */

import type { SignInNextStep } from './types.js';
import type { AuthActionFields, AuthNextStepName, AuthStateApi } from './ui.js';
import { Authenticator, authOverrides, submitAuthAction } from './ui.js';

declare const authApi: AuthStateApi;

function positive() {
	Authenticator(
		authApi,
		authOverrides({
			hideActions: ['signUp', 'resetPassword', 'signIn:google'],
			headings: { signedOut: 'Sign in to continue', confirmingSignUp: 'Verify your email' },
			actions: {
				signIn: {
					heading: 'Welcome back',
					submitLabel: 'Continue',
					fields: {
						username: { label: 'Email', type: 'email', autocomplete: 'email' },
						password: { hint: 'At least 8 characters' },
					},
				},
				// Sign-up accepts custom attribute fields.
				signUp: { fields: { department: { label: 'Department' } } },
				CONTINUE_SIGN_IN_WITH_TOTP_SETUP: {
					heading: 'Scan this with your authenticator app',
					fields: { sharedSecret: { hint: 'Or type it in manually' } },
				},
				'signIn:okta': { submitLabel: 'Continue with Okta' },
			},
		}),
	);
}

function negative() {
	// @ts-expect-error — not an Auth action name.
	authOverrides({ hideActions: ['signUpp'] });
	// @ts-expect-error — signIn emits no `email` field.
	authOverrides({ actions: { signIn: { fields: { email: { label: 'Email' } } } } });
	// @ts-expect-error — not an AuthState.state value.
	authOverrides({ headings: { signedOutt: 'x' } });
	// @ts-expect-error — a federated provider button has no fields.
	authOverrides({ actions: { 'signIn:google': { fields: { username: { label: 'x' } } } } });
}

async function notifier() {
	await submitAuthAction(authApi, { action: 'signOut' });
	// @ts-expect-error — signIn requires password.
	await submitAuthAction(authApi, { action: 'signIn', username: 'alice' });
}

// Every next step is addressable by name, except the two that route to an action
// (`resetPassword` / `confirmSignUp`). A new next step must be added to
// `AuthActionFields` (or to this list, deliberately).
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Unaddressed = Exclude<AuthNextStepName, keyof AuthActionFields>;
const nextStepsCovered: Equal<Unaddressed, 'RESET_PASSWORD' | 'CONFIRM_SIGN_UP'> = true;
const nextStepsAreSignInNextSteps: Equal<AuthNextStepName, SignInNextStep['name']> = true;

void positive;
void negative;
void notifier;
void nextStepsCovered;
void nextStepsAreSignInNextSteps;
