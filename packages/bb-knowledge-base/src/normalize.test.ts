// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { isBlocksError } from '@aws-cdk-blocks/core';
import { KnowledgeBaseErrors } from './errors.js';
import { normalizeMaxResults, normalizeSourceFormat, relativeSourceKey } from './normalize.js';

describe('normalizeMaxResults', () => {
	it('defaults to 10 when undefined', () => {
		assert.strictEqual(normalizeMaxResults(undefined), 10);
	});

	it('treats an explicit null as unset and defaults to 10', () => {
		// Parsed JSON (e.g. an agent/tool-calling layer) often sends null for an
		// omitted field; it must not be rejected as a non-integer.
		assert.strictEqual(normalizeMaxResults(null), 10);
	});

	it('passes a valid integer through', () => {
		assert.strictEqual(normalizeMaxResults(50), 50);
	});

	it('clamps finite integers to the 1–100 range', () => {
		assert.strictEqual(normalizeMaxResults(0), 1);
		assert.strictEqual(normalizeMaxResults(-5), 1);
		assert.strictEqual(normalizeMaxResults(200), 100);
		assert.strictEqual(normalizeMaxResults(1), 1);
		assert.strictEqual(normalizeMaxResults(100), 100);
	});

	for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		it(`rejects the non-integer value ${bad} with ValidationError`, () => {
			assert.throws(
				() => normalizeMaxResults(bad),
				(e: unknown) => isBlocksError(e, KnowledgeBaseErrors.ValidationError),
			);
		});
	}
});

describe('normalizeSourceFormat', () => {
	it("defaults to 'uri' when unset", () => {
		assert.strictEqual(normalizeSourceFormat(undefined), 'uri');
		assert.strictEqual(normalizeSourceFormat(null), 'uri');
	});

	it('passes the two supported values through', () => {
		assert.strictEqual(normalizeSourceFormat('uri'), 'uri');
		assert.strictEqual(normalizeSourceFormat('relative'), 'relative');
	});

	it('rejects any other value with ValidationError', () => {
		for (const value of ['key', 'URI', '', 1, {}]) {
			assert.throws(
				() => normalizeSourceFormat(value),
				(err: unknown) => isBlocksError(err, KnowledgeBaseErrors.ValidationError),
				`expected ${JSON.stringify(value)} to be rejected`,
			);
		}
	});
});

describe('relativeSourceKey', () => {
	it('drops the bucket for a folder source (documents sit at the bucket root)', () => {
		assert.strictEqual(relativeSourceKey('s3://stack-kbdata-1a2b3c/faq/returns.md', './knowledge'), 'faq/returns.md');
	});

	it('drops the bucket and the configured prefix for an s3:// source', () => {
		assert.strictEqual(relativeSourceKey('s3://acme-prod-docs/team/docs/a/b.md', 's3://acme-prod-docs/team/docs/'), 'a/b.md');
	});

	it('treats a prefix without a trailing slash the same way the data source does', () => {
		assert.strictEqual(relativeSourceKey('s3://bucket/docs/guide.md', 's3://bucket/docs'), 'guide.md');
	});

	it('keeps the full key for a bucket-root s3:// source', () => {
		assert.strictEqual(relativeSourceKey('s3://bucket/guides/start.md', 's3://bucket'), 'guides/start.md');
	});

	it('keeps the key when it is outside the configured prefix, still without the bucket', () => {
		assert.strictEqual(relativeSourceKey('s3://bucket/other/x.md', 's3://bucket/docs/'), 'other/x.md');
	});

	it('returns an empty string for an empty or non-S3 location, never the raw value', () => {
		assert.strictEqual(relativeSourceKey('', './knowledge'), '');
		assert.strictEqual(relativeSourceKey('https://example.com/a', './knowledge'), '');
		assert.strictEqual(relativeSourceKey('s3://bucket-only', './knowledge'), '');
	});
});
