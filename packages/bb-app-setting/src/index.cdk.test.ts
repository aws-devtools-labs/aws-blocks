// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for AppSetting.
 *
 * Verifies that the Custom Resource Lambda's IAM policy is scoped to specific
 * parameter ARNs (not a wildcard) — regression test for #598.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME, BlocksPresets, type BlocksDefaults } from '@aws-blocks/core/cdk';
import { AppSetting } from './index.cdk.js';

class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly executionRole: cdk.aws_iam.IRole;
	public readonly id: string;
	public defaults: BlocksDefaults = BlocksPresets.production;
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
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

function setup(defaults: BlocksDefaults = BlocksPresets.production, stackId = 'TestStack'): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, stackId);
	stack.defaults = defaults;
	const parent = new Scope('app');
	return { stack, parent };
}

test('CDK: the secret-init Lambda log group adopts defaults.logRetention', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox, 'SecretRetentionStack');
	new AppSetting(parent, 'my-secret', { secret: true, name: '/myapp/secret-key' });
	const template = Template.fromStack(stack);
	// The secret-init Lambda now owns an explicit log group whose retention
	// follows the stack-wide default (sandbox → one week) instead of infinite.
	template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
});

test('CDK: secret AppSetting SSM policy is scoped to specific parameter ARN (not wildcard)', () => {
	const { stack, parent } = setup();
	new AppSetting(parent, 'my-secret', { secret: true, name: '/myapp/secret-key' });
	const template = Template.fromStack(stack);

	// The BlocksSecretInitFn should have an IAM policy for ssm:PutParameter/DeleteParameter
	// scoped to the specific parameter, NOT a wildcard
	const policies = template.findResources('AWS::IAM::Policy');
	const policyLogicalIds = Object.keys(policies);

	let foundSsmPolicy = false;
	for (const logicalId of policyLogicalIds) {
		const statements = policies[logicalId]?.Properties?.PolicyDocument?.Statement;
		if (!Array.isArray(statements)) continue;

		for (const stmt of statements) {
			const actions = stmt.Action;
			if (!Array.isArray(actions)) continue;
			if (!actions.includes('ssm:PutParameter') || !actions.includes('ssm:DeleteParameter')) continue;

			foundSsmPolicy = true;
			// Resource must NOT be a wildcard — it should be a specific ARN
			const resources = stmt.Resource;
			if (Array.isArray(resources)) {
				for (const res of resources) {
					const arnStr = typeof res === 'string' ? res : JSON.stringify(res);
					assert.ok(
						!arnStr.includes('"*"') && arnStr !== '*',
						`SSM policy resource must not be a wildcard, got: ${arnStr}`
					);
				}
			} else {
				const arnStr = typeof resources === 'string' ? resources : JSON.stringify(resources);
				assert.notStrictEqual(arnStr, '*', 'SSM policy resource must not be a wildcard');
			}
		}
	}

	assert.ok(foundSsmPolicy, 'Expected to find an IAM policy with ssm:PutParameter/DeleteParameter');
});

test('CDK: secret AppSetting SSM policy contains the correct parameter name', () => {
	const { stack, parent } = setup();
	new AppSetting(parent, 'db-password', { secret: true, name: '/myapp/db-password' });
	const template = Template.fromStack(stack);

	// Verify the policy resource ARN references the parameter name
	const templateJson = JSON.stringify(template.toJSON());
	assert.ok(
		templateJson.includes('myapp/db-password'),
		'Expected the synthesized template to contain the specific parameter name "myapp/db-password"'
	);
});

test('CDK: multiple secret AppSettings produce scoped policy with all parameter ARNs', () => {
	const { stack, parent } = setup();
	new AppSetting(parent, 'secret-a', { secret: true, name: '/app/secret-a' });
	new AppSetting(parent, 'secret-b', { secret: true, name: '/app/secret-b' });
	const template = Template.fromStack(stack);

	const templateJson = JSON.stringify(template.toJSON());
	assert.ok(templateJson.includes('app/secret-a'), 'Expected template to reference parameter "app/secret-a"');
	assert.ok(templateJson.includes('app/secret-b'), 'Expected template to reference parameter "app/secret-b"');
});

