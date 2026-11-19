// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMMANDS } from './registry.js';
import { CLI_TRACKED_COMMANDS, type LoadTelemetry, trackedCommandName, withCommandTelemetry } from './telemetry.js';
import { fixtureApp, runCli } from './test-helpers.js';

/** Commands whose event core sends (in a runner or in-process), so the CLI must not send a second one. */
const CORE_TRACKED = [
	'dev',
	'sandbox',
	'sandbox deploy',
	'sandbox preview',
	'sandbox destroy',
	'sandbox console',
	'deploy',
	'destroy',
	'vendorize',
	// Tracked at their entry point (core's runSecretCli, runConfigCli, writeSpec and
	// runTypegenCli, and the blocks-generate-client bin), so vendored scripts send them too.
	'secret',
	'config',
	'generate client',
	'generate spec',
	'generate types',
];

describe('CLI telemetry coverage', () => {
	it('tracks every runnable command exactly once: in core or in the CLI', () => {
		const runnable = COMMANDS.filter((command) => command.handler).map((command) => command.path.join(' '));
		for (const path of runnable) {
			const inCli = Object.hasOwn(CLI_TRACKED_COMMANDS, path);
			const inCore = CORE_TRACKED.includes(path);
			assert.ok(inCli !== inCore, `"${path}" must be tracked by exactly one of core and the CLI`);
		}
		for (const path of [...Object.keys(CLI_TRACKED_COMMANDS), ...CORE_TRACKED]) {
			assert.ok(runnable.includes(path), `"${path}" is not a runnable command`);
		}
	});

	it('names each event after its command path', () => {
		assert.equal(trackedCommandName(['dev', 'stop']), 'dev:stop');
		assert.equal(trackedCommandName(['generate', 'client']), undefined);
		assert.equal(trackedCommandName(['deploy']), undefined);
		assert.equal(trackedCommandName(['toString']), undefined);
	});
});

describe('CLI telemetry through main', () => {
	it('sends one event for a tracked command, with its exit code and project root', async () => {
		const root = fixtureApp();
		const run = await runCli(['help'], { cwd: root });
		assert.equal(run.code, 0);
		assert.deepEqual(run.events, [{ command: 'help', code: 0, projectRoot: root }]);
	});

	it('records a tracked command that throws (a usage error, exit 2) as thrown', async () => {
		const root = fixtureApp();
		const run = await runCli(['db'], { cwd: root });
		assert.equal(run.code, 2);
		assert.deepEqual(run.events, [{ command: 'db', code: 'threw', projectRoot: root }]);
	});

	it('sends nothing from the CLI for a command core already tracks', async () => {
		const root = fixtureApp();
		const run = await runCli(['deploy', '--yes'], { cwd: root });
		assert.deepEqual(run.events, []);
	});

	for (const failure of ['load', 'track'] as const) {
		it(`keeps the command's result when telemetry fails to ${failure}`, async () => {
			const root = fixtureApp();
			const healthy = await runCli(['help'], { cwd: root });
			const broken = await runCli(['help'], { cwd: root, telemetryFailure: failure });
			assert.equal(broken.code, 0);
			assert.equal(broken.stdout, healthy.stdout);
			assert.equal(broken.stderr, healthy.stderr);

			const usage = await runCli(['db'], { cwd: root, telemetryFailure: failure });
			assert.equal(usage.code, 2);
		});
	}
});

describe('withCommandTelemetry', () => {
	const tracker =
		(behave: 'ok' | 'throw-before' | 'throw-after' | 'wrong-code'): LoadTelemetry =>
		async () => ({
			trackExitCode: async (_command, fn) => {
				if (behave === 'throw-before') throw new Error('tracker failed');
				const code = await fn();
				if (behave === 'throw-after') throw new Error('send failed');
				return behave === 'wrong-code' ? 99 : code;
			},
		});

	for (const behave of ['ok', 'throw-before', 'throw-after', 'wrong-code'] as const) {
		it(`returns the command's exit code, and runs it once, when the tracker is ${behave}`, async () => {
			let calls = 0;
			const code = await withCommandTelemetry(['whoami'], () => undefined, async () => (calls++, 3), tracker(behave));
			assert.equal(code, 3);
			assert.equal(calls, 1);
		});

		it(`rethrows the command's own error when the tracker is ${behave}`, async () => {
			const error = new Error('command failed');
			await assert.rejects(
				withCommandTelemetry(['whoami'], () => undefined, async () => { throw error; }, tracker(behave)),
				(e) => e === error,
			);
		});
	}

	it('runs the command untracked when the project root lookup throws', async () => {
		let tracked = false;
		const load: LoadTelemetry = async () => ({ trackExitCode: async (_c, fn) => ((tracked = true), fn()) });
		const code = await withCommandTelemetry(['docs'], () => { throw new Error('no cwd'); }, async () => 0, load);
		assert.equal(code, 0);
		assert.equal(tracked, false);
	});

	it('never loads telemetry for an untracked command', async () => {
		let loaded = false;
		const load: LoadTelemetry = async () => { loaded = true; throw new Error('unused'); };
		assert.equal(await withCommandTelemetry(['deploy'], () => undefined, async () => 0, load), 0);
		assert.equal(loaded, false);
	});
});
