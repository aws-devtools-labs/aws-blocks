// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EmailClient, EmailErrors } from './index.mock.js';

// Clean mock data between tests to avoid cross-contamination
beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch {}
});

// ── Single recipient ────────────────────────────────────────────────────────

test('send to single recipient returns messageId', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'test', {
		fromAddress: 'noreply@example.com',
	});
	const result = await emailClient.send({
		to: 'user@example.com',
		subject: 'Hello',
		body: 'World',
	});
	assert.ok(result.messageId);
	assert.ok(result.messageId.startsWith('mock-'));
	// Verify persistence
	const dataDir = join(process.cwd(), '.bb-data', 'root-test');
	assert.ok(existsSync(join(dataDir, 'emails.json')));
	const stored = JSON.parse(readFileSync(join(dataDir, 'emails.json'), 'utf8'));
	assert.strictEqual(stored.length, 1);
	assert.strictEqual(stored[0].to, 'user@example.com');
	assert.strictEqual(stored[0].subject, 'Hello');
	assert.strictEqual(stored[0].body, 'World');
	assert.strictEqual(stored[0].messageId, result.messageId);
});

// ── Multiple recipients ─────────────────────────────────────────────────────

test('send to multiple recipients', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'multi', {
		fromAddress: 'noreply@example.com',
	});
	const result = await emailClient.send({
		to: ['alice@example.com', 'bob@example.com'],
		subject: 'Team Update',
		body: 'Check this out',
	});
	assert.ok(result.messageId);
	const dataDir = join(process.cwd(), '.bb-data', 'root-multi');
	const stored = JSON.parse(readFileSync(join(dataDir, 'emails.json'), 'utf8'));
	assert.strictEqual(stored.length, 1);
	assert.deepStrictEqual(stored[0].to, ['alice@example.com', 'bob@example.com']);
});

// ── HTML email support ──────────────────────────────────────────────────────

test('send HTML email', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'html', {
		fromAddress: 'noreply@example.com',
	});
	const result = await emailClient.send({
		to: 'user@example.com',
		subject: 'Rich Email',
		body: 'Plain fallback',
		html: '<h1>Hello</h1>',
	});
	assert.ok(result.messageId);
	const dataDir = join(process.cwd(), '.bb-data', 'root-html');
	const stored = JSON.parse(readFileSync(join(dataDir, 'emails.json'), 'utf8'));
	assert.strictEqual(stored[0].html, '<h1>Hello</h1>');
	assert.strictEqual(stored[0].body, 'Plain fallback');
});

// ── Invalid address rejection ───────────────────────────────────────────────

test('rejects invalid recipient address', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'invalid', {
		fromAddress: 'noreply@example.com',
	});
	await assert.rejects(
		() => emailClient.send({ to: 'not-an-email', subject: 'Test', body: 'Body' }),
		(err: Error) => err.name === EmailErrors.InvalidInput,
	);
});

test('rejects invalid from address', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'badfrom', {
		fromAddress: 'bad-address',
	});
	await assert.rejects(
		() => emailClient.send({ to: 'user@example.com', subject: 'Test', body: 'Body' }),
		(err: Error) => err.name === EmailErrors.InvalidInput,
	);
});

test('rejects if any address in array is invalid', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'mixedaddr', {
		fromAddress: 'noreply@example.com',
	});
	await assert.rejects(
		() => emailClient.send({ to: ['valid@example.com', 'invalid@@'], subject: 'Test', body: 'Body' }),
		(err: Error) => err.name === EmailErrors.InvalidInput,
	);
});

// ── Per-message recipient limit (50 recipients) ─────────────────────────────

test('rejects single message with more than 50 recipients', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'toomany', {
		fromAddress: 'noreply@example.com',
	});
	const recipients = Array.from({ length: 51 }, (_, i) => `user${i}@example.com`);
	await assert.rejects(
		() => emailClient.send({ to: recipients, subject: 'Test', body: 'Body' }),
		(err: Error) => {
			assert.strictEqual(err.name, EmailErrors.InvalidInput);
			assert.ok(err.message.includes('50'));
			return true;
		},
	);
});

