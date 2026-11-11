// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { auroraClusterIdentifier, sanitizeSchemaName } from './constants.js';

const hash8 = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 8);

describe('hash-suffixed names', () => {
	it('leaves a short cluster identifier unchanged', () => {
		assert.equal(auroraClusterIdentifier('MyApp-Db'), 'myapp-db');
	});

	it('drops a hyphen left at the cut so the cluster identifier has no doubled hyphen', () => {
		// The cut keeps the first 43 characters (52 - 8 hash - 1 separator); the 43rd is a hyphen.
		const id = `${'a'.repeat(42)}-${'b'.repeat(30)}`;
		const result = auroraClusterIdentifier(id);
		assert.equal(result, `${'a'.repeat(42)}-${hash8(id)}`);
		assert.ok(result.length <= 52);
	});

	it('keeps the cut as is when it does not end in a hyphen', () => {
		const id = 'c'.repeat(80);
		assert.equal(auroraClusterIdentifier(id), `${'c'.repeat(43)}-${hash8(id)}`);
	});

	it('drops an underscore left at the cut so the schema name has no doubled underscore', () => {
		// The cut keeps the first 54 characters (63 - 8 hash - 1 separator); the 54th is an underscore.
		const id = `${'a'.repeat(53)}_${'b'.repeat(20)}`;
		const result = sanitizeSchemaName(id);
		assert.equal(result, `${'a'.repeat(53)}_${hash8(id)}`);
		assert.ok(result.length <= 63);
	});
});
