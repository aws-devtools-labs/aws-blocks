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

test('resolveKmsEncryption: an unrecognized value fails the synth with the block identity and valid values', () => {
	// Deliberately invalid input a JS caller could pass (e.g. a typo or a value
	// loaded from JSON/env). It must not fall back to 'aws-managed'.
	for (const option of ['kms', 'kms-managed', { keyArn: KEY_ARN }] as const) {
		assert.throws(
			() => resolve(option as unknown as KmsEncryptionOption),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(err.message, /Unrecognized encryption/);
				assert.match(err.message, /'aws-managed', 'customer-managed', or Thing\.fromKmsKey\(arn\)/);
				assert.match(err.message, /@aws-blocks\/bb-test/);
				// The bad value is named verbatim: strings as-is, objects as JSON (never '[object Object]').
				const rendered = typeof option === 'string' ? option : JSON.stringify(option);
				assert.ok(err.message.includes(`Unrecognized encryption '${rendered}'`), err.message);
				assert.ok(!err.message.includes('[object Object]'), err.message);
				return true;
			},
		);
	}
});

test('resolveKmsEncryption: an unrecognized value no longer emits the UnknownEncryption warning', () => {
	const stack = new cdk.Stack(new cdk.App(), 'stack');
	assert.throws(() => resolveKmsEncryption(stack, 'kms' as unknown as KmsEncryptionOption, IDENTITY));
	assert.strictEqual(Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('UnknownEncryption')).length, 0);
});
