// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Type-level test against the REAL aws-amplify@6 types: the object
 * `emitAmplifyOutputs` returns is assignable to `AmplifyOutputs` (strict) and
 * accepted by the client entry points with no cast. Compiling this file under
 * `tsc --noEmit` IS the assertion; it is typecheck-only and not run under
 * node:test. The runtime counterpart is `real-amplify-parse.test.ts`.
 */

import type { AmplifyOutputs } from '@aws-amplify/core/internals/utils';
import { emitAmplifyOutputs } from '../src/emit-amplify-outputs.js';
import { configureFromBlocks, doSignIn, doSignUp } from '../src/amplify-client.js';

const { outputs } = emitAmplifyOutputs({
	region: 'us-west-2',
	userPoolId: 'us-west-2_ABC123',
	userPoolClientId: '1h57kf5a2b3c4d5e6f7g8h9i0j',
	signInWith: ['email'],
	mfa: 'off',
});

// Strict check against the REAL aws-amplify@6 outputs type. Amplify.configure()
// itself takes the loose `AmplifyOutputsUnknown`, so it alone proves little;
// this assignment fails to compile if the emitted shape drifts from the schema.
const strict: AmplifyOutputs = outputs;
void strict;

// Same strict check with a multi-bucket storage section.
const withStorage: AmplifyOutputs = emitAmplifyOutputs(
	{ region: 'us-west-2', userPoolId: 'us-west-2_ABC123', userPoolClientId: 'c' },
	{ fileBuckets: [{ name: 'a', bucketName: 'b-a', region: 'us-west-2' }, { name: 'b', bucketName: 'b-b', region: 'us-west-2' }] },
).outputs;
void withStorage;

// The emitted outputs object is accepted by Amplify.configure(...) unchanged.
configureFromBlocks(outputs);

// The standard Cognito flows type-check against the Blocks-provisioned pool.
export async function exercise() {
	await doSignUp('user@example.com', 'Passw0rd!');
	await doSignIn('user@example.com', 'Passw0rd!');
}
