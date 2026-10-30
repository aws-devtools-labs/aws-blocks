// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-CDK synth harness for tests (test-only; never imported by an entry file).
 *
 * Synthesizes a stack in a child process started with `--conditions=cdk` and
 * returns the full CloudFormation template plus the resolved config registry.
 *
 * Why a child process: a test file that imports `../index.cdk.js` directly runs
 * under the default export condition, so nested blocks (`KVStore`, `AppSetting`)
 * resolve to their mock entry points — which emit no CloudFormation. Only the
 * real condition-based resolution shows the infrastructure a customer's
 * `cdk synth` actually produces.
 *
 * Runs against the built `dist/` (the package's test script runs `dist/` anyway).
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One resource in a synthesized CloudFormation template. */
export interface CfnResourceJson {
	Type: string;
	Properties?: Record<string, unknown>;
	Metadata?: Record<string, unknown>;
	[key: string]: unknown;
}

/** A synthesized CloudFormation template (the parts tests read). */
export interface CfnTemplateJson {
	Resources: Record<string, CfnResourceJson>;
	[key: string]: unknown;
}

export interface CdkSynthResult {
	/** The full synthesized template. Path metadata is on: every resource carries `Metadata['aws:cdk:path']`. */
	template: CfnTemplateJson;
	/**
	 * Every `registerConfig()` entry, keyed by config key, with CDK tokens
	 * resolved (e.g. `{ Ref: '<logicalId>' }`).
	 */
	config: Record<string, unknown>;
	/** Whatever the `build` script assigned onto its `report` object. */
	report: Record<string, unknown>;
}

export interface CdkSynthOptions {
	/** ES-module import lines for the probe (e.g. `import { AuthCognito } from '@aws-blocks/bb-auth-cognito';`). */
	imports: string;
	/**
	 * Script body run after the harness stack exists. In scope: `stack` (a plain
	 * `cdk.Stack` id `TestStack` carrying a placeholder handler + execution role,
	 * and `stack.id = 'TestStack'` like a `BlocksStack`), `cdk`, and `report` (a
	 * plain object; anything JSON-serializable assigned to it is returned).
	 */
	build: string;
}

let probeCounter = 0;

/**
 * Synth `options.build` under `--conditions=cdk` in a child process and return
 * the full template, the resolved config registry and the build's `report`.
 *
 * Fails the calling test (with the child's stderr) if the probe exits non-zero.
 */
export function synthUnderCdkConditions(options: CdkSynthOptions): CdkSynthResult {
	const probe = join(
		dirname(fileURLToPath(import.meta.url)),
		`.cdk-synth-probe.${process.pid}.${probeCounter++}.mjs`,
	);
	writeFileSync(
		probe,
		`
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template } from 'aws-cdk-lib/assertions';
import { finalizeConfigRegistry, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
${options.imports}

// Path metadata on, as the CDK CLI does, so each resource names its construct path.
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
globalThis.CURRENT_BLOCKS_STACK = stack;
const report = {};
{
${options.build}
}
finalizeConfigRegistry(stack, handler.role, [{ setEnv: (k, v) => handler.addEnvironment(k, v) }]);

const template = Template.fromStack(stack).toJSON();
const registry = stack[Symbol.for('BLOCKS_CONFIG_REGISTRY')];
const config = registry ? stack.resolve(Object.fromEntries(registry.entries)) : {};
console.log('__CDK_SYNTH__' + JSON.stringify({ template, config, report }));
`,
	);
	try {
		const result = spawnSync(process.execPath, ['--conditions=cdk', probe], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		});
		assert.strictEqual(
			result.status,
			0,
			`real-CDK probe failed (build dist first: npm run build -w packages/bb-auth-cognito)\n${result.stderr}`,
		);
		const marker = result.stdout.split('__CDK_SYNTH__')[1];
		assert.ok(marker, `probe produced no synth report\n${result.stdout}\n${result.stderr}`);
		return JSON.parse(marker.trim()) as CdkSynthResult;
	} finally {
		rmSync(probe, { force: true });
	}
}
