// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-CDK synth harness for tests (test-only; never imported by an entry file).
 *
 * Adapted from `bb-auth-cognito/src/test-support/cdk-synth.ts` (packages can't
 * share test sources). The stack it builds is byte-for-byte the same, so a
 * template synthesized here for `Auth` is directly comparable with one for
 * `AuthCognito`. Additions: an optional stack-defaults preset, and the synth
 * warnings.
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

/** A synth-time warning (`Annotations.addWarningV2`). */
export interface SynthWarning {
	/** Construct path the warning is attached to, e.g. `/TestStack/auth`. */
	path: string;
	message: string;
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
	/** Every warning annotation in the stack. */
	warnings: SynthWarning[];
}

export interface CdkSynthOptions {
	/** ES-module import lines for the probe (e.g. `import { Auth } from '@aws-blocks/bb-auth';`). */
	imports: string;
	/**
	 * Script body run after the harness stack exists. In scope: `stack` (a plain
	 * `cdk.Stack` id `TestStack` carrying a placeholder handler + execution role,
	 * and `stack.id = 'TestStack'` like a `BlocksStack`), `cdk`, and `report` (a
	 * plain object; anything JSON-serializable assigned to it is returned).
	 */
	build: string;
	/**
	 * Stack defaults the blocks resolve via `scope.defaults`, as a
	 * `BlocksStack.create({ defaults: BlocksPresets.<preset> })` would set them.
	 * Omitted: no defaults are registered, so blocks fall back to
	 * `BlocksPresets.production` — exactly what the `AuthCognito` harness does.
	 */
	preset?: 'sandbox' | 'production';
	/**
	 * The default compute's `apiUrl`, as `BlocksStack` exposes it — the block's
	 * API front door (hosted-UI federation registers callback URLs on it).
	 * Defaults to {@link HARNESS_API_URL}; `null` gives the stack no compute.
	 * A stand-in object, not a real `LambdaCompute`: it adds no resources, so
	 * templates stay comparable with `AuthCognito`'s.
	 */
	apiUrl?: string | null;
}

/** The harness's default API URL (a literal, so resolved callback URLs are readable). */
export const HARNESS_API_URL = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api';

let probeCounter = 0;

/**
 * Synth `options.build` under `--conditions=cdk` in a child process and return
 * the full template, the resolved config registry, the build's `report` and the
 * synth warnings.
 *
 * Fails the calling test (with the child's stderr) if the probe exits non-zero.
 */
export function synthUnderCdkConditions(options: CdkSynthOptions): CdkSynthResult {
	const probe = join(
		dirname(fileURLToPath(import.meta.url)),
		`.cdk-synth-probe.${process.pid}.${probeCounter++}.mjs`,
	);
	const presetLine = options.preset ? `stack.defaults = BlocksPresets.${options.preset};` : '';
	const apiUrl = options.apiUrl === undefined ? HARNESS_API_URL : options.apiUrl;
	const computeLine = apiUrl === null ? '' : `stack._defaultCompute = { apiUrl: ${JSON.stringify(apiUrl)} };`;
	writeFileSync(
		probe,
		`
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { finalizeConfigRegistry, DEFAULT_NODE_RUNTIME, BlocksPresets } from '@aws-blocks/core/cdk';
${options.imports}

// Path metadata on, as the CDK CLI does, so each resource names its construct path.
const app = new cdk.App({ context: { 'aws:cdk:enable-path-metadata': true } });
const stack = new cdk.Stack(app, 'TestStack');
stack.id = 'TestStack';
${presetLine}
${computeLine}
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
const warnings = Annotations.fromStack(stack)
	.findWarning('*', Match.anyValue())
	.map((m) => ({ path: m.id, message: String(m.entry.data) }));
console.log('__CDK_SYNTH__' + JSON.stringify({ template, config, report, warnings }));
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
			`real-CDK probe failed (build dist first: npm run build)\n${result.stderr}`,
		);
		const marker = result.stdout.split('__CDK_SYNTH__')[1];
		assert.ok(marker, `probe produced no synth report\n${result.stdout}\n${result.stderr}`);
		return JSON.parse(marker.trim()) as CdkSynthResult;
	} finally {
		rmSync(probe, { force: true });
	}
}
