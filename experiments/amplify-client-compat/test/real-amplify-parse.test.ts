// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime check against the REAL aws-amplify@6 parser: the same function
 * `Amplify.configure()` runs on an amplify_outputs object. No network, no AWS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAmplifyOutputs, parseAmplifyOutputs } from '@aws-amplify/core/internals/utils';
import { emitAmplifyOutputs } from '../src/emit-amplify-outputs.js';

const { outputs } = emitAmplifyOutputs({
	region: 'us-west-2',
	userPoolId: 'us-west-2_ABC123',
	userPoolClientId: '1h57kf5a2b3c4d5e6f7g8h9i0j',
	signInWith: ['email'],
	mfa: 'off',
});

test('real aws-amplify recognises the emitted object as amplify_outputs', () => {
	assert.equal(isAmplifyOutputs(outputs), true);
});

test('real parseAmplifyOutputs yields a Cognito config for the Blocks pool', () => {
	const cfg = parseAmplifyOutputs(outputs);
	const cognito = cfg.Auth?.Cognito;
	assert.ok(cognito, 'Auth.Cognito missing');
	assert.equal(cognito.userPoolId, 'us-west-2_ABC123');
	assert.equal(cognito.userPoolClientId, '1h57kf5a2b3c4d5e6f7g8h9i0j');
	assert.equal(cognito.identityPoolId, undefined, 'no identity pool expected (known gap)');
	assert.equal(cognito.loginWith?.email, true);
});
