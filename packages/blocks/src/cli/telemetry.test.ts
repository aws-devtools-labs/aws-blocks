// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runConfigCli, runSecretCli, runTypegenCli, writeSpec } from '@aws-cdk-blocks/core/scripts';
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

/**
 * How each command in {@link CORE_TRACKED} is shown to send its own event: the core entry
 * point (or bin) the CLI runs, called for real with the telemetry file sink, so removing
 * its tracking fails here and not only in core's own tests. Each probe ends the command
 * early (a usage error, `--help`, a missing backend) so that nothing reaches AWS.
 */
const CORE_PROBES: Record<string, { event: string; run: (dir: string) => Promise<unknown> }> = {
	secret: { event: 'secret', run: () => runSecretCli(['bogus-verb'], { interactive: false }).catch(() => {}) },
	config: { event: 'config', run: () => runConfigCli(['bogus-verb'], { interactive: false }).catch(() => {}) },
	'generate types': {
		event: 'generate:types',
		run: () => runTypegenCli(['--help'], { log: () => {}, error: () => {} }),
	},
	'generate spec': {
		event: 'generate:spec',
		run: (dir) => writeSpec(join(dir, 'missing', 'index.js'), join(dir, 'spec.json')).catch(() => {}),
	},
	// A bin, not a function: run it as `blocks-generate-client` runs, in its own process.
	'generate client': {
		event: 'generate:client',
		run: async (dir) => {
			const bin = fileURLToPath(new URL('../generate-client-cli.js', import.meta.url));
			const result = spawnSync(
				process.execPath,
				[bin, join(dir, 'missing.ts'), `--telemetry-file=${join(dir, 'events.json')}`],
				{ cwd: dir, env: process.env, timeout: 30_000, encoding: 'utf-8', stdio: 'pipe' },
			);
			// Returned so a failed assertion shows why the bin sent no event.
			return `generate-client-cli stderr:\n${result.stderr}${result.error ? `\n${result.error.message}` : ''}`;
		},
	},
};

/**
 * The commands in {@link CORE_TRACKED} without a probe, because no unit test can run them
 * to their event without AWS or a full app: `dev` and the `sandbox` commands send their
 * event from the dev server and sandbox runners (covered by core's
 * `dev-server-telemetry.test.ts` and `sandbox-telemetry.test.ts`), `deploy` and `destroy`
 * need AWS before they finish, and the `vendorize` bin exits on a bad argument before
 * its tracked function runs.
 */
const UNPROBED = [
	'dev',
	'sandbox',
	'sandbox deploy',
	'sandbox preview',
	'sandbox destroy',
	'sandbox console',
	'deploy',
	'destroy',
	'vendorize',
];

const CI_VARS = [
	'CI',
	'CONTINUOUS_INTEGRATION',
	'BUILD_NUMBER',
	'CODEBUILD_BUILD_ID',
	'GITHUB_ACTIONS',
	'GITLAB_CI',
	'CIRCLECI',
	'JENKINS_URL',
	'TF_BUILD',
	'BITBUCKET_BUILD_NUMBER',
	'BUILDKITE',
];

describe('core tracks the commands the CLI leaves to it', () => {
	const originalEnv = { ...process.env };
	const originalArgv = [...process.argv];
	const originalCwd = process.cwd();
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'blocks-core-tracked-'));
		process.chdir(dir);
		for (const name of CI_VARS) delete process.env[name];
		delete process.env.CDK_DISABLE_CLI_TELEMETRY;
		process.env.HOME = dir;
		// Nothing leaves the machine: the send goes to a closed port, the file sink records it.
		process.env.BLOCKS_TELEMETRY_ENDPOINT = 'http://127.0.0.1:1/metrics';
		process.argv = [...originalArgv, `--telemetry-file=${join(dir, 'events.json')}`];
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		process.argv = originalArgv;
		process.chdir(originalCwd);
		rmSync(dir, { recursive: true, force: true });
	});

	function events(): string[] {
		const file = join(dir, 'events.json');
		if (!existsSync(file)) return [];
		const parsed = JSON.parse(readFileSync(file, 'utf-8'));
		return (Array.isArray(parsed) ? parsed : [parsed]).map((e: { event: { command: string } }) => e.event.command);
	}

	it('probes every core-tracked command except the ones listed as unprobed', () => {
		assert.deepEqual(
			CORE_TRACKED.filter((path) => !Object.hasOwn(CORE_PROBES, path)),
			UNPROBED,
		);
	});

	for (const [path, probe] of Object.entries(CORE_PROBES)) {
		it(`"${path}" sends one ${probe.event} event from core`, async () => {
			const detail = await probe.run(dir);
			assert.deepEqual(events(), [probe.event], typeof detail === 'string' ? detail : undefined);
		});
	}
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
			const code = await withCommandTelemetry(
				['whoami'],
				() => undefined,
				async () => {
					calls++;
					return 3;
				},
				tracker(behave),
			);
			assert.equal(code, 3);
			assert.equal(calls, 1);
		});

		it(`rethrows the command's own error when the tracker is ${behave}`, async () => {
			const error = new Error('command failed');
			await assert.rejects(
				withCommandTelemetry(
					['whoami'],
					() => undefined,
					async () => {
						throw error;
					},
					tracker(behave),
				),
				(e) => e === error,
			);
		});
	}

	it('runs the command untracked when the project root lookup throws', async () => {
		let tracked = false;
		const load: LoadTelemetry = async () => ({
			trackExitCode: async (_c, fn) => {
				tracked = true;
				return fn();
			},
		});
		const code = await withCommandTelemetry(
			['docs'],
			() => {
				throw new Error('no cwd');
			},
			async () => 0,
			load,
		);
		assert.equal(code, 0);
		assert.equal(tracked, false);
	});

	it('never loads telemetry for an untracked command', async () => {
		let loaded = false;
		const load: LoadTelemetry = async () => {
			loaded = true;
			throw new Error('unused');
		};
		assert.equal(
			await withCommandTelemetry(
				['deploy'],
				() => undefined,
				async () => 0,
				load,
			),
			0,
		);
		assert.equal(loaded, false);
	});
});
