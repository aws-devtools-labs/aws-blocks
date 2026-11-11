// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { auroraClusterIdentifier, sanitizeSchemaName } from './constants.js';

describe('a name longer than the limit is cut and gets a hash of the id', () => {
	test('a schema name keeps 54 characters, one separator and the hash', () => {
		assert.match(sanitizeSchemaName('a'.repeat(80)), /^a{54}_[0-9a-f]{8}$/);
	});

	test('a cut that ends on the separator does not double it', () => {
		assert.match(sanitizeSchemaName(`${'a'.repeat(53)}_${'b'.repeat(20)}`), /^a{53}_[0-9a-f]{8}$/);
		assert.match(auroraClusterIdentifier(`${'a'.repeat(42)}-${'b'.repeat(20)}`), /^a{42}-[0-9a-f]{8}$/);
	});

	test('a name within the limit is unchanged', () => {
		assert.strictEqual(sanitizeSchemaName('orders'), 'orders');
		assert.strictEqual(auroraClusterIdentifier('App-Shared'), 'app-shared');
	});
});
