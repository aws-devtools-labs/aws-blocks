// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The declaration under test is import-time, so each case runs in its own child
 * process: the ESM module cache suppresses the side effect on a second in-process
 * import, leaving every case after the first reading the first one's registry.
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const lambdaComputeVersion: string = JSON.parse(
	readFileSync(join(dirname(require.resolve('@aws-blocks/bb-lambda-compute')), '..', 'package.json'), 'utf-8'),
).version;

function registryAfterUmbrellaImport(
	body = '',
	reads = 1,
): {
	blocks: Array<{ name: string; version: string }>;
	totalCount: number;
	customBlocksCount: number;
} {
	const script =
		"const m = await import('@aws-blocks/blocks');" +
		`${body}let r;for(let i=0;i<${reads};i++){r=m.Scope.getRegisteredBlocks();}` +
		"console.log('__REGISTRY__' + JSON.stringify(r));";
	const out = execFileSync('node', ['--input-type=module', '-e', script], {
		encoding: 'utf-8',
		cwd: join(dirname(require.resolve('@aws-blocks/blocks')), '..'),
		env: { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1' },
		timeout: 60_000,
	});
	// Parsing the whole stdout instead would turn any import-time write in the
	// umbrella's graph into an unexplained SyntaxError.
	const line = out.split('\n').find((l) => l.startsWith('__REGISTRY__'));
	assert.ok(line, `child produced no registry line; stdout was:\n${out}`);
	return JSON.parse(line.slice('__REGISTRY__'.length));
}

describe('umbrella default-compute telemetry declaration', () => {
	test('reports LambdaCompute with its package version', () => {
		const { blocks, customBlocksCount } = registryAfterUmbrellaImport();
		assert.deepStrictEqual(
			blocks.filter((b) => b.name === 'LambdaCompute'),
			[{ name: 'LambdaCompute', version: lambdaComputeVersion }],
		);
		assert.strictEqual(
			customBlocksCount,
			0,
			'the default compute must be an official block, not an unnamed custom one',
		);
	});

	test('is appended after the blocks the app constructed', () => {
		const { blocks } = registryAfterUmbrellaImport(
			"new m.Scope('a', { bbName: 'KVStore', bbVersion: '1.0.0' });",
		);
		// Analyst queries read `BuildingBlocks.0`, so a declaration folded in
		// ahead of the app's own blocks would mask every one of them.
		assert.deepStrictEqual(
			blocks.map((b) => b.name),
			['KVStore', 'LambdaCompute'],
		);
	});

	test('repeated reads do not double count it', () => {
		const { totalCount } = registryAfterUmbrellaImport('', 3);
		assert.strictEqual(totalCount, 1);
	});

	test('yields to an app-constructed LambdaCompute instead of doubling it', () => {
		const { blocks, totalCount } = registryAfterUmbrellaImport(
			"new m.Scope('a', { bbName: 'LambdaCompute', bbVersion: '9.9.9' });",
		);
		assert.deepStrictEqual(blocks, [{ name: 'LambdaCompute', version: '9.9.9' }]);
		assert.strictEqual(totalCount, 1);
	});
});
