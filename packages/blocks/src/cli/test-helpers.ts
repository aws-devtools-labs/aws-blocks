// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Fakes for the CLI tests: captured stdio, a recording spawn, and a fixture app. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realCore from '@aws-blocks/core/scripts';
import type { ChildResult, CliDeps, CoreScripts, SpawnSpec } from './context.js';
import { main } from './main.js';

export interface FakeRun {
	code: number;
	stdout: string;
	stderr: string;
	spawned: SpawnSpec[];
	chdirs: string[];
	prompts: string[];
}

export interface FakeOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	stdinIsTTY?: boolean;
	answer?: string;
	/** Called for each child; return its result. Default: exit 0. */
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
};

/** Run the CLI in this process with fake seams. */
export async function runCli(argv: string[], options: FakeOptions): Promise<FakeRun> {
	const run: FakeRun = { code: -1, stdout: '', stderr: '', spawned: [], chdirs: [], prompts: [] };
	const deps: CliDeps = {
		stdout: { write: (chunk: string) => (run.stdout += chunk) },
		stderr: { write: (chunk: string) => (run.stderr += chunk) },
		stdinIsTTY: options.stdinIsTTY ?? false,
		env: { HOME: options.cwd, ...options.env },
		cwd: options.cwd,
		prompt: async (question) => {
			run.prompts.push(question);
			return options.answer ?? '';
		},
		spawn: async (spec) => {
			run.spawned.push(spec);
			return { code: 0, signal: null, interrupted: false, ...options.onSpawn?.(spec) };
		},
		chdir: (dir) => run.chdirs.push(dir),
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
