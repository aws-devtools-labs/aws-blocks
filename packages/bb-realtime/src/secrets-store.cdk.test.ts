// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Synth tests for where `Realtime` stores its `token-secret` under each preset
 * (`defaults.secretsStore`).
 *
 * The synth runs in a child process started with `--conditions=cdk`, because
 * under plain `node --test` the nested blocks resolve to their mocks and emit
 * no CloudFormation. Runs against the built `dist/`.
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface CfnResource {
	Type: string;
	Properties?: Record<string, unknown>;
	DeletionPolicy?: string;
}

interface ProbeResult {
	resources: Record<string, CfnResource>;
	warnings: string[];
}

let tmpDir: string;

before(() => {
	tmpDir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), 'tmp-rt-secrets-store-'));
	writeFileSync(
		join(tmpDir, 'handler.mjs'),
		"export const handler = async () => ({ statusCode: 200, body: '{}' });\n",
	);
	writeFileSync(join(tmpDir, 'backend.mjs'), 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function synth(preset: 'sandbox' | 'production', withCustomerSecret = false): ProbeResult {
	const probe = join(tmpDir, `probe.${preset}.${withCustomerSecret}.mjs`);
	writeFileSync(
		probe,
		`
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { BlocksPresets, BlocksStack } from '@aws-blocks/core/cdk';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { Realtime } from '@aws-blocks/bb-realtime';
import { AppSetting } from '@aws-blocks/bb-app-setting';

const schema = { '~standard': { version: 1, vendor: 'blocks-test', validate: (value) => ({ value }) } };
const app = new cdk.App({ context: { sandboxMode: ${preset === 'sandbox' ? "'true'" : "'false'"} } });
const stack = await BlocksStack.create(app, 'RtStack', {
	backendHandlerPath: ${JSON.stringify(join(tmpDir, 'handler.mjs'))},
	backendCDKPath: ${JSON.stringify(join(tmpDir, 'backend.mjs'))},
	defaults: BlocksPresets.${preset},
	defaultComputeFactory: (root) => new LambdaCompute(root, 'DefaultCompute'),
});
new Realtime(stack, 'rt', { namespaces: { chat: Realtime.namespace(schema) } });
${withCustomerSecret ? "new AppSetting(stack, 'customer-key', { secret: true });" : ''}
const resources = Template.fromStack(stack).toJSON().Resources;
const warnings = Annotations.fromStack(stack).findWarning('*', Match.anyValue()).map((m) => String(m.entry.data));
console.log('__PROBE__' + JSON.stringify({ resources, warnings }));
`,
	);
	const result = spawnSync(process.execPath, ['--conditions=cdk', probe], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
	});
	assert.strictEqual(result.status, 0, `cdk probe failed (build dist first)\n${result.stderr}`);
	const marker = result.stdout.split('__PROBE__')[1];
	assert.ok(marker, `probe produced no output\n${result.stdout}\n${result.stderr}`);
	return JSON.parse(marker.trim()) as ProbeResult;
}

function ofType(resources: Record<string, CfnResource>, type: string): CfnResource[] {
	return Object.values(resources).filter((r) => r.Type === type);
}

function iamActions(resources: Record<string, CfnResource>): string[] {
	return ofType(resources, 'AWS::IAM::Policy').flatMap((p) => {
		const doc = p.Properties?.PolicyDocument as { Statement: { Action: string | string[] }[] };
		return doc.Statement.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
	});
}

