// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Fakes for the CLI tests: captured stdio, a recording spawn, and a fixture app. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realCore from '@aws-cdk-blocks/core/scripts';
import { type ChildResult, type CliDeps, type CoreScripts, PromptInterrupted, type SpawnSpec } from './context.js';
import { main } from './main.js';
import { DEV_FAILURE_FILE_ENV, DEV_STATE } from './runners/launch.js';

export interface FakeRun {
	code: number;
	stdout: string;
	stderr: string;
	spawned: SpawnSpec[];
	chdirs: string[];
	prompts: string[];
	/** The run's environment, after the CLI set AWS_PROFILE, AWS_REGION and the log level on it. */
	env: NodeJS.ProcessEnv;
	/** The process argv that in-process core functions read: `node`, the task entry, then the run's argv. */
	argv: string[];
	/** The telemetry events the CLI itself sent (see `telemetry.ts`), as `{ command, code }` per run. */
	events: { command: string; code: number | 'threw'; projectRoot?: string }[];
}

export interface FakeOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	stdinIsTTY?: boolean;
	/**
	 * Whether stdout is a terminal. Default: true, so that a command with a JSON
	 * result prints text unless the test passes `--output json` or sets this false.
	 */
	stdoutIsTTY?: boolean;
	/** The prompt's answer; `null` interrupts the prompt, as Ctrl-C does. */
	answer?: string | null;
	/**
	 * Called for each child; return its result. Default: exit 0. A dev server runner
	 * has recorded a clean stop (`DEV_STATE.stopped`) in its failure file beforehand.
	 */
	onSpawn?: (spec: SpawnSpec) => Partial<ChildResult> | undefined;
	/** Called for each child before anything runs it, so before the clean stop above is recorded. */
	beforeSpawn?: (spec: SpawnSpec) => void;
	core?: Partial<CoreScripts>;
	/**
	 * How the telemetry seam fails, to prove a failure never reaches the command:
	 * `load` rejects the entry's import, `track` makes the tracker throw before it
	 * runs the command. Default: a recording tracker that sends nothing.
	 */
	telemetryFailure?: 'load' | 'track';
}

/** Core functions that reach AWS fail unless a test fakes them. */
const NO_AWS: Partial<CoreScripts> = {
	readAwsIdentity: async () => {
		throw new Error('readAwsIdentity is not faked in this test');
	},
	runSecretCli: async () => {
		throw new Error('runSecretCli is not faked in this test');
	},
	runConfigCli: async () => {
		throw new Error('runConfigCli is not faked in this test');
	},
	openConsole: async () => {
		throw new Error('openConsole is not faked in this test');
	},
	deployedStackExists: async () => {
		throw new Error('deployedStackExists is not faked in this test');
	},
};

/** Run the CLI in this process with fake seams. */
export async function runCli(argv: string[], options: FakeOptions): Promise<FakeRun> {
	const run: FakeRun = {
		code: -1,
		stdout: '',
		stderr: '',
		spawned: [],
		chdirs: [],
		prompts: [],
		env: { HOME: options.cwd, ...options.env },
		argv: ['node', 'run.js', ...argv],
		events: [],
	};
	const deps: CliDeps = {
		stdout: { write: (chunk: string) => (run.stdout += chunk), isTTY: options.stdoutIsTTY ?? true },
		stderr: { write: (chunk: string) => (run.stderr += chunk) },
		stdinIsTTY: options.stdinIsTTY ?? false,
		env: run.env,
		cwd: options.cwd,
		prompt: async (question) => {
			run.prompts.push(question);
			if (options.answer === null) throw new PromptInterrupted();
			return options.answer ?? '';
		},
		spawn: async (spec) => {
			run.spawned.push(spec);
			options.beforeSpawn?.(spec);
			const failureFile = spec.env[DEV_FAILURE_FILE_ENV];
			if (failureFile) writeFileSync(failureFile, DEV_STATE.stopped);
			return { code: 0, signal: null, interrupted: false, ...options.onSpawn?.(spec) };
		},
		chdir: (dir) => run.chdirs.push(dir),
		argv: run.argv,
		core: async () => ({ ...realCore, ...NO_AWS, ...options.core }),
		telemetry: async () => {
			if (options.telemetryFailure === 'load') throw new Error('telemetry entry failed to load');
			return {
				trackExitCode: async (command, fn, trackOptions) => {
					if (options.telemetryFailure === 'track') throw new Error('telemetry tracker failed');
					const event: FakeRun['events'][number] = { command, code: 'threw', ...trackOptions };
					run.events.push(event);
					const code = await fn();
					event.code = code;
					return code;
				},
			};
		},
	};
	run.code = await main(argv, deps);
	return run;
}

/** A minimal CDK Blocks app in a temporary directory; returns its root. */
export function fixtureApp(pkg: Record<string, unknown> = { dependencies: { vite: '*' } }): string {
	const root = mkdtempSync(join(tmpdir(), 'blocks-cli-'));
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-app', type: 'module', ...pkg }));
	mkdirSync(join(root, 'cdk-blocks'));
	writeFileSync(join(root, 'cdk-blocks', 'index.ts'), 'export {};\n');
	writeFileSync(join(root, 'cdk-blocks', 'index.cdk.ts'), 'export {};\n');
	mkdirSync(join(root, '.cdk-blocks'));
	writeFileSync(join(root, '.cdk-blocks', 'config.json'), JSON.stringify({ stackId: 'demo' }));
	return root;
}
