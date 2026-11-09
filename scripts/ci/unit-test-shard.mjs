// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Splits the root workspaces into shards for the parallel "Local Unit Tests"
// jobs in pr-checks.yml. Every workspace lands in exactly one shard, so the
// shards together run what `npm run test:unit` (npm run test --workspaces)
// runs, and a workspace added later is picked up without editing anything.
//
//   node scripts/ci/unit-test-shard.mjs <shard> <count>
//
// prints the package names of the workspaces in shard <shard> (1-based) of
// <count>, one per line, in root package.json order. Names, not paths: `-w
// <path>` also selects the workspaces nested under that path, which would run
// them in two shards. Tested by scripts/ci/unit-test-shard.test.mjs.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Seconds each workspace's `npm run test` took in a main-based PR Checks run.
// Only used to balance the shards: a workspace missing here weighs 1 and
// still runs. Refresh when the shards drift apart by more than a minute.
const WEIGHTS = {
	'packages/bb-data': 96,
	'packages/core': 79,
	'packages/blocks': 68,
	'packages/hosting': 49,
	'packages/bb-compute': 43,
	'test-apps/pipeline': 33,
	'packages/bb-auth-cognito': 21,
	'packages/bb-distributed-data': 21,
	'packages/bb-auth-basic': 16,
	'packages/bb-lambda-compute': 12,
	'packages/bb-agent': 11,
	'packages/bb-async-job': 10,
	'packages/create-blocks-app': 9,
	'packages/bb-distributed-table': 7,
	'packages/bb-container-compute': 7,
	'packages/bb-auth-oidc': 6,
	'test-apps/auth-cognito-passkeys': 6,
	'test-apps/db-pull-typecheck': 6,
	'packages/pipeline': 5,
	'packages/bb-realtime': 5,
	'packages/bb-dashboard': 5,
	'packages/bb-cron-job': 5,
};

/** The root package.json `workspaces`, as npm runs them for `--workspaces`. */
export function readWorkspaces(rootDir) {
	const { workspaces } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
	if (!Array.isArray(workspaces) || workspaces.length === 0) {
		throw new Error('root package.json has no workspaces array');
	}
	const seen = new Set();
	for (const ws of workspaces) {
		// A glob would need npm's expansion to list; refuse it rather than drop
		// the workspaces it matches.
		if (typeof ws !== 'string' || ws === '' || /[\s*?[\]{}!]/.test(ws)) {
			throw new Error(`unsupported workspace entry: ${JSON.stringify(ws)}`);
		}
		if (seen.has(ws)) throw new Error(`duplicate workspace: ${ws}`);
		seen.add(ws);
	}
	return workspaces;
}

/** The package name of each workspace, so `npm -w <name>` selects only it. */
export function workspaceNames(rootDir, workspaces) {
	const names = workspaces.map((ws) => {
		const { name } = JSON.parse(readFileSync(join(rootDir, ws, 'package.json'), 'utf8'));
		if (typeof name !== 'string' || name === '' || /\s/.test(name)) {
			throw new Error(`workspace ${ws} has no usable package name: ${JSON.stringify(name)}`);
		}
		return name;
	});
	const duplicate = names.find((name, i) => names.indexOf(name) !== i);
	if (duplicate) throw new Error(`duplicate workspace package name: ${duplicate}`);
	return names;
}

/**
 * Splits `workspaces` into `count` non-empty shards: heaviest first onto the
 * lightest shard, then each shard back in `workspaces` order.
 */
export function partition(workspaces, count, weights = WEIGHTS) {
	if (!Number.isInteger(count) || count < 1) throw new Error(`invalid shard count: ${count}`);
	if (count > workspaces.length) {
		throw new Error(`${count} shards for ${workspaces.length} workspaces would leave a shard empty`);
	}
	const order = new Map(workspaces.map((ws, i) => [ws, i]));
	const weight = (ws) => weights[ws] ?? 1;
	const byWeight = [...workspaces].sort((a, b) => weight(b) - weight(a) || order.get(a) - order.get(b));
	const shards = Array.from({ length: count }, () => ({ total: 0, workspaces: [] }));
	for (const ws of byWeight) {
		const lightest = shards.reduce((min, s) => (s.total < min.total ? s : min));
		lightest.workspaces.push(ws);
		lightest.total += weight(ws);
	}
	return shards.map((s) => s.workspaces.sort((a, b) => order.get(a) - order.get(b)));
}

function main([shardArg, countArg]) {
	const shard = Number(shardArg);
	const count = Number(countArg);
	if (!Number.isInteger(shard) || !Number.isInteger(count) || shard < 1 || shard > count) {
		throw new Error('usage: unit-test-shard.mjs <shard> <count>, with 1 <= shard <= count');
	}
	const root = resolve(import.meta.dirname, '../..');
	const shardWorkspaces = partition(readWorkspaces(root), count)[shard - 1];
	process.stdout.write(`${workspaceNames(root, shardWorkspaces).join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main(process.argv.slice(2));
	} catch (err) {
		console.error(`unit-test-shard: ${err.message}`);
		process.exit(1);
	}
}
