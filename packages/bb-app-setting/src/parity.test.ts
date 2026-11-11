// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock↔AWS parity for `AppSetting.put()` input validation.
 *
 * Each case runs the same input through the local mock and through the AWS
 * runtime with `SSMClient.send` stubbed, and asserts both reach the same
 * outcome: the same named `AppSettingErrors` error (and message), or success.
 * For success cases the captured `PutParameterCommand` input is asserted too,
 * so a stub that rejects every command cannot make a case pass vacuously, and
 * for rejected cases the test asserts that nothing reached SSM.
 *
 * Following `bb-file-bucket/src/parity.test.ts`.
 */
import { test, describe, mock } from 'node:test';
import assert from 'node:assert';
import { SSMClient } from '@aws-sdk/client-ssm';
import { Scope, isBlocksError } from '@aws-blocks/core';
import { AppSetting as MockAppSetting, AppSettingErrors } from './index.mock.js';
import { AppSetting as AwsAppSetting } from './index.aws.js';
import type { AppSettingOptions } from './types.js';

let n = 0;
const uniqueId = () => `as-parity-${Date.now()}-${n++}`;

/** Minimal Standard Schema that accepts only strings starting with `ok`. */
const okPrefixSchema = {
	'~standard': {
		version: 1 as const,
		vendor: 'test',
		validate: (value: unknown) =>
			typeof value === 'string' && value.startsWith('ok')
				? { value }
				: { issues: [{ message: 'value must start with "ok"' }] },
	},
};

type Outcome = { ok: true } | { ok: false; name: string; message: string };

async function outcomeOf(fn: () => Promise<void>): Promise<Outcome> {
	try {
		await fn();
		return { ok: true };
	} catch (e) {
		const err = e as Error;
		return { ok: false, name: err.name, message: err.message };
	}
}

interface Case {
	label: string;
	options: AppSettingOptions<string>;
	value: string;
	/** `null` = success; otherwise the expected `AppSettingErrors` name. */
	error: string | null;
}

// SSM standard-tier values are capped at 4096 bytes. `put()` stores the JSON
// serialization, so a string of length L serializes to L + 2 bytes (quotes).
const cases: Case[] = [
	{ label: 'a small value', options: { value: 'init' }, value: 'next', error: null },
	{ label: 'a value whose serialization is exactly 4096 bytes', options: { value: 'init' }, value: 'a'.repeat(4094), error: null },
	{ label: 'a value whose serialization is 4097 bytes', options: { value: 'init' }, value: 'a'.repeat(4095), error: AppSettingErrors.ValidationFailed },
	{
		label: 'a multi-byte value under 4096 characters but over 4096 UTF-8 bytes',
		options: { value: 'init' },
		value: 'é'.repeat(2100),
		error: AppSettingErrors.ValidationFailed,
	},
	{ label: 'a schema-valid value', options: { value: 'ok-init', schema: okPrefixSchema }, value: 'ok-next', error: null },
	{ label: 'a schema-invalid value', options: { value: 'ok-init', schema: okPrefixSchema }, value: 'bad', error: AppSettingErrors.ValidationFailed },
	{
		// Order: the schema check runs before the size check on both paths, so
		// the schema's message wins.
		label: 'a value that is both schema-invalid and oversized',
		options: { value: 'ok-init', schema: okPrefixSchema },
		value: 'b'.repeat(5000),
		error: AppSettingErrors.ValidationFailed,
	},
];

describe('AppSetting.put() validates the same input the same way on mock and AWS', () => {
	for (const c of cases) {
		test(c.label, async () => {
			const mockSetting = new MockAppSetting<string>(new Scope('app'), uniqueId(), c.options);
			const mockOutcome = await outcomeOf(() => mockSetting.put(c.value));

			const inputs: { Name?: string; Value?: string; Type?: string }[] = [];
			const send = mock.method(SSMClient.prototype, 'send', async (cmd: { input: (typeof inputs)[number] }) => {
				inputs.push(cmd.input);
				return {};
			});
			let awsOutcome: Outcome;
			try {
				const awsSetting = new AwsAppSetting<string>(new Scope('app'), uniqueId(), c.options);
				awsOutcome = await outcomeOf(() => awsSetting.put(c.value));
			} finally {
				send.mock.restore();
			}

			assert.deepStrictEqual(awsOutcome, mockOutcome, 'mock and AWS must reach the same outcome');

			if (c.error === null) {
				assert.deepStrictEqual(mockOutcome, { ok: true });
				assert.strictEqual(inputs.length, 1, 'a valid value must reach SSM exactly once');
				assert.strictEqual(inputs[0].Value, JSON.stringify(c.value));
				assert.strictEqual(inputs[0].Type, 'String');
			} else {
				assert.strictEqual(mockOutcome.ok, false);
				assert.strictEqual(inputs.length, 0, 'a rejected value must not reach SSM');
				await assert.rejects(
					() => mockSetting.put(c.value),
					(e: unknown) => isBlocksError(e, AppSettingErrors.ValidationFailed),
				);
			}
		});
	}

	test('the schema message wins when a value is both schema-invalid and oversized', async () => {
		const setting = new MockAppSetting<string>(new Scope('app'), uniqueId(), { value: 'ok-init', schema: okPrefixSchema });
		await assert.rejects(() => setting.put('b'.repeat(5000)), /value must start with "ok"/);
	});
});
