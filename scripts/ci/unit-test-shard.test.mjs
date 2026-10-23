// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/unit-test-shard.mjs, plus a check that
// pr-checks.yml runs every shard and that the required "Build, Unit Tests,
// E2E Local" check waits for every part of it.
//
// Run: node --test scripts/ci/unit-test-shard.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { partition, readWorkspaces, workspaceNames } from './unit-test-shard.mjs';

const SCRIPT = fileURLToPath(new URL('./unit-test-shard.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/pr-checks.yml', import.meta.url));

function rootWith(workspaces) {
	const dir = mkdtempSync(join(tmpdir(), 'unit-test-shard-'));
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces }));
	return dir;
}

function cli(...args) {
	return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('partition', () => {
	const workspaces = readWorkspaces(ROOT);

	for (const count of [1, 2, 3, 4, 5, 8]) {
		it(`puts every workspace in exactly one of ${count} non-empty shards, in root order`, () => {
			const shards = partition(workspaces, count);
			assert.equal(shards.length, count);
			for (const shard of shards) {
				assert.ok(shard.length > 0);
				const positions = shard.map((ws) => workspaces.indexOf(ws));
				assert.deepEqual(
					positions,
					[...positions].sort((a, b) => a - b),
				);
			}
			assert.deepEqual(shards.flat().sort(), [...workspaces].sort());
		});
	}

	it('is deterministic', () => {
		assert.deepEqual(partition(workspaces, 3), partition([...workspaces], 3));
	});

	it('balances by weight, heaviest first', () => {
		const shards = partition(['a', 'b', 'c', 'd', 'e'], 2, { a: 5, b: 4, c: 3, d: 2, e: 1 });
		assert.deepEqual(shards, [
			['a', 'd', 'e'],
			['b', 'c'],
		]);
	});

	it('gives a workspace missing from the weights weight 1', () => {
		assert.deepEqual(partition(['x', 'y', 'z'], 2, { x: 1 }), [['x', 'z'], ['y']]);
	});

	it('refuses a count that leaves a shard empty or is not a positive integer', () => {
		assert.throws(() => partition(['a', 'b'], 3), /leave a shard empty/);
		assert.throws(() => partition(['a'], 0), /invalid shard count/);
		assert.throws(() => partition(['a'], 1.5), /invalid shard count/);
	});
});

describe('readWorkspaces', () => {
	it('returns the root package.json workspaces in order', () => {
		assert.deepEqual(readWorkspaces(rootWith(['b', 'a/c'])), ['b', 'a/c']);
	});

	it('refuses globs, duplicates and a missing list', () => {
		assert.throws(() => readWorkspaces(rootWith(['packages/*'])), /unsupported workspace entry/);
		assert.throws(() => readWorkspaces(rootWith(['a', '!b'])), /unsupported workspace entry/);
		assert.throws(() => readWorkspaces(rootWith(['a', 'a'])), /duplicate workspace/);
		assert.throws(() => readWorkspaces(rootWith([])), /no workspaces array/);
		assert.throws(() => readWorkspaces(rootWith({ packages: ['a'] })), /no workspaces array/);
	});
});

describe('workspaceNames', () => {
	function rootWithPackages(packages) {
		const dir = rootWith(Object.keys(packages));
		for (const [ws, pkg] of Object.entries(packages)) {
			mkdirSync(join(dir, ws), { recursive: true });
			writeFileSync(join(dir, ws, 'package.json'), JSON.stringify(pkg));
		}
		return dir;
	}

	it('maps each workspace path to its package name', () => {
		const dir = rootWithPackages({ a: { name: '@x/a' }, 'a/b': { name: 'b' } });
		assert.deepEqual(workspaceNames(dir, ['a/b', 'a']), ['b', '@x/a']);
	});

	it('refuses a missing or duplicate name', () => {
		assert.throws(
			() => workspaceNames(rootWithPackages({ a: {} }), ['a']),
			/workspace a has no usable package name/,
		);
		const dir = rootWithPackages({ a: { name: 'same' }, b: { name: 'same' } });
		assert.throws(() => workspaceNames(dir, ['a', 'b']), /duplicate workspace package name: same/);
	});
});

describe('unit-test-shard.mjs', () => {
	const all = workspaceNames(ROOT, readWorkspaces(ROOT));

	for (const count of [1, 3, 4]) {
		it(`prints ${count} shards that together name every root workspace once`, () => {
			const printed = Array.from({ length: count }, (_, i) => {
				const r = cli(String(i + 1), String(count));
				assert.equal(r.status, 0, r.stderr);
				return r.stdout.trimEnd().split('\n');
			}).flat();
			assert.deepEqual(printed.sort(), [...all].sort());
		});
	}

	// The probe check in local-unit fails when no shard runs it; this catches a
	// rename before CI does.
	it('runs @aws-blocks/core, which holds the real-CDK probe', () => {
		assert.ok(all.includes('@aws-blocks/core'));
	});

	for (const args of [[], ['0', '3'], ['4', '3'], ['1'], ['a', '3'], ['1', '999']]) {
		it(`exits 1 for arguments ${JSON.stringify(args)}`, () => {
			const r = cli(...args);
			assert.equal(r.status, 1);
			assert.equal(r.stdout, '');
			assert.match(r.stderr, /^unit-test-shard: /);
		});
	}
});

describe('pr-checks.yml', () => {
	const yml = readFileSync(WORKFLOW, 'utf8');
	// Each top-level job, from its `  id:` line to the next one.
	const jobs = Object.fromEntries(
		yml
			.split(/^(?=  [a-z][\w-]*:$)/m)
			.slice(1)
			.map((block) => [block.slice(2, block.indexOf(':')), block]),
	);
	const parts = Object.keys(jobs).filter((id) => id.startsWith('local-'));
	const aggregator = jobs['build-and-test-local'];

	it('has the parts of the local check', () => {
		assert.deepEqual(parts.sort(), ['local-build', 'local-e2e', 'local-unit']);
	});

	it('keeps the required check name on an always() job that needs every part', () => {
		assert.match(aggregator, /^    name: Build, Unit Tests, E2E Local\n/m);
		assert.match(aggregator, /^    if: always\(\)\n/m);
		const needs = aggregator.match(/^    needs: \[(.*)\]\n/m)[1].split(/,\s*/);
		assert.deepEqual(needs.sort(), [...parts].sort());
	});

	it('fails the required check unless every part succeeded', () => {
		const loop = aggregator.match(/for part in (.*); do\n/)[1].split(' ');
		assert.deepEqual(loop.sort(), [...parts].sort());
		assert.ok(aggregator.includes(`result=$(jq -r --arg part "$part" '.[$part].result // "missing"' <<<"$NEEDS")`));
		assert.ok(aggregator.includes('if [ "$result" != success ]; then failed=1; fi'));
		assert.ok(aggregator.includes('NEEDS: ${{ toJSON(needs) }}'));
	});

	// Runs the aggregator's own script, so an edit that makes it pass over a
	// failed part (an `exit 0`, a dropped check) fails here, not only one that
	// changes its text. jq is on ubuntu-latest; without it locally, this skips.
	const hasJq = spawnSync('jq', ['--version']).status === 0;
	it('the aggregator script fails unless every part succeeded', { skip: hasJq ? false : 'jq is not on PATH' }, () => {
		const script = aggregator.match(/^ {8}run: \|\n((?: {10}.*\n|\n)+)/m)[1].replace(/^ {10}/gm, '');
		const run = (results) =>
			spawnSync('bash', ['-c', script], {
				env: {
					...process.env,
					NEEDS: JSON.stringify(
						Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { result: v, outputs: {} }])),
					),
				},
			}).status;
		const ok = Object.fromEntries(parts.map((p) => [p, 'success']));
		assert.equal(run(ok), 0);
		for (const p of parts) {
			for (const bad of ['failure', 'skipped', 'cancelled']) assert.equal(run({ ...ok, [p]: bad }), 1, `${p}: ${bad}`);
			const { [p]: _, ...missing } = ok;
			assert.equal(run(missing), 1, `${p} missing`);
		}
	});

	it('runs shards 1..N, where N is the matrix length the script is given', () => {
		const unit = jobs['local-unit'];
		// strategy.job-total is the shard count only while shard is the sole axis.
		const matrix = unit.match(/^ {6}matrix:\n((?: {8}.*\n)+)/m)[1];
		assert.match(matrix, /^ {8}shard: \[[\d, ]+\]\n$/);
		const shards = matrix.match(/\[(.*)\]/)[1].split(/,\s*/).map(Number);
		assert.deepEqual(
			shards,
			shards.map((_, i) => i + 1),
		);
		assert.ok(shards.length <= readWorkspaces(ROOT).length);
		assert.equal(unit.match(/SHARD: \$\{\{ matrix\.shard \}\}/g).length, 2);
		assert.equal(unit.match(/SHARDS: \$\{\{ strategy\.job-total \}\}/g).length, 2);
		assert.ok(unit.includes('npm run test "${args[@]}"'));
	});
});
