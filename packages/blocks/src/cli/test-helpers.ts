// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Fakes for the CLI tests: captured stdio, a recording spawn, and a fixture app. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realCore from '@aws-blocks/core/scripts';
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
	/** The process argv that in-process core functions read: `node`, `blocks`, then the run's argv. */
	argv: string[];
}

export interface FakeOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	stdinIsTTY?: boolean;
	/** The prompt's answer; `null` interrupts the prompt, as Ctrl-C does. */
	answer?: string | null;
	/**
	 * Called for each child; return its result. Default: exit 0. A dev server runner
	 * has recorded a clean stop (`DEV_STATE.stopped`) in its failure file beforehand.
	 */
	onSpawn?: (spec: SpawnSpec) => Partial<ChildResult> | undefined;
	core?: Partial<CoreScripts>;
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
		argv: ['node', 'blocks', ...argv],
	};
	const deps: CliDeps = {
		stdout: { write: (chunk: string) => (run.stdout += chunk) },
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
			const failureFile = spec.env[DEV_FAILURE_FILE_ENV];
			if (failureFile) writeFileSync(failureFile, DEV_STATE.stopped);
			return { code: 0, signal: null, interrupted: false, ...options.onSpawn?.(spec) };
		},
		chdir: (dir) => run.chdirs.push(dir),
		argv: run.argv,
		core: async () => ({ ...realCore, ...NO_AWS, ...options.core }),
	};
	run.code = await main(argv, deps);
	return run;
}

/** A minimal AWS Blocks app in a temporary directory; returns its root. */
export function fixtureApp(pkg: Record<string, unknown> = { dependencies: { vite: '*' } }): string {
	const root = mkdtempSync(join(tmpdir(), 'blocks-cli-'));
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-app', type: 'module', ...pkg }));
	mkdirSync(join(root, 'aws-blocks'));
	writeFileSync(join(root, 'aws-blocks', 'index.ts'), 'export {};\n');
	writeFileSync(join(root, 'aws-blocks', 'index.cdk.ts'), 'export {};\n');
	mkdirSync(join(root, '.blocks'));
	writeFileSync(join(root, '.blocks', 'config.json'), JSON.stringify({ stackId: 'demo' }));
	return root;
}
