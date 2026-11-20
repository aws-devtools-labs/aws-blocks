// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Direct tests for `reservedDomainOf`, the synth-time check behind the
 * `UnverifiableSender` and `UndeliverableReplyTo` warnings.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { reservedDomainOf } from './validation.js';

for (const [address, domain] of [
	['noreply@example.com', 'example.com'],
	['noreply@mail.example.org', 'mail.example.org'],
	['NoReply@EXAMPLE.NET', 'example.net'],
	['noreply@example.com.', 'example.com'],
	['App <noreply@example.com>', 'example.com'],
	['noreply@app.test', 'app.test'],
	['noreply@acme.example', 'acme.example'],
	['noreply@replace-me.invalid', 'replace-me.invalid'],
	['noreply@localhost', 'localhost'],
	['noreply@dev.localhost.', 'dev.localhost'],
] as const) {
	test(`reservedDomainOf(${JSON.stringify(address)}) is ${domain}`, () => {
		assert.strictEqual(reservedDomainOf(address), domain);
	});
}

for (const address of [
	'noreply@acme.com',
	'noreply@notexample.com',
	'noreply@example.com.au',
	'noreply@mytest.dev',
	'App <noreply@acme.com>',
	'no-at-sign',
	'noreply@',
	'noreply@.',
	'',
]) {
	test(`reservedDomainOf(${JSON.stringify(address)}) is undefined`, () => {
		assert.strictEqual(reservedDomainOf(address), undefined);
	});
}