test('CDK: non-secret AppSetting creates SSM StringParameter', () => {
	const { stack, parent } = setup();
	new AppSetting(parent, 'config', { value: 'hello', name: '/app/config' });
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::SSM::Parameter', 1);
});

test('CDK: non-secret AppSetting grants handler scoped SSM access', () => {
	const { stack, parent } = setup();
	new AppSetting(parent, 'config', { value: 'hello', name: '/app/config' });
	const template = Template.fromStack(stack);

	// Should have a policy statement for ssm:GetParameter, ssm:PutParameter
	// scoped to the specific parameter ARN
	template.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({
					Action: ['ssm:GetParameter', 'ssm:PutParameter'],
					Resource: Match.objectLike({
						'Fn::Join': Match.anyValue(),
					}),
				}),
			]),
		},
	});
});

test('CDK: external secret is NOT enrolled in bulk-init (no BlocksSecretsBulk / BlocksSecretInitFn)', () => {
	const { stack, parent } = setup();
	AppSetting.fromExisting(parent, 'db-url', { name: '/blocks/sandbox/db-abc-connection-string', secret: true });
	const template = Template.fromStack(stack);

	// No secret bulk-init custom resource and no init Lambda should be synthesized:
	// an externally-owned parameter must not be created, tagged, or deleted by us.
	template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
	const lambdas = template.findResources('AWS::Lambda::Function');
	for (const id of Object.keys(lambdas)) {
		const code = JSON.stringify(lambdas[id]?.Properties?.Code ?? {});
		assert.ok(!code.includes('AddTagsToResourceCommand'), `Lambda ${id} should not be the secret-init function`);
	}
});

test('CDK: external secret grants READ-ONLY runtime access (GetParameter + Decrypt, scoped, no write)', () => {
	const { stack, parent } = setup();
	AppSetting.fromExisting(parent, 'db-url', { name: '/blocks/sandbox/db-abc-connection-string', secret: true });
	const template = Template.fromStack(stack);

	// ssm:GetParameter, scoped to the specific parameter ARN (not a wildcard).
	template.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({
					Action: 'ssm:GetParameter',
					Resource: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
				}),
			]),
		},
	});
	// kms:Decrypt for reading the SecureString.
	template.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'kms:Decrypt' })]) },
	});
	// Must NOT grant write to an externally-owned secret.
	const policiesJson = JSON.stringify(template.findResources('AWS::IAM::Policy'));
	assert.ok(!policiesJson.includes('ssm:PutParameter'), 'external secret must not grant ssm:PutParameter');
	assert.ok(!policiesJson.includes('kms:Encrypt'), 'external secret must not grant kms:Encrypt');
});

test('CDK: external non-secret creates no SSM parameter and grants read-only access', () => {
	const { stack, parent } = setup();
	AppSetting.fromExisting(parent, 'shared-config', { name: '/some/external/config' });
	const template = Template.fromStack(stack);

	// The construct does not create the parameter — it's owned externally.
	template.resourceCountIs('AWS::SSM::Parameter', 0);
	template.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({
					Action: 'ssm:GetParameter',
					Resource: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
				}),
			]),
		},
	});
	assert.ok(
		!JSON.stringify(template.findResources('AWS::IAM::Policy')).includes('ssm:PutParameter'),
		'external non-secret must not grant write',
	);
});

test('CDK: the internal external guard requires a name and forbids a value', () => {
	// fromExisting() is the public API and makes `name` required at the type level;
	// these assertions cover the runtime guard on the underlying `external` option
	// (defense for JS callers / direct construction).
	const { parent } = setup();
	assert.throws(
		() => new AppSetting(parent, 'ext-no-name', { secret: true, external: true } as any),
		/requires an explicit 'name'/,
	);
	assert.throws(
		() => new AppSetting(parent, 'ext-with-value', { external: true, name: '/x', value: 'v' } as any),
		/must not have a value/,
	);
});