test('rejects message with combined To + CC + BCC exceeding 50', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'combined', {
		fromAddress: 'noreply@example.com',
	});
	const toAddrs = Array.from({ length: 20 }, (_, i) => `to${i}@example.com`);
	const ccAddrs = Array.from({ length: 20 }, (_, i) => `cc${i}@example.com`);
	const bccAddrs = Array.from({ length: 11 }, (_, i) => `bcc${i}@example.com`);
	await assert.rejects(
		() => emailClient.send({ to: toAddrs, subject: 'Test', body: 'Body', cc: ccAddrs, bcc: bccAddrs }),
		(err: Error) => {
			assert.strictEqual(err.name, EmailErrors.InvalidInput);
			assert.ok(err.message.includes('50'));
			return true;
		},
	);
});

test('allows message with exactly 50 recipients', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'exact50', {
		fromAddress: 'noreply@example.com',
	});
	const recipients = Array.from({ length: 50 }, (_, i) => `user${i}@example.com`);
	const result = await emailClient.send({ to: recipients, subject: 'Test', body: 'Body' });
	assert.ok(result.messageId);
	const dataDir = join(process.cwd(), '.bb-data', 'root-exact50');
	const stored = JSON.parse(readFileSync(join(dataDir, 'emails.json'), 'utf8'));
	assert.strictEqual(stored.length, 1);
});

// ── Batch: per-message recipient limit ──────────────────────────────────────

test('sendBatch marks message with more than 50 recipients as failed', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'batchrecip', {
		fromAddress: 'noreply@example.com',
	});
	const recipients = Array.from({ length: 51 }, (_, i) => `user${i}@example.com`);
	const result = await emailClient.sendBatch([
		{ to: recipients, subject: 'Too many', body: 'Body' },
	]);
	assert.strictEqual(result.results.length, 1);
	assert.strictEqual(result.results[0].status, 'failed');
	assert.ok(result.results[0].error!.includes('50'));
});

// ── Batch: returns SendBatchResult ──────────────────────────────────────────

test('sendBatch returns SendBatchResult with results array in input order', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'batchresult', {
		fromAddress: 'noreply@example.com',
	});
	const messages = Array.from({ length: 3 }, (_, i) => ({
		to: `user${i}@example.com`,
		subject: `Msg ${i}`,
		body: `Body ${i}`,
	}));
	const result = await emailClient.sendBatch(messages);
	assert.strictEqual(result.results.length, 3);
	for (let i = 0; i < 3; i++) {
		assert.strictEqual(result.results[i].status, 'success');
		assert.ok(result.results[i].messageId);
	}
});

test('sendBatch reports partial failures in correct positions', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'batchpartial', {
		fromAddress: 'noreply@example.com',
	});
	const messages = [
		{ to: 'valid@example.com', subject: 'Good', body: 'Body' },
		{ to: 'invalid@@', subject: 'Bad', body: 'Body' },
		{ to: 'also-valid@example.com', subject: 'Good', body: 'Body' },
	];
	const result = await emailClient.sendBatch(messages);
	assert.strictEqual(result.results.length, 3);
	assert.strictEqual(result.results[0].status, 'success');
	assert.ok(result.results[0].messageId);
	assert.strictEqual(result.results[1].status, 'failed');
	assert.ok(result.results[1].error!.includes('Invalid'));
	assert.strictEqual(result.results[2].status, 'success');
	assert.ok(result.results[2].messageId);
});

test('sendBatch returns all failures without throwing when ALL messages fail', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'batchallfail', {
		fromAddress: 'noreply@example.com',
	});
	const messages = [
		{ to: 'invalid@@', subject: 'Bad1', body: 'Body' },
		{ to: 'also-invalid@@', subject: 'Bad2', body: 'Body' },
	];
	const result = await emailClient.sendBatch(messages);
	assert.strictEqual(result.results.length, 2);
	assert.strictEqual(result.results[0].status, 'failed');
	assert.ok(result.results[0].error!.includes('Invalid'));
	assert.strictEqual(result.results[1].status, 'failed');
	assert.ok(result.results[1].error!.includes('Invalid'));
});

