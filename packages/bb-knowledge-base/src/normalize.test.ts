// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { isBlocksError } from '@aws-blocks/core';
import { KnowledgeBaseErrors } from './errors.js';
import { normalizeMaxResults } from './normalize.js';

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
