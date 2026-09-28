// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Type-level test: the object `emitAmplifyOutputs` returns is accepted by the
 * Amplify client entry points with no cast. Compiling this file under `tsc
 * --noEmit` IS the assertion — there is no runtime aws-amplify here (it binds
 * to the local shim), so this file is typecheck-only and not run under
 * node:test.
 */

import { emitAmplifyOutputs } from '../src/emit-amplify-outputs.js';
import { configureFromBlocks, doSignIn, doSignUp } from '../src/amplify-client.js';

const { outputs } = emitAmplifyOutputs({
	region: 'us-west-2',
	userPoolId: 'us-west-2_ABC123',
	userPoolClientId: '1h57kf5a2b3c4d5e6f7g8h9i0j',
	signInWith: ['email'],
	mfa: 'off',
});

// The emitted outputs object is accepted by Amplify.configure(...) unchanged.
configureFromBlocks(outputs);

// The standard Cognito flows type-check against the Blocks-provisioned pool.
export async function exercise() {
	await doSignUp('user@example.com', 'Passw0rd!');
	await doSignIn('user@example.com', 'Passw0rd!');
}
