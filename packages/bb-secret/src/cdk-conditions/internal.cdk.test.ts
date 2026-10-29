// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK tests for `frameworkKey()` (`@aws-blocks/bb-secret/internal`).
 *
 * Run with `--conditions=cdk` (see the package `test` script) so the nested
 * `AppSetting` resolves to its CDK construct, as it does in a customer's
 * `cdk synth`. Without the condition it would resolve to the mock and emit no
 * CloudFormation.
 */
import assert from 'node:assert';
import { test } from 'node:test';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import {
	type BlocksDefaults,
	BlocksPresets,
	DEFAULT_NODE_RUNTIME,
	getRegisteredConfigValue,
	Scope,
} from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import type { Construct } from 'constructs';
import { Secret } from '../index.cdk.js';
import { frameworkKey, SSM_SECRETS_STORE_WARNING_ID } from '../internal.cdk.js';
import { secretArnConfigKey } from '../internal-shared.js';

class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly executionRole: cdk.aws_iam.IRole;
	public readonly id: string;
	public defaults: BlocksDefaults;
	constructor(scope: Construct, id: string, defaults: BlocksDefaults) {
		super(scope, id);
		this.id = id;
		this.defaults = defaults;
		(globalThis as unknown as { CURRENT_BLOCKS_STACK: unknown }).CURRENT_BLOCKS_STACK = this;
		this.executionRole = new cdk.aws_iam.Role(this, 'BlocksRole', {
			assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
		});
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
			role: this.executionRole,
		});
	}
}

function setup(
	defaults: BlocksDefaults,
	context: Record<string, string> = {},
): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App({ context });
	const stack = new StubBlocksStack(app, 'TestStack', defaults);
	const parent = new Scope('app');
	return { stack, parent };
}

const SANDBOX_CONTEXT = { sandboxMode: 'true' };

/** Every IAM statement attached to the stack's policies. */
function allStatements(template: Template): { Action: string | string[]; Resource: unknown }[] {
	const policies = template.findResources('AWS::IAM::Policy');
	return Object.values(policies).flatMap(
		(p) =>
			(p as { Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } } })
				.Properties.PolicyDocument.Statement,
	);
}

function actionsOf(statements: { Action: string | string[] }[]): string[] {
	return statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
}

// ── Secrets Manager mode (production preset) ────────────────────────────────

test('production preset: one Secrets Manager secret with a generated value, no Name, DeletionPolicy Delete', () => {
	const { stack, parent } = setup(BlocksPresets.production);
	frameworkKey(parent, 'signing-key');
	const template = Template.fromStack(stack);

	template.resourceCountIs('AWS::SecretsManager::Secret', 1);
	template.hasResource('AWS::SecretsManager::Secret', {
		DeletionPolicy: 'Delete',
		UpdateReplacePolicy: 'Delete',
		Properties: {
			GenerateSecretString: { PasswordLength: 64, ExcludePunctuation: true },
		},
	});
	const [secret] = Object.values(template.findResources('AWS::SecretsManager::Secret')) as {
		Properties: Record<string, unknown>;
	}[];
	assert.strictEqual(secret.Properties.Name, undefined, 'CloudFormation must generate the name');
	assert.strictEqual(secret.Properties.SecretString, undefined);
});

test('production preset: no SSM SecureString, no secret-init custom resource', () => {
	const { stack, parent } = setup(BlocksPresets.production);
	frameworkKey(parent, 'signing-key');
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
	template.resourceCountIs('AWS::SSM::Parameter', 0);
	assert.strictEqual(stack.node.tryFindChild('BlocksSecretInitFn'), undefined);
});

test('production preset: the app role can only read the key', () => {
	const { stack, parent } = setup(BlocksPresets.production);
	frameworkKey(parent, 'signing-key');
	const actions = actionsOf(allStatements(Template.fromStack(stack)));

	assert.ok(actions.includes('secretsmanager:GetSecretValue'), `expected GetSecretValue in ${actions.join(', ')}`);
	const readOnly = new Set([
		'secretsmanager:GetSecretValue',
		'secretsmanager:DescribeSecret',
		'secretsmanager:ListSecretVersionIds',
	]);
	const unexpected = actions.filter((a) => !readOnly.has(a));
	assert.deepStrictEqual(unexpected, [], `non-read actions granted: ${unexpected.join(', ')}`);
});

test('production preset: the secret ARN is registered under the key the runtime reads', () => {
	const { parent } = setup(BlocksPresets.production);
	frameworkKey(parent, 'signing-key');
	const key = secretArnConfigKey('TestStack-app-signing-key');
	assert.notStrictEqual(getRegisteredConfigValue(parent, key), undefined, `config key ${key} not registered`);
});

test('a customer Secret next to a framework key keeps its public defaults (fixed name, empty, RETAIN)', () => {
	const { stack, parent } = setup(BlocksPresets.production);
	frameworkKey(parent, 'signing-key');
	new Secret(parent, 'stripe-key');
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::SecretsManager::Secret', 2);
	template.hasResource('AWS::SecretsManager::Secret', {
		DeletionPolicy: 'Retain',
		Properties: Match.objectLike({ Name: 'TestStack-app-stripe-key' }),
	});
	const customer = Object.values(template.findResources('AWS::SecretsManager::Secret')).find(
		(r) => (r as { Properties: { Name?: string } }).Properties.Name === 'TestStack-app-stripe-key',
	) as { Properties: Record<string, unknown> };
	assert.strictEqual(customer.Properties.GenerateSecretString, undefined);
});

