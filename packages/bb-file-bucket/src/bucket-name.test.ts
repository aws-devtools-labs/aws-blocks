// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the shared S3 bucket-name validator and its enforcement in the
 * mock entry point. The CDK side is covered in index.cdk.test.ts; this file
 * pins the validator rules and the local-dev (mock) parity behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { Scope, getSdkIdentifiers, isBlocksError } from '@aws-blocks/core';
import { deriveBucketName, validateBucketName } from './bucket-name.js';
import { FileBucket } from './index.mock.js';

// ── Validator unit tests ─────────────────────────────────────────────────────

test('accepts a valid lowercase hyphenated name', () => {
	assert.doesNotThrow(() => validateBucketName('myapp-uploads'));
});

test('accepts a name at exactly 63 characters', () => {
	const name = 'a'.repeat(63);
	assert.doesNotThrow(() => validateBucketName(name));
});

test('rejects a name over 63 characters with an actionable message', () => {
	const name = 'a'.repeat(64);
	assert.throws(
		() => validateBucketName(name),
		(err: unknown) =>
			isBlocksError(err, 'ValidationFailed') &&
			/64 characters/.test((err as Error).message) &&
			/63-character limit/.test((err as Error).message) &&
			/Shorten/.test((err as Error).message),
	);
});

test('rejects a name under 3 characters', () => {
	assert.throws(
		() => validateBucketName('ab'),
		(err: unknown) => isBlocksError(err, 'ValidationFailed') && /at least 3/.test((err as Error).message),
	);
});

test('rejects uppercase characters', () => {
	assert.throws(
		() => validateBucketName('MyApp-Uploads'),
		(err: unknown) => isBlocksError(err, 'ValidationFailed') && /lowercase/.test((err as Error).message),
	);
});

test('rejects underscores', () => {
	assert.throws(
		() => validateBucketName('my_app_uploads'),
		(err: unknown) => isBlocksError(err, 'ValidationFailed'),
	);
});

test('rejects a name not starting with a letter or number', () => {
	assert.throws(
		() => validateBucketName('-myapp'),
		(err: unknown) => isBlocksError(err, 'ValidationFailed') && /begin and end/.test((err as Error).message),
	);
});

test('rejects a name not ending with a letter or number', () => {
	assert.throws(
		() => validateBucketName('myapp-'),
		(err: unknown) => isBlocksError(err, 'ValidationFailed') && /begin and end/.test((err as Error).message),
	);
});

test('rejects adjacent dots', () => {
	assert.throws(
		() => validateBucketName('my..app'),
		(err: unknown) => isBlocksError(err, 'ValidationFailed') && /adjacent dots/.test((err as Error).message),
	);
});

// ── deriveBucketName: keep under-limit names, shorten over-limit ones ────────

/** Every S3 general-purpose bucket naming rule the derived name must satisfy. */
function assertValidS3Name(name: string): void {
	assert.ok(name.length >= 3 && name.length <= 63, `length ${name.length}: ${name}`);
	assert.match(name, /^[a-z0-9.-]+$/);
	assert.match(name, /^[a-z0-9]/);
	assert.match(name, /[a-z0-9]$/);
	assert.ok(!name.includes('..'), name);
	assert.doesNotThrow(() => validateBucketName(name));
}

test('deriveBucketName: names at or under 63 characters are returned byte-identical', () => {
	for (const name of ['abc', 'myapp-uploads', 'a'.repeat(62), 'b'.repeat(63), 'app-some.dotted-name']) {
		assert.strictEqual(deriveBucketName(name), name);
	}
});

test('deriveBucketName: shortens the L52 production-synth name to a valid S3 name', () => {
	// The exact 70-char name that broke a production-mode synth of test-apps/comprehensive.
	const fullId = 'bb-test-prod-default-sandboxdevuser-bzhqra-test-app-preset-balanced-sn';
	assert.strictEqual(fullId.length, 70);
	const name = deriveBucketName(fullId);
	assertValidS3Name(name);
	assert.strictEqual(name.length, 63);
	// Readable prefix of the original, then "-" and an 8-hex-char hash of the full id.
	assert.match(name, /^bb-test-prod-default-sandboxdevuser-bzhqra-test-app-pr-[0-9a-f]{8}$/);
	// Pinned: the name is a physical S3 name, so it must never change for this input.
	assert.strictEqual(name, 'bb-test-prod-default-sandboxdevuser-bzhqra-test-app-pr-16dd5d8c');
});

test('deriveBucketName: over-limit names are deterministic', () => {
	const fullId = `app-${'x'.repeat(80)}-uploads`;
	assert.strictEqual(deriveBucketName(fullId), deriveBucketName(fullId));
});

test('deriveBucketName: distinct over-limit names sharing a long prefix stay distinct', () => {
	const prefix = `app-${'x'.repeat(70)}`;
	const a = deriveBucketName(`${prefix}-uploads`);
	const b = deriveBucketName(`${prefix}-avatars`);
	assert.notStrictEqual(a, b);
	assertValidS3Name(a);
	assertValidS3Name(b);
});

test('deriveBucketName: never leaves a hyphen or dot before the hash separator', () => {
	// Cut points that land on "-" or "." in the original must not yield "--" / ".-".
	for (let i = 40; i < 64; i++) {
		for (const sep of ['-', '.']) {
			const fullId = `${'a'.repeat(i)}${sep}${'b'.repeat(70 - i)}`;
			const name = deriveBucketName(fullId);
			assertValidS3Name(name);
			assert.ok(!/[-.]-[0-9a-f]{8}$/.test(name), name);
		}
	}
});

test('deriveBucketName: over-limit names with invalid characters still fail validation', () => {
	// Shortening only fixes length; other naming rules still surface as ValidationFailed.
	const name = deriveBucketName(`App-${'x'.repeat(70)}`);
	assert.throws(
		() => validateBucketName(name),
		(err: unknown) => isBlocksError(err, 'ValidationFailed') && /lowercase/.test((err as Error).message),
	);
});

// ── Mock parity: construction enforces the same rules ────────────────────────

test('mock: constructing a FileBucket with an over-long scope chain succeeds with a shortened name', () => {
	// Parent id + child id joined with "-" exceeds 63 chars. The derived name is
	// shortened deterministically (same as the CDK and AWS layers) instead of throwing.
	const longParent = new Scope('p'.repeat(60));
	const bucket = new FileBucket(longParent, 'uploads');
	const { bucketName } = getSdkIdentifiers(bucket);
	assert.strictEqual(bucketName, `mock-${deriveBucketName(bucket.fullId)}`);
	assert.ok(deriveBucketName(bucket.fullId).length <= 63);
});

test('mock: an under-limit derived name registers unchanged', () => {
	const bucket = new FileBucket(new Scope('shortapp2'), 'uploads');
	assert.strictEqual(getSdkIdentifiers(bucket).bucketName, 'mock-shortapp2-uploads');
});

test('mock: constructing a FileBucket with a valid derived name succeeds', () => {
	const parent = new Scope('shortapp');
	assert.doesNotThrow(() => new FileBucket(parent, 'uploads'));
});

test('mock: fromExisting bypasses derived-name validation', () => {
	// An over-long scope chain would normally fail, but fromExisting wraps an
	// externally-named bucket so the derived name is not used.
	const longParent = new Scope('p'.repeat(60));
	assert.doesNotThrow(() =>
		new FileBucket(longParent, 'uploads', { bucket: FileBucket.fromExisting('preexisting-bucket-123') }),
	);
});
