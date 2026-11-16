// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
	bin: Record<string, string>;
};

describe('the bin map of @aws-blocks/blocks', () => {
	it('installs the CLI as cdk-blocks, and no blocks command', () => {
		assert.strictEqual(manifest.bin['cdk-blocks'], './dist/cli/bin.js');
		assert.strictEqual(Object.hasOwn(manifest.bin, 'blocks'), false);
	});
});

describe('the cdk-blocks bin', () => {
	it('exits 0 without a stack when its reader closes the pipe early, as `| head` does', async () => {
		// Far more than a pipe buffer holds, so the CLI is still writing when the reader goes away.
		const blocks = ['core', 'Auth', 'Realtime', 'FileBucket', 'KVStore', 'Database', 'Agent'];
		const cli = spawn(process.execPath, [fileURLToPath(new URL('./bin.js', import.meta.url)), 'docs', ...blocks], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stderr = '';
		cli.stderr.on('data', (chunk) => (stderr += chunk));
		cli.stdout.once('data', () => cli.stdout.destroy());
		const code = await new Promise<number | null>((resolve) => cli.on('close', resolve));
		assert.strictEqual(code, 0, stderr);
		assert.doesNotMatch(stderr, /EPIPE|Unhandled/);
	});

	it('prints docs as Markdown on a pipe without --output, and as JSON only with --output json', async () => {
		const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
		const run = async (args: string[]) => {
			const cli = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '';
			cli.stdout.on('data', (chunk) => (stdout += chunk));
			const code = await new Promise<number | null>((resolve) => cli.on('close', resolve));
			return { code, stdout };
		};
		const text = await run(['docs', 'KVStore']);
		assert.strictEqual(text.code, 0);
		assert.match(text.stdout, /^# bb-kv-store\/README\.md\b/);
		const json = await run(['docs', 'KVStore', '--output', 'json']);
		assert.strictEqual(json.code, 0);
		assert.strictEqual(JSON.parse(json.stdout).docs[0].doc, 'bb-kv-store/README.md');
	});
});
