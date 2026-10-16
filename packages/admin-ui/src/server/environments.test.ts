// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { isStackNotFound, selectInterestingOutputs, stackConsoleUrl } from './environments.js';

describe('selectInterestingOutputs', () => {
	it('keeps URL-ish outputs only', () => {
		const outputs = selectInterestingOutputs({
			Outputs: [
				{ OutputKey: 'ApiUrl', OutputValue: 'https://x.execute-api.amazonaws.com' },
				{ OutputKey: 'RealtimeWsUrl', OutputValue: 'wss://y' },
				{ OutputKey: 'TableName', OutputValue: 'users' },
			],
		});
		assert.deepStrictEqual(outputs, {
			ApiUrl: 'https://x.execute-api.amazonaws.com',
			RealtimeWsUrl: 'wss://y',
		});
	});

	it('returns undefined when nothing matches', () => {
		assert.strictEqual(selectInterestingOutputs({ Outputs: [{ OutputKey: 'TableName', OutputValue: 'x' }] }), undefined);
		assert.strictEqual(selectInterestingOutputs({}), undefined);
	});
});

describe('stackConsoleUrl', () => {
	it('builds a region-scoped filtered console link', () => {
		const url = stackConsoleUrl('my-stack', 'us-east-1');
		assert.match(url, /^https:\/\/us-east-1\.console\.aws\.amazon\.com\/cloudformation/);
		assert.match(url, /filteringText=my-stack/);
	});
});

describe('isStackNotFound', () => {
	it('matches CloudFormation not-found errors', () => {
		assert.strictEqual(isStackNotFound(new Error('Stack with id my-stack does not exist')), true);
		assert.strictEqual(isStackNotFound(new Error('The security token included in the request is expired')), false);
	});
});
