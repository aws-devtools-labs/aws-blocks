// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synth harness on a **real** `BlocksStack` (test-only; never imported by an
 * entry file).
 *
 * `guard-synth.ts` builds a plain `cdk.Stack` dressed up as a Blocks stack,
 * which is enough for a block's own checks. The stack-level orphaned-baseline
 * check (task D4b) lives in `BlocksStack` itself and must run with no `Auth`
 * block in the app, so this harness goes through `BlocksStack.create()`
 * exactly as an app does: a backend module whose default export builds the
 * blocks, loaded under `--conditions=cdk` in a child process. The default
 * compute is a stub with an inline Lambda (the umbrella's `LambdaCompute` is
 * not a dependency of this package, and its bundling is irrelevant here).
 */

import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CfnTemplateJson } from './cdk-synth.js';

export interface BlocksAppSynthOptions {
	/**
	 * The backend module's body, run with `stack` (the `BlocksStack`) and `Auth`
	 * in scope. `''` builds an app with no block at all — and does not import
	 * `@aws-blocks/bb-auth`.
	 */
	build: string;
	/** The app directory: `backendHandlerPath` is `<appDir>/aws-blocks/index.handler.ts`. */
	appDir: string;
	/** The `BlocksStack` id. @default 'TestStack' */
	stack?: string;
	/** Extra environment for the child (e.g. `BLOCKS_AUTH_REBASELINE`). */
	env?: Record<string, string>;
}

export interface BlocksAppSynthResult {
	ok: boolean;
	/** The synthesized template (`undefined` when synth failed). */
	template?: CfnTemplateJson;
	/** Info annotations anywhere in the stack. */
	infos: string[];
	/** The child's stderr — holds the validation errors when `ok` is false. */
	stderr: string;
}

const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
let counter = 0;

export function synthBlocksApp(options: BlocksAppSynthOptions): BlocksAppSynthResult {
	const n = `${process.pid}.${counter++}`;
	const probe = join(DIST_DIR, `.blocks-app-probe.${n}.mjs`);
	const backend = join(DIST_DIR, `.blocks-app-backend.${n}.mjs`);
	const handlerPath = join(options.appDir, 'aws-blocks', 'index.handler.ts');
	writeFileSync(
		backend,
		// `@aws-blocks/bb-auth` is imported only when the build uses it, so an
		// app without `Auth` proves the stack-level check needs no bb-auth code.
		`
${/\bAuth\b/.test(options.build) ? "import { Auth } from '@aws-blocks/bb-auth';" : ''}
export default (stack) => {
${options.build}
};
`,
	);
	writeFileSync(
		probe,
		`
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { BlocksPresets, BlocksStack, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { Compute } from '@aws-blocks/core/cdk/internal';

class StubCompute extends Compute {
	constructor(scope, id) {
		super(id, { parent: scope });
		this.apiUrl = 'https://example.invalid/aws-blocks/api';
		this.fn = new lambda.Function(this, 'Handler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: lambda.Code.fromInline('exports.handler = async () => {};'),
			role: this.executionRole,
		});
	}
	setEnv(key, value) { this.fn.addEnvironment(key, value); }
	applyTracing() {}
	healthWidgets() { return []; }
	loggingWidgets() { return []; }
	tracingWidgets() { return []; }
}

const app = new cdk.App();
const stack = await BlocksStack.create(app, ${JSON.stringify(options.stack ?? 'TestStack')}, {
	backendHandlerPath: ${JSON.stringify(handlerPath)},
	backendCDKPath: ${JSON.stringify(backend)},
	defaults: BlocksPresets.production,
	defaultComputeFactory: (root) => new StubCompute(root, 'DefaultCompute'),
});
const template = Template.fromStack(stack).toJSON();
const infos = Annotations.fromStack(stack).findInfo('*', Match.anyValue()).map((m) => String(m.entry.data));
console.log('__BLOCKS_APP_SYNTH__' + JSON.stringify({ template, infos }));
`,
	);
	try {
		const result = spawnSync(process.execPath, ['--conditions=cdk', probe], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			cwd: DIST_DIR,
			env: { ...process.env, BLOCKS_AUTH_REBASELINE: '', ...options.env },
		});
		const marker = result.stdout.split('__BLOCKS_APP_SYNTH__')[1];
		if (result.status !== 0 || !marker) return { ok: false, infos: [], stderr: result.stderr };
		const parsed = JSON.parse(marker.trim()) as { template: CfnTemplateJson; infos: string[] };
		return { ok: true, template: parsed.template, infos: parsed.infos, stderr: result.stderr };
	} finally {
		rmSync(probe, { force: true });
		rmSync(backend, { force: true });
	}
}