test('CDK: fromExisting still registers the runtime config key (BLOCKS_SSM_PARAM_*)', () => {
	// BLOCKS_SSM_PARAM_DB_URL is the ONLY link between db-pull's runtime resolveConnString()
	// and the deployed parameter name. If config registration ever moved inside the
	// non-external branch, every external setting would fail at runtime with
	// ParameterNotFound — and nothing else would catch it. This pins the contract.
	const { stack, parent } = setup();
	AppSetting.fromExisting(parent, 'db-url', { name: '/blocks/sandbox/db-abc-connection-string', secret: true });

	const registry = (stack as any)[Symbol.for('BLOCKS_CONFIG_REGISTRY')] as { entries: Map<string, unknown> } | undefined;
	assert.ok(registry, 'config registry exists on the stack');
	assert.ok(
		registry.entries.has('BLOCKS_SSM_PARAM_DB_URL'),
		'external setting must register BLOCKS_SSM_PARAM_DB_URL so the runtime can resolve the parameter',
	);
	assert.equal(registry.entries.get('BLOCKS_SSM_PARAM_DB_URL'), '/blocks/sandbox/db-abc-connection-string');
});

const TEST_CMK = 'arn:aws:kms:us-east-1:111122223333:key/abcd1234-5678-90ab-cdef-1234567890ab';

test('CDK: secret with kmsKeyArn grants handler KMS on the specific CMK ARN (not a ViaService wildcard)', () => {
	const { stack, parent } = setup();
	new AppSetting(parent, 'cmk-secret', { secret: true, name: '/app/cmk-secret', kmsKeyArn: TEST_CMK });
	const template = Template.fromStack(stack);
	const policies = template.findResources('AWS::IAM::Policy');

	let found = false;
	for (const logicalId of Object.keys(policies)) {
		const statements = policies[logicalId]?.Properties?.PolicyDocument?.Statement;
		if (!Array.isArray(statements)) continue;
		for (const stmt of statements) {
			const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
			if (!actions.includes('kms:Decrypt')) continue;
			// The CMK grant scopes to the exact key ARN and carries no ViaService condition.
			const resStr = JSON.stringify(stmt.Resource);
			if (resStr.includes(TEST_CMK)) {
				found = true;
				assert.ok(actions.includes('kms:Encrypt'), 'stack-managed CMK secret should grant kms:Encrypt');
				// Standard-tier SecureStrings only use Encrypt/Decrypt — no GenerateDataKey.
				assert.ok(
					!actions.some((a: string) => a.startsWith('kms:GenerateDataKey')),
					'CMK grant should not include kms:GenerateDataKey* (advanced-tier only)',
				);
				assert.strictEqual(stmt.Condition, undefined, 'CMK grant should not use a ViaService wildcard condition');
			}
		}
	}
	assert.ok(found, `Expected a handler KMS grant scoped to the CMK ARN ${TEST_CMK}`);
});

test('CDK: secret with kmsKeyArn passes the KeyId to the bulk secret custom resource', () => {
	const { stack, parent } = setup();
	new AppSetting(parent, 'cmk-secret', { secret: true, name: '/app/cmk-secret', kmsKeyArn: TEST_CMK });
	const template = Template.fromStack(stack);

	const crs = template.findResources('AWS::CloudFormation::CustomResource');
	const bulk = Object.values(crs).find((r) => Array.isArray(r?.Properties?.Parameters));
	assert.ok(bulk, 'Expected a bulk-secrets custom resource with a Parameters list');
	const params = bulk.Properties.Parameters as Array<{ name: string; keyId?: string }>;
	const entry = params.find((p) => p.name === '/app/cmk-secret');
	assert.ok(entry, 'the secret should appear in the bulk Parameters');
	assert.strictEqual(entry?.keyId, TEST_CMK, 'the CMK ARN must be passed through as keyId');
});

