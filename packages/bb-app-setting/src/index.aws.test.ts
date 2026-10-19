// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test, mock } from 'node:test';
import { SSMClient } from '@aws-sdk/client-ssm';
import { Scope } from '@aws-blocks/core';
import { AppSetting } from './index.aws.js';

const TEST_CMK = 'arn:aws:kms:us-east-1:111122223333:key/abcd1234-5678-90ab-cdef-1234567890ab';

/** Capture the input of the next PutParameterCommand sent by the runtime. */
function captureSend() {
	const inputs: any[] = [];
	const m = mock.method(SSMClient.prototype, 'send', async (cmd: any) => {
		inputs.push(cmd.input);
		return {};
	});
	return { inputs, restore: () => m.mock.restore() };
}

describe('AWS runtime put() KMS key', () => {
	test('passes the CMK as KeyId when a secret is backed by kmsKeyArn', async () => {
		const { inputs, restore } = captureSend();
		try {
			const setting = new AppSetting(new Scope('app'), 'cmk', { secret: true, kmsKeyArn: TEST_CMK });
			await setting.put('rotated-value');
			assert.strictEqual(inputs.length, 1);
			assert.strictEqual(inputs[0].Type, 'SecureString');
			assert.strictEqual(inputs[0].KeyId, TEST_CMK, 'overwrite must re-specify the CMK, not fall back to aws/ssm');
		} finally {
			restore();
		}
	});

	test('omits KeyId for a default-key secret', async () => {
		const { inputs, restore } = captureSend();
		try {
			const setting = new AppSetting(new Scope('app'), 'plain', { secret: true });
			await setting.put('v');
			assert.strictEqual(inputs[0].Type, 'SecureString');
			assert.strictEqual(inputs[0].KeyId, undefined);
		} finally {
			restore();
		}
	});

	test('omits KeyId for a non-secret String parameter', async () => {
		const { inputs, restore } = captureSend();
		try {
			const setting = new AppSetting<string>(new Scope('app'), 'cfg', { value: 'init' });
			await setting.put('next');
			assert.strictEqual(inputs[0].Type, 'String');
			assert.strictEqual(inputs[0].KeyId, undefined);
		} finally {
			restore();
		}
	});
});
