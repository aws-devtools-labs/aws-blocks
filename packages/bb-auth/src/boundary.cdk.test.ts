// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `defaults.permissionsBoundary` coverage for `Auth`, on both stores.
 *
 * Each synth runs in a child process with `--conditions=cdk` (the package's
 * tests run without it, where the bare `@aws-blocks/bb-app-setting` import
 * resolves to the mock and the session secret creates no CDK resources). Under
 * the condition the session secret synthesizes its own roles (`BlocksSecretInitFn`
 * and the `BlocksSecretProvider` framework role), and these tests check them too.
 */
import assert from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

/**
 * Synthesize `build` (statements using `stack`, `Auth` and `AppSetting`) into a
 * fresh cloud assembly under `defaults.permissionsBoundary`, in a child process
 * run with `--conditions=cdk`, so `AppSetting` creates its real CDK resources
 * (the session secret's `BlocksSecretInitFn` / `BlocksSecretProvider` roles).
 * Returns the assembly directory and the stack's artifact id.
 */
function synthBounded(build: string): { outdir: string; artifactId: string } {
	const outdir = mkdtempSync(join(tmpdir(), 'auth-boundary-'));
	const handlerPath = join(outdir, 'handler.mjs');
	writeFileSync(handlerPath, 'export const handler = async () => ({});\n');
	const backendPath = join(outdir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
	// The probe sits next to this file so `./index.cdk.js` resolves to this package's build.
	const probe = join(dirname(fileURLToPath(import.meta.url)), `.boundary-probe.${process.pid}.${probeCounter++}.mjs`);
	writeFileSync(
		probe,
		`
import * as cdk from 'aws-cdk-lib';
import { BlocksPresets, BlocksStack, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { ComputeBase } from '@aws-blocks/core/cdk/internal';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { Auth } from './index.cdk.js';

// A minimal default compute (bb-auth doesn't depend on bb-lambda-compute):
// one inline function that runs AS the shared execution role, like LambdaCompute.
class StubLambdaCompute extends ComputeBase {
	constructor(scope, id) {
		super(id, { parent: scope });
		this.fn = new cdk.aws_lambda.Function(this, 'Handler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
			role: this.executionRole,
		});
	}
	setEnv(key, value) { this.fn.addEnvironment(key, value); }
	apiHandler() { return this.fn; }
	applyTracing() {}
	healthWidgets() { return []; }
	loggingWidgets() { return []; }
	tracingWidgets() { return []; }
}

const app = new cdk.App({ outdir: ${JSON.stringify(outdir)} });
const stack = await BlocksStack.create(app, 'AuthBoundary', {
	backendHandlerPath: ${JSON.stringify(handlerPath)},
	backendCDKPath: ${JSON.stringify(backendPath)},
	defaults: { ...BlocksPresets.production, permissionsBoundary: ${JSON.stringify(GUARD_BOUNDARY)} },
	defaultComputeFactory: (root) => new StubLambdaCompute(root, 'DefaultCompute'),
});
${build}
app.synth();
console.log('__ARTIFACT__' + stack.artifactId);
`,
	);
	try {
		const result = spawnSync(process.execPath, ['--conditions=cdk', probe], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
		assert.strictEqual(result.status, 0, `CDK probe failed (build dist first: npm run build)\n${result.stderr}`);
		const artifactId = result.stdout.split('__ARTIFACT__')[1]?.trim();
		assert.ok(artifactId, `probe printed no artifact id\n${result.stdout}\n${result.stderr}`);
		return { outdir, artifactId };
	} finally {
		rmSync(probe, { force: true });
	}
}

let probeCounter = 0;

/** Synthesize `build`, check every role, and return the checked role keys. */
function checkedRoles(build: string): string[] {
	const { outdir, artifactId } = synthBounded(build);
	try {
		return assertEveryRoleBoundedAndReported(outdir, `${artifactId}.blocks-iam.json`);
	} finally {
		rmSync(outdir, { recursive: true, force: true });
	}
}

function assertChecked(checked: string[], fragment: string, what: string): void {
	assert.ok(
		checked.some((r) => r.includes(fragment)),
		`${what} was checked: ${checked}`,
	);
}

test("CDK: under defaults.permissionsBoundary, every role a `store: 'builtin'` Auth creates (session-secret roles included) carries the boundary and is in blocks-iam.json", () => {
	const checked = checkedRoles(`
const oktaSecret = new AppSetting(stack, 'okta-secret', { secret: true });
new Auth(stack, 'auth', {
	store: 'builtin',
	providers: { okta: { type: 'oidc', issuer: 'https://dev-1.okta.com', clientId: '0oa1', clientSecret: oktaSecret } },
});
`);
	assertChecked(checked, 'BlocksSecretInitFn', "the session secret's init function role (needs --conditions=cdk)");
	assertChecked(checked, 'BlocksSecretProvider', "the session secret's provider framework role (needs --conditions=cdk)");
});

test('CDK: under defaults.permissionsBoundary, every role a Cognito-store Auth with a federated provider creates (IdP registration and custom-resource provider roles included) carries the boundary and is in blocks-iam.json', () => {
	const checked = checkedRoles(`
const googleSecret = new AppSetting(stack, 'google-secret', { secret: true });
new Auth(stack, 'auth', {
	providers: { google: { type: 'google', clientId: 'g-client', clientSecret: googleSecret } },
});
`);
	assertChecked(checked, 'idpregistrationfn', 'the IdP registration function role');
	assertChecked(checked, 'idpregistrationprovider', 'the IdP registration custom-resource provider role');
	assertChecked(checked, 'BlocksSecretInitFn', "the session secret's init function role (needs --conditions=cdk)");
});