test('CDK: a default-key secret carries no keyId in the bulk Parameters', () => {
	const { stack, parent } = setup();
	new AppSetting(parent, 'plain-secret', { secret: true, name: '/app/plain-secret' });
	const template = Template.fromStack(stack);
	const crs = template.findResources('AWS::CloudFormation::CustomResource');
	const bulk = Object.values(crs).find((r) => Array.isArray(r?.Properties?.Parameters));
	const params = bulk?.Properties?.Parameters as Array<{ name: string; keyId?: string }>;
	const entry = params.find((p) => p.name === '/app/plain-secret');
	assert.ok(entry, 'the secret should appear in the bulk Parameters');
	assert.strictEqual(entry?.keyId, undefined, 'a default-key secret must not set keyId');
});

test('CDK: kmsKeyArn without secret throws ValidationFailed', () => {
	const { parent } = setup();
	assert.throws(
		() => new AppSetting(parent, 'bad', { value: 'x', name: '/app/bad', kmsKeyArn: TEST_CMK }),
		/only valid with 'secret: true'/,
	);
});

test('CDK: fromExisting with kmsKeyArn grants read-only KMS scoped to the CMK ARN (Decrypt, no Encrypt)', () => {
	const { stack, parent } = setup();
	AppSetting.fromExisting(parent, 'ext-cmk', { name: '/ext/cmk-secret', secret: true, kmsKeyArn: TEST_CMK });
	const template = Template.fromStack(stack);
	const policies = template.findResources('AWS::IAM::Policy');

	let found = false;
	for (const logicalId of Object.keys(policies)) {
		const statements = policies[logicalId]?.Properties?.PolicyDocument?.Statement;
		if (!Array.isArray(statements)) continue;
		for (const stmt of statements) {
			const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
			if (JSON.stringify(stmt.Resource).includes(TEST_CMK) && actions.includes('kms:Decrypt')) {
				found = true;
				assert.ok(!actions.includes('kms:Encrypt'), 'external (read-only) CMK secret must not grant kms:Encrypt');
			}
		}
	}
	assert.ok(found, 'external CMK secret should grant kms:Decrypt scoped to the CMK ARN');
});

test('CDK: bulk-init role can read + re-key secrets (ssm:GetParameter + kms:Encrypt/Decrypt), no GenerateDataKey', () => {
	// The re-encrypt-on-key-change path reads the current value (GetParameter +
	// Decrypt) and rewrites it under the new key (Encrypt). The bulk-init statement
	// is uniquely identified by ssm:AddTagsToResource.
	const { stack, parent } = setup();
	new AppSetting(parent, 'cmk-secret', { secret: true, name: '/app/cmk-secret', kmsKeyArn: TEST_CMK });
	const template = Template.fromStack(stack);
	const policies = template.findResources('AWS::IAM::Policy');

	let bulkSsm: string[] | undefined;
	let bulkKms: string[] | undefined;
	for (const logicalId of Object.keys(policies)) {
		const statements = policies[logicalId]?.Properties?.PolicyDocument?.Statement;
		if (!Array.isArray(statements)) continue;
		for (const stmt of statements) {
			const actions: string[] = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
			if (actions.includes('ssm:AddTagsToResource')) bulkSsm = actions;
			if (actions.includes('kms:Encrypt') && stmt.Condition?.StringEquals?.['kms:ViaService']) bulkKms = actions;
		}
	}
	assert.ok(bulkSsm, 'expected the bulk-init ssm statement (identified by AddTagsToResource)');
	assert.ok(bulkSsm?.includes('ssm:GetParameter'), 'bulk-init needs ssm:GetParameter to read a value when re-keying');
	assert.ok(bulkKms, 'expected the bulk-init KMS statement (ViaService-scoped)');
	assert.ok(bulkKms?.includes('kms:Decrypt'), 'bulk-init needs kms:Decrypt to read the current value when re-keying');
	assert.ok(
		!bulkKms?.some((a) => a.startsWith('kms:GenerateDataKey')),
		'no GenerateDataKey* — standard-tier SecureStrings do not use it',
	);
});
