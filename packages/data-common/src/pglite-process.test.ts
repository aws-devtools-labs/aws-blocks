// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pgliteUnrefTimersExtension, runWithUnrefTimers } from './pglite-process.js';

const hasRef = (timer: NodeJS.Timeout) => timer.hasRef();

describe('runWithUnrefTimers', () => {
	it('unrefs timers created inside, leaves timers created outside alone, and restores setTimeout', () => {
		const original = globalThis.setTimeout;
		const inside = runWithUnrefTimers(() => setTimeout(() => {}, 10_000));
		const outside = setTimeout(() => {}, 10_000);
		try {
			assert.strictEqual(hasRef(inside), false);
			assert.strictEqual(hasRef(outside), true);
			assert.strictEqual(globalThis.setTimeout, original);
		} finally {
			clearTimeout(inside);
			clearTimeout(outside);
		}
	});

	it("keeps a timer re-armed from an unref'd timer's callback unref'd", async () => {
		const rearmed = await new Promise<NodeJS.Timeout>((resolve) => {
			runWithUnrefTimers(() =>
				setTimeout(() => {
					resolve(setTimeout(() => {}, 10_000));
				}, 1),
			);
			// Keep this test alive until the unref'd timer fires.
			setTimeout(() => {}, 50);
		});
		try {
			assert.strictEqual(hasRef(rearmed), false);
		} finally {
			clearTimeout(rearmed);
		}
	});

	it('restores setTimeout when the wrapped function throws, and returns its value otherwise', () => {
		const original = globalThis.setTimeout;
		assert.throws(() =>
			runWithUnrefTimers(() => {
				throw new Error('boom');
			}),
		);
		assert.strictEqual(globalThis.setTimeout, original);
		assert.strictEqual(
			runWithUnrefTimers(() => 42),
			42,
		);
	});
});

describe('pgliteUnrefTimersExtension', () => {
	it("wraps the instance's execProtocolRawSync and the module's callMain", async () => {
		const timers: NodeJS.Timeout[] = [];
		const pg = {
			execProtocolRawSync(message: Uint8Array): Uint8Array {
				timers.push(setTimeout(() => {}, 10_000));
				return message;
			},
		};
		const existingPreRun = () => {};
		const { emscriptenOpts } = await pgliteUnrefTimersExtension.setup(pg, { preRun: [existingPreRun], keep: 1 });
		assert.strictEqual(emscriptenOpts.keep, 1);
		const preRun = emscriptenOpts.preRun;
		assert.ok(Array.isArray(preRun) && preRun.length === 2 && preRun[0] === existingPreRun);

		const mod = {
			callMain(args: string[]) {
				timers.push(setTimeout(() => {}, 10_000));
				return args.length;
			},
		};
		preRun[1](mod);
		try {
			const message = new Uint8Array([1, 2]);
			assert.strictEqual(pg.execProtocolRawSync(message), message);
			assert.strictEqual(mod.callMain(['a', 'b']), 2);
			assert.strictEqual(timers.length, 2);
			assert.deepStrictEqual(timers.map(hasRef), [false, false]);
		} finally {
			for (const t of timers) clearTimeout(t);
		}
	});

	it('leaves an instance or module without those entry points untouched', async () => {
		const { emscriptenOpts } = await pgliteUnrefTimersExtension.setup({}, {});
		const preRun = emscriptenOpts.preRun;
		assert.ok(Array.isArray(preRun) && preRun.length === 1);
		const mod: Record<string, unknown> = {};
		preRun[0](mod);
		assert.deepStrictEqual(mod, {});
	});
});

describe('closeOnProcessExit', () => {
	const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'pglite-process.js')).href;
	const run = (body: string) =>
		spawnSync(
			process.execPath,
			['--input-type=module', '-e', `import { closeOnProcessExit } from ${JSON.stringify(moduleUrl)};\n${body}`],
			{ encoding: 'utf-8', timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '' } },
		);

	it('runs each registered close once when the event loop empties, and lets the process exit', () => {
		const result = run(`closeOnProcessExit(async () => {
	await new Promise((r) => setTimeout(r, 20));
	console.log('closed a');
});
closeOnProcessExit(async () => { console.log('closed b'); });
process.on('exit', () => console.log('exit'));`);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.deepStrictEqual(result.stdout.trim().split('\n'), ['closed b', 'closed a', 'exit']);
	});

	it('skips a cancelled close, and a failing close does not fail the process', () => {
		const result = run(`const cancel = closeOnProcessExit(async () => { console.log('should not run'); });
cancel();
closeOnProcessExit(async () => { throw new Error('close failed'); });
process.on('exit', () => console.log('exit'));`);
		assert.strictEqual(result.status, 0, result.stderr);
		assert.strictEqual(result.stdout.trim(), 'exit');
	});
});
