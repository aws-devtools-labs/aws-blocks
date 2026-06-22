// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SmsClient, SmsErrors } from './index.mock.js';

// Clean mock data between tests to avoid cross-contamination
beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch {}
});

function storedFor(id: string): any[] {
	const dataDir = join(process.cwd(), '.bb-data', `root-${id}`);
	const file = join(dataDir, 'messages.json');
	if (!existsSync(file)) return [];
	return JSON.parse(readFileSync(file, 'utf8'));
}

// ── send ──────────────────────────────────────────────────────────────────

test('send to a single number returns a messageId and persists', async () => {
	const sms = new SmsClient({ id: 'root' } as any, 'otp');
	const result = await sms.send({ to: '+14155550123', body: 'Your code is 1234' });

	assert.ok(result.messageId);
	assert.ok(result.messageId.startsWith('mock-'));

	const stored = storedFor('otp');
	assert.strictEqual(stored.length, 1);
	assert.strictEqual(stored[0].kind, 'sms');
	assert.strictEqual(stored[0].to, '+14155550123');
	assert.strictEqual(stored[0].body, 'Your code is 1234');
	assert.strictEqual(stored[0].messageId, result.messageId);
});

test('send defaults smsType to Transactional and applies the option default', async () => {
	const def = new SmsClient({ id: 'root' } as any, 'def');
	await def.send({ to: '+14155550123', body: 'hi' });
	assert.strictEqual(storedFor('def')[0].smsType, 'Transactional');

	const promo = new SmsClient({ id: 'root' } as any, 'promo', { smsType: 'Promotional' });
	await promo.send({ to: '+14155550123', body: 'sale' });
	assert.strictEqual(storedFor('promo')[0].smsType, 'Promotional');
});

test('per-message smsType and senderId override the instance defaults', async () => {
	const sms = new SmsClient({ id: 'root' } as any, 'ovr', { smsType: 'Promotional', senderId: 'ACME' });
	await sms.send({ to: '+14155550123', body: 'hi', smsType: 'Transactional', senderId: 'OTP' });
	const s = storedFor('ovr')[0];
	assert.strictEqual(s.smsType, 'Transactional');
	assert.strictEqual(s.senderId, 'OTP');
});

// ── send validation ─────────────────────────────────────────────────────────

test('rejects a non-E.164 phone number', async () => {
	const sms = new SmsClient({ id: 'root' } as any, 'badnum');
	await assert.rejects(
		() => sms.send({ to: '4155550123', body: 'hi' }),
		(err: Error) => err.name === SmsErrors.InvalidInput,
	);
});

test('rejects an empty body', async () => {
	const sms = new SmsClient({ id: 'root' } as any, 'empty');
	await assert.rejects(
		() => sms.send({ to: '+14155550123', body: '' }),
		(err: Error) => err.name === SmsErrors.InvalidInput,
	);
});

test('rejects a body over the 1600-byte SMS limit', async () => {
	const sms = new SmsClient({ id: 'root' } as any, 'toolong');
	await assert.rejects(
		() => sms.send({ to: '+14155550123', body: 'x'.repeat(1601) }),
		(err: Error) => err.name === SmsErrors.InvalidInput,
	);
});

// ── sendBatch ────────────────────────────────────────────────────────────────

test('sendBatch reports per-entry status in input order', async () => {
	const sms = new SmsClient({ id: 'root' } as any, 'batch');
	const { results } = await sms.sendBatch([
		{ to: '+14155550101', body: 'one' },
		{ to: 'not-a-number', body: 'two' },
		{ to: '+14155550103', body: 'three' },
	]);

	assert.strictEqual(results.length, 3);
	assert.strictEqual(results[0].status, 'success');
	assert.ok(results[0].messageId);
	assert.strictEqual(results[1].status, 'failed');
	assert.ok(results[1].error);
	assert.strictEqual(results[2].status, 'success');

	// Only the two valid messages are persisted.
	assert.strictEqual(storedFor('batch').length, 2);
});

// ── push ──────────────────────────────────────────────────────────────────

test('push to an endpoint ARN returns a messageId and persists', async () => {
	const sms = new SmsClient({ id: 'root' } as any, 'push');
	const target = 'arn:aws:sns:us-east-1:123456789012:endpoint/GCM/myapp/abc-123';
	const result = await sms.push({ target, body: 'You have a new message', title: 'Inbox' });

	assert.ok(result.messageId);
	const stored = storedFor('push');
	assert.strictEqual(stored.length, 1);
	assert.strictEqual(stored[0].kind, 'push');
	assert.strictEqual(stored[0].target, target);
	assert.strictEqual(stored[0].title, 'Inbox');
});

test('push rejects a target that is not an SNS ARN', async () => {
	const sms = new SmsClient({ id: 'root' } as any, 'badtarget');
	await assert.rejects(
		() => sms.push({ target: 'device-token-123', body: 'hi' }),
		(err: Error) => err.name === SmsErrors.InvalidTarget,
	);
});

test('push rejects an empty body', async () => {
	const sms = new SmsClient({ id: 'root' } as any, 'pushempty');
	await assert.rejects(
		() => sms.push({ target: 'arn:aws:sns:us-east-1:123456789012:topic-name', body: '' }),
		(err: Error) => err.name === SmsErrors.InvalidInput,
	);
});
