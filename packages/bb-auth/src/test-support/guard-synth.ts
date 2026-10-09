// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synth harness for the immutability guard (test-only; never imported by an
 * entry file).
 *
 * Like `cdk-synth.ts` — same stack shape, a child process under
 * `--conditions=cdk` — plus what the baseline layer needs: the stack carries a
 * `backendHandlerPath` inside a per-test app directory (as a `BlocksStack`
 * does), the child's environment and working directory are configurable, and
 * a failing synth is returned rather than failing the test.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CfnTemplateJson } from './cdk-synth.js';

export interface GuardSynthResult {
	ok: boolean;
	/** The synthesized template (`undefined` when synth failed). */
	template?: CfnTemplateJson;
	/** Info annotations (the baseline layer reports through these). */
	infos: string[];
	/** Warning annotations (`addWarningV2`). */
	warnings: string[];
	/** The child's stderr — holds the validation error when `ok` is false. */
	stderr: string;
}

export interface GuardSynthOptions {
	/** An expression or statements run with `stack`, `Auth` and `cdk` in scope (the block id `auth`). */
	build: string;
	/** The app directory: the stack's `backendHandlerPath` is `<appDir>/aws-blocks/index.handler.ts`. Omit for no path. */
	appDir?: string;
	/** Extra environment for the child (e.g. `BLOCKS_AUTH_REBASELINE`). */
	env?: Record<string, string>;
	/** Working directory of the child. @default the package's `dist/` */
	cwd?: string;
}

const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
let counter = 0;

/** A fresh, empty app directory under the OS temp dir. */
export function freshAppDir(): string {
	return mkdtempSync(join(tmpdir(), 'bb-auth-guard-'));
}

/** `<appDir>/aws-blocks/baselines/TestStack/TestStack-auth.auth-pool.json` — the default block's baseline. */
export function defaultBaselineFile(appDir: string, fullId = 'TestStack-auth'): string {
	return join(appDir, 'aws-blocks', 'baselines', 'TestStack', `${fullId}.auth-pool.json`);
}

export function synthGuarded(options: GuardSynthOptions): GuardSynthResult {
	const probe = join(DIST_DIR, `.guard-synth-probe.${process.pid}.${counter++}.mjs`);
	const handlerPath = options.appDir ? join(options.appDir, 'aws-blocks', 'index.handler.ts') : '';
	writeFileSync(
		probe,
		`
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { Auth } from '@aws-blocks/bb-auth';
import { AppSetting } from '@aws-blocks/bb-app-setting';

const app = new cdk.App({ context: { 'aws:cdk:enable-path-metadata': true } });
const stack = new cdk.Stack(app, 'TestStack');
stack.id = 'TestStack';
const executionRole = new cdk.aws_iam.Role(stack, 'BlocksRole', {
	assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
});
const handler = new lambda.Function(stack, 'Handler', {
	runtime: DEFAULT_NODE_RUNTIME,
	handler: 'index.handler',
	code: lambda.Code.fromInline('exports.handler = async () => {};'),
	role: executionRole,
});
stack.handler = handler;
stack.executionRole = executionRole;
// A stand-in default compute exposing \`apiUrl\` (adds no resources): hosted-UI
// federation registers its callback URLs on it.
stack._defaultCompute = { apiUrl: 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api' };
${handlerPath ? `stack.backendHandlerPath = ${JSON.stringify(handlerPath)};` : ''}
globalThis.CURRENT_BLOCKS_STACK = stack;
{
${options.build}
}
const template = Template.fromStack(stack).toJSON();
const infos = Annotations.fromStack(stack).findInfo('*', Match.anyValue()).map((m) => String(m.entry.data));
const warnings = Annotations.fromStack(stack).findWarning('*', Match.anyValue()).map((m) => String(m.entry.data));
console.log('__GUARD_SYNTH__' + JSON.stringify({ template, infos, warnings }));
`,
	);
	try {
		const result = spawnSync(process.execPath, ['--conditions=cdk', probe], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			cwd: options.cwd ?? DIST_DIR,
			env: { ...process.env, BLOCKS_AUTH_REBASELINE: '', ...options.env },
		});
		const marker = result.stdout.split('__GUARD_SYNTH__')[1];
		if (result.status !== 0 || !marker) return { ok: false, infos: [], warnings: [], stderr: result.stderr };
		const parsed = JSON.parse(marker.trim()) as { template: CfnTemplateJson; infos: string[]; warnings: string[] };
		return {
			ok: true,
			template: parsed.template,
			infos: parsed.infos,
			warnings: parsed.warnings,
			stderr: result.stderr,
		};
	} finally {
		rmSync(probe, { force: true });
	}
}
