// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `defaults.permissionsBoundary` coverage for AuthOIDC.
 *
 * This file runs in its own `node --conditions=cdk` invocation (see the
 * package's `test` script). The rest of `index.cdk.test.ts` runs without the
 * condition, where the bare `@aws-blocks/bb-app-setting` import resolves to the
 * mock and the cookie secret creates no CDK resources. Under the condition the
 * cookie secret synthesizes its own roles (`BlocksSecretInitFn` and the
 * `BlocksSecretProvider` framework role), and this test checks them too.
 */
import assert from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BlocksPresets, BlocksStack, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { ComputeBase, type DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { AuthOIDC, cognitoFederated } from './index.cdk.js';
import type { AppSettingLike } from './providers.js';

// ── defaults.permissionsBoundary guard ───────────────────────────────────────
// Every AWS::IAM::Role in every synthesized template (custom-resource provider
// roles and any other stack or helper stack's roles included) must carry the
// configured boundary and be listed in the synth-time IAM report.
//
// Keep in sync: the same helper is copied in the bb-compute,
// bb-container-compute, bb-cron-job and bb-dashboard `index.cdk.test.ts`
// files, and mirrors core's `assertEveryRoleBounded` in
// `packages/core/src/cdk/permissions-boundary.test.ts`. A fix to one copy
// belongs in all of them.

const GUARD_BOUNDARY = 'blocks-guard-boundary';
const GUARD_EXPECTED = {
	'Fn::Join': [
		'',
		['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, `:policy/${GUARD_BOUNDARY}`],
	],
};

/**
 * Read every top-level template and the IAM report in `outdir`; fail on a role
 * without the boundary or missing from the report. Returns the checked roles as
 * `<artifact>/<logicalId>` (for asserting a block's own roles were reached).
 *
 * Only the top level of the cloud assembly is read: templates from a CDK `Stage`
 * (written under `assembly-*` folders) are not. No block tested here creates a Stage.
 */
function assertEveryRoleBoundedAndReported(outdir: string, reportFile: string): string[] {
	const report = JSON.parse(readFileSync(join(outdir, reportFile), 'utf8')) as {
		roles: { stack: string; logicalId: string; permissionsBoundary: unknown }[];
	};
	const reported = new Set(report.roles.map((r) => `${r.stack}/${r.logicalId}`));
	const checked: string[] = [];
	const problems: string[] = [];
	for (const file of readdirSync(outdir).filter((f) => f.endsWith('.template.json'))) {
		const artifact = file.slice(0, -'.template.json'.length);
		const { Resources = {} } = JSON.parse(readFileSync(join(outdir, file), 'utf8')) as {
			Resources?: Record<string, { Type: string; Properties?: { PermissionsBoundary?: unknown } }>;
		};
		for (const [id, r] of Object.entries(Resources)) {
			if (r.Type !== 'AWS::IAM::Role') continue;
			const key = `${artifact}/${id}`;
			checked.push(key);
			if (JSON.stringify(r.Properties?.PermissionsBoundary) !== JSON.stringify(GUARD_EXPECTED)) {
				problems.push(`${key}: boundary ${JSON.stringify(r.Properties?.PermissionsBoundary ?? 'NONE')}`);
			}
			if (!reported.has(key)) problems.push(`${key}: missing from ${reportFile}`);
		}
	}
	assert.ok(checked.length > 0, 'synth should produce at least one role');
	assert.deepStrictEqual(problems, [], `roles not covered by defaults.permissionsBoundary:\n  ${problems.join('\n  ')}`);
	return checked;
}

// An AppSetting-shaped stub: the CDK layer only reads `fullId`; `get()` is the
// runtime path and is never called at synth.
function appSettingStub(fullId: string): AppSettingLike {
	return { fullId, get: async () => 'unused-at-synth' };
}

/**
 * A minimal default compute (bb-auth-oidc doesn't depend on bb-lambda-compute):
 * one inline function that runs AS the shared execution role, like LambdaCompute.
 */
class StubLambdaCompute extends ComputeBase {
	readonly fn: cdk.aws_lambda.Function;
	constructor(scope: never, id: string) {
		super(id, { parent: scope });
		this.fn = new cdk.aws_lambda.Function(this, 'Handler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
			role: this.executionRole,
		});
	}
	setEnv(key: string, value: string): void {
		this.fn.addEnvironment(key, value);
	}
	override apiHandler(): IFunction {
		return this.fn;
	}
	protected applyTracing(): void {}
	protected healthWidgets(_region: string): IWidget[][] {
		return [];
	}
	protected loggingWidgets(_region: string): IWidget[][] {
		return [];
	}
	protected tracingWidgets(_region: string): IWidget[][] {
		return [];
	}
}

test('CDK: under defaults.permissionsBoundary, every role AuthOIDC creates (IdP registration function, custom-resource provider and cookie-secret roles included) carries the boundary and is in blocks-iam.json', async () => {
	const outdir = mkdtempSync(join(tmpdir(), 'oidc-boundary-'));
	try {
		const handlerPath = join(outdir, 'handler.mjs');
		writeFileSync(handlerPath, 'export const handler = async () => ({});\n');
		const backendPath = join(outdir, 'backend.mjs');
		writeFileSync(backendPath, 'export default () => {};\n');
		const factory: DefaultComputeFactory = (root) => new StubLambdaCompute(root as never, 'DefaultCompute');

		const app = new cdk.App({ outdir });
		const stack = await BlocksStack.create(app, 'OidcBoundary', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: { ...BlocksPresets.production, permissionsBoundary: GUARD_BOUNDARY },
			defaultComputeFactory: factory,
		});
		new AuthOIDC(stack, 'auth', {
			providers: [
				cognitoFederated({
					name: 'google',
					identityProvider: 'Google',
					cognitoDomain: 'myapp-abc123',
					region: 'us-east-1',
					clientId: appSettingStub('app-google-client-id'),
					clientSecret: appSettingStub('app-google-client-secret'),
				}),
			],
		});
		app.synth();

		const checked = assertEveryRoleBoundedAndReported(outdir, `${stack.artifactId}.blocks-iam.json`);
		assert.ok(
			checked.some((r) => r.includes('idpregistrationfn')),
			`the IdP registration function role was checked: ${checked}`,
		);
		assert.ok(
			checked.some((r) => r.includes('idpregistrationprovider')),
			`the custom-resource provider framework role was checked: ${checked}`,
		);
		assert.ok(
			checked.some((r) => r.includes('BlocksSecretInitFn')),
			`the cookie secret's init function role was checked (needs --conditions=cdk): ${checked}`,
		);
		assert.ok(
			checked.some((r) => r.includes('BlocksSecretProvider')),
			`the cookie secret's provider framework role was checked (needs --conditions=cdk): ${checked}`,
		);
	} finally {
		rmSync(outdir, { recursive: true, force: true });
	}
});
