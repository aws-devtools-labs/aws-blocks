// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
	bin: Record<string, string>;
};

const taskEntry = ['--input-type=module', '-e', `import '@aws-blocks/blocks/run'`, '--'];

describe('the bin map of @aws-blocks/blocks', () => {
	it('does not install a standalone Blocks command', () => {
		assert.strictEqual(Object.hasOwn(manifest.bin, 'cdk-blocks'), false);
		assert.strictEqual(Object.hasOwn(manifest.bin, 'blocks'), false);
	});
});

describe('the package task entry', () => {
	it('exits 0 without a stack when its reader closes the pipe early, as `| head` does', async () => {
		// Far more than a pipe buffer holds, so the CLI is still writing when the reader goes away.
		const blocks = ['core', 'Auth', 'Realtime', 'FileBucket', 'KVStore', 'Database', 'Agent'];
		const cli = spawn(process.execPath, [...taskEntry, 'docs', ...blocks], {
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stderr = '';
		cli.stderr.on('data', (chunk) => (stderr += chunk));
		cli.stdout.once('data', () => cli.stdout.destroy());
		const code = await new Promise<number | null>((resolve) => cli.on('close', resolve));
		assert.strictEqual(code, 0, stderr);
		assert.doesNotMatch(stderr, /EPIPE|Unhandled/);
	});

	it('prints docs as JSON on a pipe unless Markdown is explicitly requested', async () => {
		const run = async (args: string[]) => {
			const cli = spawn(process.execPath, [...taskEntry, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
			let stdout = '';
			cli.stdout.on('data', (chunk) => (stdout += chunk));
			const code = await new Promise<number | null>((resolve) => cli.on('close', resolve));
			return { code, stdout };
		};
		const text = await run(['docs', 'KVStore', '--output', 'text']);
		assert.strictEqual(text.code, 0);
		assert.match(text.stdout, /^# bb-kv-store\/README\.md\b/);
		const json = await run(['docs', 'KVStore']);
		assert.strictEqual(json.code, 0);
		assert.strictEqual(JSON.parse(json.stdout).docs[0].doc, 'bb-kv-store/README.md');
	});
});
