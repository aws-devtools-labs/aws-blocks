// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The client half: configure `aws-amplify` from a Blocks-emitted
 * `amplify_outputs.json` and run the standard Cognito auth code paths.
 *
 * The point of this file is to prove — at the type level and at runtime for the
 * config step — that the object `emitAmplifyOutputs` produces is exactly what
 * `Amplify.configure()` consumes, and that `signUp`/`signIn` compile against a
 * Blocks-provisioned pool with NO Amplify backend definition anywhere.
 *
 * Imports resolve against the real installed `aws-amplify@6` package.
 */

import { Amplify } from 'aws-amplify';
import { signIn, signUp, confirmSignUp } from 'aws-amplify/auth';
import type { AmplifyOutputs } from './amplify-outputs-schema.js';

/**
 * Configure Amplify from a Blocks-emitted outputs object.
 * In an app this is `import outputs from '../amplify_outputs.json'`.
 */
export function configureFromBlocks(outputs: AmplifyOutputs): void {
	// v6 accepts the outputs object directly. The emitted `auth` section carries
	// user_pool_id / user_pool_client_id / aws_region, which is all the Cognito
	// provider needs for USER_PASSWORD_AUTH sign-up/sign-in from the browser.
	Amplify.configure(outputs);
}

/** Standard Amplify sign-up — unchanged from a stock Amplify app. */
export async function doSignUp(email: string, password: string) {
	const { isSignUpComplete, nextStep } = await signUp({
		username: email,
		password,
		options: { userAttributes: { email } },
	});
	return { isSignUpComplete, step: nextStep.signUpStep };
}

export async function doConfirm(email: string, code: string) {
	const { isSignUpComplete } = await confirmSignUp({ username: email, confirmationCode: code });
	return isSignUpComplete;
}

/** Standard Amplify sign-in — unchanged from a stock Amplify app. */
export async function doSignIn(email: string, password: string) {
	// Blocks' app client disables SRP (Amplify's default flow), so pick the
	// flow it enables. This is the one line a stock Amplify app must change.
	const { isSignedIn, nextStep } = await signIn({
		username: email,
		password,
		options: { authFlowType: 'USER_PASSWORD_AUTH' },
	});
	return { isSignedIn, step: nextStep.signInStep };
}
