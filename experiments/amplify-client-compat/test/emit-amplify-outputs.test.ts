// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emitAmplifyOutputs, validateAmplifyOutputs, type BlocksCognitoFacts } from '../src/emit-amplify-outputs.js';

const BASE: BlocksCognitoFacts = {
	region: 'us-west-2',
	userPoolId: 'us-west-2_ABC123',
	userPoolClientId: '1h57kf5a2b3c4d5e6f7g8h9i0j',
	signInWith: ['username', 'email'],
	mfa: 'off',
	passwordPolicy: { minLength: 8, requireNumbers: true },
};

test('emits a schema-valid auth section from the three required Cognito facts', () => {
	const { outputs } = emitAmplifyOutputs(BASE);
	assert.equal(outputs.version, '1');
	assert.equal(outputs.auth?.aws_region, 'us-west-2');
	assert.equal(outputs.auth?.user_pool_id, 'us-west-2_ABC123');
	assert.equal(outputs.auth?.user_pool_client_id, '1h57kf5a2b3c4d5e6f7g8h9i0j');
	assert.deepEqual(validateAmplifyOutputs(outputs), []);
});

test('maps signInWith → username_attributes and password policy to snake_case', () => {
	const { outputs } = emitAmplifyOutputs(BASE);
	assert.deepEqual(outputs.auth?.username_attributes, ['username', 'email']);
	// Unspecified fields fall back to Cognito defaults (aws-amplify@6 requires all five).
	assert.deepEqual(outputs.auth?.password_policy, {
		min_length: 8,
		require_numbers: true,
		require_lowercase: true,
		require_uppercase: true,
		require_symbols: true,
	});
});

test('User-Pool-only design: no identity_pool_id, unauthenticated identities disabled', () => {
	const { outputs } = emitAmplifyOutputs(BASE);
	assert.equal(outputs.auth?.identity_pool_id, undefined);
	assert.equal(outputs.auth?.unauthenticated_identities_enabled, false);
});

test('SMS/TOTP MFA map through; EMAIL MFA is recorded as a gap, not silently dropped', () => {
	const { outputs, gaps } = emitAmplifyOutputs({ ...BASE, mfa: 'optional', mfaTypes: ['TOTP', 'EMAIL'] });
	assert.equal(outputs.auth?.mfa_configuration, 'OPTIONAL');
	assert.deepEqual(outputs.auth?.mfa_methods, ['TOTP']);
	assert.equal(gaps.some((g) => g.category === 'auth' && g.detail.includes('EMAIL')), true);
});

test('blocksApiUrl goes under custom and records the data (AppSync) gap', () => {
	const { outputs, gaps } = emitAmplifyOutputs(BASE, { blocksApiUrl: 'https://d123.cloudfront.net/api' });
	assert.equal((outputs.custom as any)?.blocks_api_url, 'https://d123.cloudfront.net/api');
	assert.equal(outputs.data, undefined, 'must NOT fabricate a data/AppSync section');
	assert.equal(gaps.some((g) => g.category === 'data'), true);
});

test('fileBuckets map to storage (default + buckets list) and flag the credential gap', () => {
	const { outputs, gaps } = emitAmplifyOutputs(BASE, {
		fileBuckets: [
			{ name: 'uploads', bucketName: 'app-uploads', region: 'us-west-2', corsOrigins: ['https://app.example.com'], exposesEtag: true },
			{ name: 'avatars', bucketName: 'app-avatars', region: 'eu-west-1' },
		],
	});
	assert.equal(outputs.storage?.bucket_name, 'app-uploads');
	assert.equal(outputs.storage?.aws_region, 'us-west-2');
	assert.deepEqual(outputs.storage?.buckets?.map((b) => b.name), ['uploads', 'avatars']);
	assert.equal(outputs.storage?.buckets?.some((b) => b.paths), false, 'no paths without an access model');
	assert.equal(gaps.some((g) => g.category === 'storage' && g.detail.includes('NoCredentials')), true);
	// Second bucket has no CORS rule -> its own gap; first is clean.
	assert.equal(gaps.some((g) => g.detail.includes('app-avatars') && g.detail.includes('CORS')), true);
	assert.equal(gaps.some((g) => g.detail.includes('app-uploads')), false);
});

test('a single fileBucket omits the buckets list; duplicate names are rejected', () => {
	const { outputs } = emitAmplifyOutputs(BASE, { fileBuckets: [{ bucketName: 'b1', region: 'us-west-2' }] });
	assert.equal(outputs.storage?.buckets, undefined);
	assert.throws(
		() => emitAmplifyOutputs(BASE, { fileBuckets: [{ name: 'x', bucketName: 'b1', region: 'r' }, { name: 'x', bucketName: 'b2', region: 'r' }] }),
		/duplicate storage bucket name/,
	);
});

test('throws when a required Cognito fact is missing', () => {
	assert.throws(() => emitAmplifyOutputs({ ...BASE, userPoolId: '' }), /userPoolId is required/);
	assert.throws(() => emitAmplifyOutputs({ ...BASE, region: '' }), /region is required/);
});

test('validator catches an incomplete oauth block', () => {
	const { outputs } = emitAmplifyOutputs(BASE);
	// Hand-craft an invalid oauth section to prove the validator rejects it.
	outputs.auth!.oauth = {
		identity_providers: ['GOOGLE'],
		domain: '',
		scopes: ['openid'],
		redirect_sign_in_uri: [],
		redirect_sign_out_uri: [],
		response_type: 'code',
	};
	const errors = validateAmplifyOutputs(outputs);
	assert.equal(errors.length >= 2, true);
});
