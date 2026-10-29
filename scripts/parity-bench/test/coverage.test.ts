// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for functional coverage: the pure computation, and the extractor against real block source.

import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BlockSurface, computeCoverage, exercisedEvidence, renderCoverageMarkdown } from '../src/core/coverage.js';
import type { ParityRecord } from '../src/core/types.js';
import { blockNameOf, extractSurfaces, findRepoRoot } from '../src/surface/extract.js';

const SURFACE: BlockSurface = {
	block: 'bb-kv-store',
	bbName: 'KVStore',
	classes: ['KVStore'],
	methods: [
		{ name: 'KVStore.get', operations: ['dynamodb:GetItem'] },
		{ name: 'KVStore.put', operations: ['dynamodb:PutItem'] },
		{ name: 'KVStore.scan', operations: ['dynamodb:Scan'] },
	],
	operations: {
		'dynamodb:GetItem': { id: 'dynamodb:GetItem', service: 'dynamodb', operation: 'GetItem', errors: ['ResourceNotFoundException'] },
		'dynamodb:PutItem': {
			id: 'dynamodb:PutItem',
			service: 'dynamodb',
			operation: 'PutItem',
			errors: ['ConditionalCheckFailedException', 'ResourceNotFoundException'],
		},
		'dynamodb:Scan': { id: 'dynamodb:Scan', service: 'dynamodb', operation: 'Scan', errors: [] },
	},
};

const probe = (env: string, caseId: string, methods: string[], error?: string): ParityRecord => ({
	kind: 'probe',
	env,
	block: 'bb-kv-store',
	caseId,
	outcome: error ? { status: 'error', error: { name: error } } : { status: 'ok', value: null },
	cleanup: 'ok',
	methods,
	ms: 1,
});

test('coverage joins the surface with app calls and recorded cases', () => {
	const evidence = exercisedEvidence([
		probe('local', 'kv.a', ['KVStore.put']),
		probe('sandbox', 'kv.a', ['KVStore.put'], 'ConditionalCheckFailedException'),
		probe('sandbox', 'kv.b', ['KVStore.put', 'KVStore.get']),
		// A local error is the mock's, not AWS's: it must not count as an AWS error hit.
		probe('local', 'kv.c', ['KVStore.get'], 'ResourceNotFoundException'),
	]);
	const [row] = computeCoverage([SURFACE], new Set(['KVStore.get']), evidence);
	assert.deepStrictEqual(
		row.methods.map((m) => [m.name, m.calledByApp, m.cases]),
		[
			['KVStore.get', true, ['kv.b', 'kv.c']],
			['KVStore.put', false, ['kv.a', 'kv.b']],
			['KVStore.scan', false, []],
		],
	);
	assert.deepStrictEqual(row.errorTypes, ['ConditionalCheckFailedException', 'ResourceNotFoundException']);
	assert.deepStrictEqual(row.errorsSeen, ['ConditionalCheckFailedException']);
});

test('the scorecard shows counts with their share and lists the gaps', () => {
	const rows = computeCoverage([SURFACE], new Set(['KVStore.get']), exercisedEvidence([probe('local', 'kv.a', ['KVStore.put'])]));
	const md = renderCoverageMarkdown(rows, { repo: '.', app: '.', recordings: ['.parity/local'] });
	assert.match(md, /\| bb-kv-store \| 3 \| 1 \(33%\) \| 1 \(33%\) \| 3 \| 2 \| 0 \(0%\) \|/);
	assert.match(md, /\*\*Not exercised at all:\*\* `KVStore\.scan`/);
	assert.match(md, /\*\*No edge case yet:\*\* `KVStore\.get`/);
});

test('the extractor reads bb-kv-store: methods, the DynamoDB operations behind them, and their errors', () => {
	const repo = findRepoRoot(fileURLToPath(new URL('.', import.meta.url)));
	const dir = join(repo, 'packages', 'bb-kv-store');
	assert.strictEqual(blockNameOf(dir), 'KVStore');
	const [surface] = extractSurfaces([dir]);
	assert.deepStrictEqual(
		surface.methods.map((m) => [m.name, m.operations]),
		[
			['KVStore.delete', ['dynamodb:DeleteItem']],
			['KVStore.get', ['dynamodb:GetItem']],
			['KVStore.put', ['dynamodb:PutItem']],
			['KVStore.scan', ['dynamodb:Scan']],
		],
	);
	assert.ok(surface.operations['dynamodb:PutItem'].errors.includes('ConditionalCheckFailedException'));
});
