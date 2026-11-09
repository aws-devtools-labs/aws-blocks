// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { type KmsEncryptionOption, resolveKmsEncryption } from './kms-encryption.js';

const IDENTITY = { warningPrefix: '@aws-blocks/bb-test', fromKmsKeyHint: 'Thing.fromKmsKey' };
const KEY_ARN = 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234';

function resolve(option: KmsEncryptionOption | undefined) {
	const stack = new cdk.Stack(new cdk.App(), 'stack');
	return { stack, result: resolveKmsEncryption(stack, option, IDENTITY) };
}

test('resolveKmsEncryption: undefined and aws-managed resolve to aws-managed without a warning', () => {
	for (const option of [undefined, 'aws-managed'] as const) {
		const { stack, result } = resolve(option);
		assert.deepStrictEqual(result, { kind: 'aws-managed' });
		assert.strictEqual(Annotations.fromStack(stack).findWarning('*', Match.anyValue()).length, 0);
	}
});

test('resolveKmsEncryption: customer-managed resolves to customer-managed', () => {
	assert.deepStrictEqual(resolve('customer-managed').result, { kind: 'customer-managed' });
});

test('resolveKmsEncryption: a fromKmsKey ref resolves to the imported key', () => {
	const { result } = resolve({ __brand: 'ExternalKmsKeyRef', keyArn: KEY_ARN });
	assert.strictEqual(result.kind, 'imported');
	assert.strictEqual(result.kind === 'imported' && result.key.keyArn, KEY_ARN);
});

test('resolveKmsEncryption: an unrecognized value warns with the block identity and falls back', () => {
	// Deliberately invalid input a JS caller could pass.
	const { stack, result } = resolve('kms' as unknown as KmsEncryptionOption);
	assert.deepStrictEqual(result, { kind: 'aws-managed' });
	const [warning] = Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('Unrecognized encryption'));
	assert.ok(warning);
	assert.match(String(warning.entry.data), /Thing\.fromKmsKey\(arn\)/);
	assert.match(String(warning.entry.data), /\[ack: @aws-blocks\/bb-test:UnknownEncryption\]/);
});