test('production preset: token-secret is a generated Secrets Manager secret, deleted with the stack, read only', () => {
	const { resources, warnings } = synth('production');
	const secrets = ofType(resources, 'AWS::SecretsManager::Secret');
	assert.strictEqual(secrets.length, 1);
	assert.strictEqual(secrets[0].DeletionPolicy, 'Delete');
	assert.strictEqual(secrets[0].Properties?.Name, undefined);
	assert.deepStrictEqual(secrets[0].Properties?.GenerateSecretString, {
		ExcludePunctuation: true,
		PasswordLength: 64,
	});
	assert.strictEqual(
		ofType(resources, 'AWS::CloudFormation::CustomResource').filter((r) => 'Parameters' in (r.Properties ?? {}))
			.length,
		0,
		'no secret-init custom resource',
	);
	const actions = iamActions(resources);
	assert.ok(actions.includes('secretsmanager:GetSecretValue'));
	assert.ok(!actions.some((a) => a === 'secretsmanager:PutSecretValue'), actions.join(', '));
	assert.deepStrictEqual(
		warnings.filter((w) => w.includes('SsmSecretsStoreOutsideSandbox')),
		[],
	);
});

test('sandbox preset: token-secret is the SSM SecureString written by the secret-init custom resource', () => {
	const { resources, warnings } = synth('sandbox');
	assert.strictEqual(ofType(resources, 'AWS::SecretsManager::Secret').length, 0);
	const bulk = ofType(resources, 'AWS::CloudFormation::CustomResource').filter(
		(r) => 'Parameters' in (r.Properties ?? {}),
	);
	assert.strictEqual(bulk.length, 1);
	assert.deepStrictEqual(bulk[0].Properties?.Parameters, [{ name: '/RtStack-rt-token-secret' }]);
	assert.deepStrictEqual(
		warnings.filter((w) => w.includes('SsmSecretsStoreOutsideSandbox')),
		[],
	);
});

/** The functions that load the Blocks config (the computes), with their environment. */
function computeEnvironments(resources: Record<string, CfnResource>): Record<string, unknown>[] {
	return ofType(resources, 'AWS::Lambda::Function')
		.map((f) => (f.Properties?.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {})
		.filter((vars) => 'BLOCKS_CONFIG_BUCKET' in vars);
}

const TOKEN_ARN_ENV = 'BLOCKS_SECRET_ARN_RTSTACK_RT_TOKEN_SECRET';

test('production preset: the token secret ARN arrives with the compute update (Lambda environment)', () => {
	const { resources } = synth('production');
	const [secretId] = Object.entries(resources).find(([, r]) => r.Type === 'AWS::SecretsManager::Secret') ?? [];
	const envs = computeEnvironments(resources);
	assert.ok(envs.length >= 1, 'at least one compute loads the config');
	for (const vars of envs) assert.deepStrictEqual(vars[TOKEN_ARN_ENV], { Ref: secretId });
});

test('sandbox preset: no secret ARN environment variable on the compute', () => {
	const { resources } = synth('sandbox');
	for (const vars of computeEnvironments(resources)) {
		assert.deepStrictEqual(
			Object.keys(vars).filter((k) => k.startsWith('BLOCKS_SECRET_ARN_')),
			[],
		);
	}
});

// Upgrade from an SSM stack: the token key leaves the secret-init custom
// resource. With other SSM secrets left, its Update handler deletes the names
// that dropped out of the list; with none left, the whole custom resource leaves
// the template and its Delete handler removes the old parameter.
test('upgrade, production preset with a customer secret AppSetting: the token key leaves the bulk list', () => {
	const { resources } = synth('production', true);
	const bulk = ofType(resources, 'AWS::CloudFormation::CustomResource').filter(
		(r) => 'Parameters' in (r.Properties ?? {}),
	);
	assert.strictEqual(bulk.length, 1);
	assert.deepStrictEqual(bulk[0].Properties?.Parameters, [{ name: '/RtStack-customer-key' }]);
});

test('upgrade, production preset with Realtime only: no secret-init custom resource at all', () => {
	const { resources } = synth('production');
	assert.deepStrictEqual(
		ofType(resources, 'AWS::CloudFormation::CustomResource').filter((r) => 'Parameters' in (r.Properties ?? {})),
		[],
	);
	assert.strictEqual(
		Object.keys(resources).some((id) => id.startsWith('BlocksSecretInitFn') || id.startsWith('BlocksSecretsBulk')),
		false,
	);
});
