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
import { Scope, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { AppSetting, copyFrom } from './index.cdk.js';

class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly id: string;
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
		});
	}
}

function setup(): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'TestStack');
	const parent = new Scope('app');
	return { stack, parent };
}

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

test('CDK: external secret without a name self-names (/${fullId}, stack-scoped) and emits a CfnOutput', () => {
	const { stack, parent } = setup();
	// No name → framework default /${fullId}, which is stack-scoped and so
	// cannot collide with other apps in the same account/region.
	AppSetting.fromExisting(parent, 'db-url', { secret: true });
	const template = Template.fromStack(stack);

	// The resolved name is registered for the runtime (BLOCKS_SSM_PARAM_DB_URL).
	const registry = (stack as any)[Symbol.for('BLOCKS_CONFIG_REGISTRY')] as { entries: Map<string, unknown> } | undefined;
	assert.ok(registry, 'config registry exists on the stack');
	const name = registry.entries.get('BLOCKS_SSM_PARAM_DB_URL') as string | undefined;
	// fullId = `${stackName}-${scopeChain}-db-url` → here `/TestStack-app-db-url`.
	assert.ok(
		name && name.startsWith('/') && name.includes('TestStack') && name.endsWith('db-url'),
		`self-named external secret should be /<stackName>-...-db-url, got ${name}`,
	);

	// ...and exposed as a CfnOutput so an out-of-band writer can read it post-deploy
	// and write the connection string to the exact same name.
	const outputs = template.findOutputs('BlocksSsmParamDbUrl');
	assert.equal(Object.keys(outputs).length, 1, 'external secret should emit a BlocksSsmParam CfnOutput');
	assert.equal(outputs.BlocksSsmParamDbUrl.Value, name, 'CfnOutput value must equal the resolved parameter name');
});

test('CDK: external secret still forbids a value', () => {
	const { parent } = setup();
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

// ── copyFrom: in-stack staging → final copy ─────────────────────────────────

const STAGING = '/awsBlocksStagingSecret/11111111-2222-3333-4444-555555555555';

test('CDK: copyFrom secret provisions exactly one copy custom resource + copy Lambda', () => {
	const { stack, parent } = setup();
	new AppSetting(parent, 'db-url', { secret: true, value: copyFrom(STAGING) });
	const template = Template.fromStack(stack);

	// One CustomResource — the BlocksCopyFromBulk that copies staging → final.
	template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);

	// The copy Lambda's inline code performs the get/put/delete copy.
	const lambdas = template.findResources('AWS::Lambda::Function');
	const copyFn = Object.values(lambdas).find(l => {
		const code = JSON.stringify(l?.Properties?.Code ?? {});
		return code.includes('PutParameterCommand') && code.includes('DeleteParameterCommand') && code.includes('WithDecryption');
	});
	assert.ok(copyFn, 'expected a copy Lambda that reads staging (WithDecryption) and writes/deletes');
});

test('CDK: copyFrom passes the staging NAME as a reference, never a literal value', () => {
	const { stack, parent } = setup();
	new AppSetting(parent, 'db-url', { secret: true, value: copyFrom(STAGING) });
	const template = Template.fromStack(stack);

	// The staging parameter name is present (passed to the CR as a reference so
	// the CR can read the value from SSM at deploy time)...
	const json = JSON.stringify(template.toJSON());
	assert.ok(json.includes(STAGING), 'staging parameter name should appear as a CR property reference');

	// ...and the CR carries Entries with the staging + final names, not a value.
	const crs = template.findResources('AWS::CloudFormation::CustomResource');
	const entries = Object.values(crs)[0]?.Properties?.Entries;
	assert.ok(entries, 'copy CR should carry an Entries property (the name references)');
});

test('CDK: copyFrom copy Lambda IAM is scoped to staging + final ARNs (no wildcard)', () => {
	const { stack, parent } = setup();
	new AppSetting(parent, 'db-url', { secret: true, value: copyFrom(STAGING) });
	const template = Template.fromStack(stack);

	const policies = template.findResources('AWS::IAM::Policy');
	let foundCopyPolicy = false;
	for (const logicalId of Object.keys(policies)) {
		const statements = policies[logicalId]?.Properties?.PolicyDocument?.Statement;
		if (!Array.isArray(statements)) continue;
		for (const stmt of statements) {
			const actions = stmt.Action;
			if (!Array.isArray(actions) || !actions.includes('ssm:PutParameter') || !actions.includes('ssm:GetParameter')) continue;
			foundCopyPolicy = true;
			const resources = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
			for (const res of resources) {
				const arnStr = typeof res === 'string' ? res : JSON.stringify(res);
				assert.ok(arnStr !== '*' && !arnStr.includes('"*"'), `copy policy resource must not be a wildcard, got ${arnStr}`);
			}
		}
	}
	assert.ok(foundCopyPolicy, 'expected the copy Lambda IAM policy with scoped ssm:GetParameter/PutParameter');
});

test('CDK: copyFrom grants the app handler READ-ONLY access (GetParameter + Decrypt)', () => {
	const { stack, parent } = setup();
	new AppSetting(parent, 'db-url', { secret: true, value: copyFrom(STAGING) });
	const template = Template.fromStack(stack);

	// Read-only ssm:GetParameter (rendered as a single string when it's the only action).
	template.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({ Action: 'ssm:GetParameter', Resource: Match.objectLike({ 'Fn::Join': Match.anyValue() }) }),
			]),
		},
	});
	// Decrypt for the app handler to read the SecureString.
	template.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'kms:Decrypt' })]) },
	});
});

test('CDK: copyFrom emits NO BlocksSsmParam CfnOutput (stack-owned, seeded in-stack)', () => {
	const { stack, parent } = setup();
	new AppSetting(parent, 'db-url', { secret: true, value: copyFrom(STAGING) });
	const template = Template.fromStack(stack);

	// Unlike fromExisting (external, seeded out-of-band post-deploy), copyFrom is
	// stack-owned and seeded by the in-stack copy resource — nothing reads the
	// name back after deploy, so no output is needed.
	assert.equal(Object.keys(template.findOutputs('BlocksSsmParamDbUrl')).length, 0);
});

test('CDK: a literal secret value is still rejected (only copyFrom is allowed for secrets)', () => {
	const { parent } = setup();
	assert.throws(
		() => new AppSetting(parent, 'lit-secret', { secret: true, value: 'plaintext' }),
		/should not have a literal value/,
	);
});
