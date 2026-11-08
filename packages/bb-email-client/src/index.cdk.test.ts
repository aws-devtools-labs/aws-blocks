// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for EmailClient: the shared execution role gets only the SES
 * actions the runtime calls (SendEmail for send(), SendBulkEmail for
 * sendBatch()), scoped to this account's identities and configuration sets.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME, BlocksPresets, type BlocksDefaults } from '@aws-blocks/core/cdk';
import { EmailClient } from './index.cdk.js';

// Minimal BlocksStack-shaped parent exposing the shared `executionRole` the
// Building Block grants to (see bb-kv-store's index.cdk.test.ts).
class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly executionRole: cdk.aws_iam.IRole;
	public readonly id: string;
	public defaults: BlocksDefaults = BlocksPresets.production;
	constructor(scope: Construct, id: string) {
		super(scope, id, { env: { account: '123456789012', region: 'us-east-1' } });
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

function sesStatements(): Array<{ Action: string | string[]; Resource: unknown }> {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'TestStack');
	const originalWarn = console.warn;
	console.warn = () => {}; // the construct prints an SES domain-verification reminder
	try {
		new EmailClient(new Scope('app'), 'mail', { fromAddress: 'noreply@example.com' });
	} finally {
		console.warn = originalWarn;
	}
	return Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy'))
		.flatMap((policy: any) => policy.Properties.PolicyDocument.Statement)
		.filter((statement: any) => [statement.Action].flat().some((action: string) => action.startsWith('ses:')));
}

test('CDK: EmailClient grants exactly ses:SendEmail and ses:SendBulkEmail', () => {
	const statements = sesStatements();
	assert.strictEqual(statements.length, 1, 'one SES statement');
	assert.deepStrictEqual([statements[0].Action].flat().sort(), ['ses:SendBulkEmail', 'ses:SendEmail']);
});

test('CDK: EmailClient does not grant raw-MIME or stored-template sends', () => {
	const actions = sesStatements().flatMap((statement) => [statement.Action].flat());
	for (const unused of ['ses:SendRawEmail', 'ses:SendTemplatedEmail', 'ses:SendBulkTemplatedEmail']) {
		assert.ok(!actions.includes(unused), `${unused} must not be granted`);
	}
});

test('CDK: the SES grant stays scoped to this account', () => {
	const resources = JSON.stringify(sesStatements()[0].Resource);
	assert.ok(resources.includes(':123456789012:identity/*'), resources);
	assert.ok(resources.includes(':123456789012:configuration-set/*'), resources);
	assert.ok(!resources.includes('"*"'), 'no wildcard resource');
});