// ── Batch: many messages succeeds ───────────────────────────────────────────

test('sendBatch sends a batch of 100 messages (the default maxBatchSize)', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'bigbatch', {
		fromAddress: 'noreply@example.com',
	});
	const messages = Array.from({ length: 100 }, (_, i) => ({
		to: `user${i}@example.com`,
		subject: `Msg ${i}`,
		body: `Body ${i}`,
	}));
	const result = await emailClient.sendBatch(messages);
	assert.strictEqual(result.results.length, 100);
	for (const r of result.results) {
		assert.strictEqual(r.status, 'success');
		assert.ok(r.messageId);
	}
	const dataDir = join(process.cwd(), '.bb-data', 'root-bigbatch');
	const stored = JSON.parse(readFileSync(join(dataDir, 'emails.json'), 'utf8'));
	assert.strictEqual(stored.length, 100);
});

test('sendBatch sends all messages within small batch', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'batchok', {
		fromAddress: 'noreply@example.com',
	});
	const messages = Array.from({ length: 3 }, (_, i) => ({
		to: `user${i}@example.com`,
		subject: `Msg ${i}`,
		body: `Body ${i}`,
	}));
	const result = await emailClient.sendBatch(messages);
	assert.strictEqual(result.results.length, 3);
	for (const r of result.results) {
		assert.strictEqual(r.status, 'success');
	}
	const dataDir = join(process.cwd(), '.bb-data', 'root-batchok');
	const stored = JSON.parse(readFileSync(join(dataDir, 'emails.json'), 'utf8'));
	assert.strictEqual(stored.length, 3);
});

// ── File persistence ────────────────────────────────────────────────────────

test('emails persist across instances', async () => {
	const emailClient1 = new EmailClient({ id: 'root' } as any, 'persist', {
		fromAddress: 'noreply@example.com',
	});
	await emailClient1.send({ to: 'user@example.com', subject: 'First', body: 'First body' });

	// New instance with same scope path reads from disk
	const emailClient2 = new EmailClient({ id: 'root' } as any, 'persist', {
		fromAddress: 'noreply@example.com',
	});
	await emailClient2.send({ to: 'user2@example.com', subject: 'Second', body: 'Second body' });

	const dataDir = join(process.cwd(), '.bb-data', 'root-persist');
	const stored = JSON.parse(readFileSync(join(dataDir, 'emails.json'), 'utf8'));
	assert.strictEqual(stored.length, 2);
	assert.strictEqual(stored[0].subject, 'First');
	assert.strictEqual(stored[1].subject, 'Second');
});

// ── Message size limit ──────────────────────────────────────────────────────

test('rejects messages exceeding 40 MB', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'big', {
		fromAddress: 'noreply@example.com',
	});
	const bigBody = 'x'.repeat(41 * 1024 * 1024);
	await assert.rejects(
		() => emailClient.send({ to: 'user@example.com', subject: 'Big', body: bigBody }),
		(err: Error) => err.name === EmailErrors.SendFailed,
	);
});

// ── fullId generation ───────────────────────────────────────────────────────

test('fullId generation with parent', () => {
	const emailClient = new EmailClient({ id: 'parent' } as any, 'child', {
		fromAddress: 'noreply@example.com',
	});
	assert.strictEqual(emailClient.fullId, 'parent-child');
});

// ── messageId uniqueness ────────────────────────────────────────────────────

test('each send returns a unique messageId', async () => {
	const emailClient = new EmailClient({ id: 'root' } as any, 'unique', {
		fromAddress: 'noreply@example.com',
	});
	const r1 = await emailClient.send({ to: 'user@example.com', subject: 'A', body: 'a' });
	const r2 = await emailClient.send({ to: 'user@example.com', subject: 'B', body: 'b' });
	assert.notStrictEqual(r1.messageId, r2.messageId);
});
