// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtureApp } from './test-helpers.js';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
	bin: Record<string, string>;
};

describe('the bin map of @aws-blocks/blocks', () => {
	it('installs the CLI as cdk-blocks, and no blocks command', () => {
		assert.strictEqual(manifest.bin['cdk-blocks'], './dist/cli/bin.js');
		assert.strictEqual(Object.hasOwn(manifest.bin, 'blocks'), false);
	});
});

describe('the cdk-blocks bin with stdout not a terminal', () => {
	/** Run the built bin with its stdout a pipe, as a script or a coding agent's shell runs it. */
	const run = (args: string[]) =>
		spawnSync(process.execPath, [fileURLToPath(new URL('./bin.js', import.meta.url)), ...args], {
			cwd: fixtureApp(),
			encoding: 'utf-8',
			env: {
				PATH: process.env.PATH,
				HOME: mkdtempSync(join(tmpdir(), 'blocks-cli-home-')),
				BLOCKS_DISABLE_TELEMETRY: '1',
			},
		});

	it('prints the JSON result of a command that has one, and text with --output text', () => {
		const json = run(['dev', 'stop', '--all']);
		assert.strictEqual(json.status, 0, json.stderr);
		assert.deepStrictEqual(JSON.parse(json.stdout), { stopped: [] });
		const text = run(['dev', 'stop', '--all', '--output', 'text']);
		assert.strictEqual(text.status, 0, text.stderr);
		assert.strictEqual(text.stdout, 'No dev server was recorded for this app.\n');
	});

	it('prints text for a command without a JSON result, and for --version', () => {
		const destroy = run(['sandbox', 'destroy']);
		assert.strictEqual(destroy.status, 0, destroy.stderr);
		assert.match(destroy.stdout, /^No sandbox on this machine/);
		const version = run(['--version']);
		assert.strictEqual(version.status, 0, version.stderr);
		assert.match(version.stdout, /^\d+\.\d+\.\d+\S*\n$/);
	});
});
