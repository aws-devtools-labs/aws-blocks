// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { test } from 'node:test';
import { validateCatalog } from '../src/core/catalog.js';
import type { ParityCase } from '../src/core/types.js';
import { PACK_IDS, PARITY_CASES } from '../src/packs/catalog.js';

test('the bundled catalog is valid', () => {
	assert.deepStrictEqual(validateCatalog(PARITY_CASES, PACK_IDS), []);
});

test('rejects duplicates, missing citations, unknown packs and bad sweep ranges', () => {
	const base: ParityCase = {
		id: 'kv.size.put.x',
		pack: 'kv',
		block: 'bb-kv-store',
		category: 'limits',
		description: 'x',
		source: 'https://docs.aws.amazon.com/x',
		params: {},
	};
	const problems = validateCatalog(
		[
			base,
			base,
			{ ...base, id: 'kv.size.put.y', source: 'trust me' },
			{ ...base, id: 'zz.size.put.z', pack: 'zz' },
			{ ...base, id: 'kv.size.put.w', sweep: { param: 'n', min: 10, max: 1, unit: 'bytes' } },
		],
		['kv'],
	).map((p) => p.problem);
	assert.ok(problems.includes('duplicate id'));
	assert.ok(problems.some((p) => p.startsWith('source must cite')));
	assert.ok(problems.some((p) => p.startsWith('no runner registered')));
	assert.ok(problems.some((p) => p.startsWith('sweep range')));
});
