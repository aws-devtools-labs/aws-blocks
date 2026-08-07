// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared hardening-defaults resolution contract:
 *   per-block option  >  stack-level default  >  framework default
 * plus the sandbox-dependent framework default for point-in-time recovery.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
	FRAMEWORK_HARDENING_DEFAULTS,
	registerStackHardeningDefaults,
	getStackHardeningDefaults,
	resolveLogRetention,
	resolveApiThrottle,
	resolveApiAccessLogs,
	resolvePointInTimeRecovery,
} from './hardening-defaults.js';

function stack(context?: Record<string, unknown>): cdk.Stack {
	const app = new cdk.App({ context });
	return new cdk.Stack(app, 'TestStack');
}

describe('hardening-defaults: framework default (no stack default, no per-block option)', () => {
	test('log retention falls back to ONE_MONTH', () => {
		assert.strictEqual(resolveLogRetention(stack()), RetentionDays.ONE_MONTH);
		assert.strictEqual(resolveLogRetention(stack()), FRAMEWORK_HARDENING_DEFAULTS.logRetention);
	});

	test('api throttle falls back to 100/200', () => {
		assert.deepStrictEqual(resolveApiThrottle(stack()), { rateLimit: 100, burstLimit: 200 });
	});

	test('api access logs default on', () => {
		assert.strictEqual(resolveApiAccessLogs(stack()), true);
	});

	test('PITR default is on in production, off in sandbox', () => {
		assert.strictEqual(resolvePointInTimeRecovery(stack()), true, 'prod → on');
		assert.strictEqual(resolvePointInTimeRecovery(stack({ sandboxMode: 'true' })), false, 'sandbox → off');
		assert.strictEqual(resolvePointInTimeRecovery(stack({ sandboxMode: true })), false, 'sandbox (bool) → off');
	});
});

describe('hardening-defaults: stack-level default overrides the framework default', () => {
	test('stack default log retention wins over framework', () => {
		const s = stack();
		registerStackHardeningDefaults(s, { logRetention: RetentionDays.THREE_MONTHS });
		assert.strictEqual(resolveLogRetention(s), RetentionDays.THREE_MONTHS);
	});

	test('stack default throttle is applied per-field (partial override keeps framework for the rest)', () => {
		const s = stack();
		registerStackHardeningDefaults(s, { apiThrottle: { rateLimit: 500 } });
		assert.deepStrictEqual(resolveApiThrottle(s), { rateLimit: 500, burstLimit: 200 });
	});

	test('stack default can disable access logs', () => {
		const s = stack();
		registerStackHardeningDefaults(s, { apiAccessLogs: false });
		assert.strictEqual(resolveApiAccessLogs(s), false);
	});

	test('stack default can force PITR on even in sandbox', () => {
		const s = stack({ sandboxMode: 'true' });
		registerStackHardeningDefaults(s, { pointInTimeRecovery: true });
		assert.strictEqual(resolvePointInTimeRecovery(s), true);
	});
});

describe('hardening-defaults: per-block option overrides everything', () => {
	test('per-block log retention wins over stack default and framework', () => {
		const s = stack();
		registerStackHardeningDefaults(s, { logRetention: RetentionDays.THREE_MONTHS });
		assert.strictEqual(resolveLogRetention(s, RetentionDays.ONE_WEEK), RetentionDays.ONE_WEEK);
	});

	test('per-block throttle wins per-field', () => {
		const s = stack();
		registerStackHardeningDefaults(s, { apiThrottle: { rateLimit: 500, burstLimit: 900 } });
		assert.deepStrictEqual(resolveApiThrottle(s, { rateLimit: 2000 }), { rateLimit: 2000, burstLimit: 900 });
	});

	test('per-block access-logs flag wins', () => {
		const s = stack();
		registerStackHardeningDefaults(s, { apiAccessLogs: true });
		assert.strictEqual(resolveApiAccessLogs(s, false), false);
	});
});

describe('hardening-defaults: registry plumbing', () => {
	test('getStackHardeningDefaults returns {} when nothing registered', () => {
		assert.deepStrictEqual(getStackHardeningDefaults(stack()), {});
	});

	test('registering undefined is a no-op (keeps framework defaults)', () => {
		const s = stack();
		registerStackHardeningDefaults(s, undefined);
		assert.deepStrictEqual(getStackHardeningDefaults(s), {});
		assert.strictEqual(resolveLogRetention(s), RetentionDays.ONE_MONTH);
	});
});