test('no warning in Secrets Manager mode', () => {
	const { stack, parent } = setup(BlocksPresets.production);
	frameworkKey(parent, 'signing-key');
	Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp(SSM_SECRETS_STORE_WARNING_ID));
});

// ── SSM mode (sandbox preset) ───────────────────────────────────────────────

test("sandbox preset: template is identical to today's AppSetting({ secret: true })", () => {
	const viaHelper = setup(BlocksPresets.sandbox, SANDBOX_CONTEXT);
	frameworkKey(viaHelper.parent, 'signing-key');
	const helperTemplate = Template.fromStack(viaHelper.stack).toJSON();

	const direct = setup(BlocksPresets.sandbox, SANDBOX_CONTEXT);
	new AppSetting(direct.parent, 'signing-key', { secret: true });
	const directTemplate = Template.fromStack(direct.stack).toJSON();

	assert.deepStrictEqual(helperTemplate, directTemplate);
	// And it really is the SSM path: the secret-init custom resource, no Secrets Manager secret.
	Template.fromStack(viaHelper.stack).resourceCountIs('AWS::SecretsManager::Secret', 0);
	Template.fromStack(viaHelper.stack).resourceCountIs('AWS::CloudFormation::CustomResource', 1);
	Template.fromStack(viaHelper.stack).hasResourceProperties('AWS::CloudFormation::CustomResource', {
		Parameters: [{ name: '/TestStack-app-signing-key' }],
	});
});

test('sandbox preset: identical config registration to AppSetting (BLOCKS_SSM_PARAM_*)', () => {
	const { parent } = setup(BlocksPresets.sandbox, SANDBOX_CONTEXT);
	frameworkKey(parent, 'signing-key');
	assert.strictEqual(getRegisteredConfigValue(parent, 'BLOCKS_SSM_PARAM_SIGNING_KEY'), '/TestStack-app-signing-key');
	assert.strictEqual(getRegisteredConfigValue(parent, secretArnConfigKey('TestStack-app-signing-key')), undefined);
});

test('sandbox preset with sandboxMode=true: no warning', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox, SANDBOX_CONTEXT);
	frameworkKey(parent, 'signing-key');
	Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp(SSM_SECRETS_STORE_WARNING_ID));
});

// ── Production-like warning ─────────────────────────────────────────────────

const warningCases: { name: string; defaults: BlocksDefaults; context: Record<string, string> }[] = [
	{ name: 'sandboxMode context missing', defaults: BlocksPresets.sandbox, context: {} },
	{ name: "sandboxMode context is 'false'", defaults: BlocksPresets.sandbox, context: { sandboxMode: 'false' } },
	{
		name: 'removalPolicy is RETAIN',
		defaults: { ...BlocksPresets.sandbox, removalPolicy: cdk.RemovalPolicy.RETAIN },
		context: SANDBOX_CONTEXT,
	},
	{
		name: 'deletionProtection is on',
		defaults: { ...BlocksPresets.sandbox, deletionProtection: true },
		context: SANDBOX_CONTEXT,
	},
	{
		name: "production preset overridden to 'ssm'",
		defaults: { ...BlocksPresets.production, secretsStore: 'ssm' },
		context: {},
	},
];

for (const c of warningCases) {
	test(`warning fires when secretsStore is 'ssm' and ${c.name}`, () => {
		const { stack, parent } = setup(c.defaults, c.context);
		frameworkKey(parent, 'signing-key');
		Annotations.fromStack(stack).hasWarning(
			'*',
			Match.stringLikeRegexp(`secretsStore is 'ssm'.*\\[ack: ${SSM_SECRETS_STORE_WARNING_ID}\\]`),
		);
	});
}

test('the warning can be acknowledged on the stack', () => {
	const { stack, parent } = setup({ ...BlocksPresets.production, secretsStore: 'ssm' });
	frameworkKey(parent, 'signing-key');
	cdk.Annotations.of(stack).acknowledgeWarning(SSM_SECRETS_STORE_WARNING_ID);
	Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp(SSM_SECRETS_STORE_WARNING_ID));
});

// ── Misc ────────────────────────────────────────────────────────────────────

test('an unknown secretsStore value fails synth', () => {
	const bad = { ...BlocksPresets.production, secretsStore: 'secretsmanager' } as unknown as BlocksDefaults;
	const { parent } = setup(bad);
	assert.throws(() => frameworkKey(parent, 'signing-key'), /Invalid defaults\.secretsStore 'secretsmanager'/);
});

test('get() throws during synth', () => {
	const { parent } = setup(BlocksPresets.production);
	const key = frameworkKey(parent, 'signing-key');
	assert.throws(() => key.get(), /frameworkKey\.get\(\) cannot be called during CDK synth/);
});
