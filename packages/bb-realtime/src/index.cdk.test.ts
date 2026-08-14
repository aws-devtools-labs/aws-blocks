// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for Realtime synth guards.
 *
 * Validates that calling runtime data methods (publish/subscribe/getChannel)
 * on the CDK construct throws an actionable error instead of a cryptic
 * `X is not a function` TypeError.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template } from 'aws-cdk-lib/assertions';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Scope, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { Realtime } from './index.cdk.js';

test('CDK: calling a runtime method throws an actionable error (not a cryptic TypeError)', () => {
	// Unlike KVStore/DistributedTable tests which instantiate the construct directly,
	// Realtime's constructor requires complex shared infrastructure (WebSocket API,
	// DynamoDB connections table, AppSetting) that is impractical to stand up in a
	// unit test. We access the prototype directly instead — the synth-guard stubs
	// are plain methods and don't depend on instance state.
	for (const method of ['publish', 'subscribe', 'getChannel']) {
		assert.throws(
			() => (Realtime.prototype as any)[method]('arg'),
			/cannot be called during CDK synth/,
			`${method}() should throw the actionable synth-time error`,
		);
	}
});

// ── grantPublish ─────────────────────────────────────────────────────────────

/** Minimal StubBlocksStack: provides the shared handler + roots Scope via CURRENT_BLOCKS_STACK. */
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

/** Trivial StandardSchemaV1 that accepts anything — enough to define a namespace. */
const anySchema = { '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) } } as any;

test('CDK: grantPublish grants postToConnection + connections-table query and returns publish config', () => {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'teststack');
	const parent = new Scope('app'); // roots to CURRENT_BLOCKS_STACK

	const rt = new Realtime(parent, 'rt', { namespaces: { chunks: Realtime.namespace(anySchema) } });
	const grantee = new Role(stack, 'GranteeRole', { assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com') });

	const cfg = rt.grantPublish(grantee);

	// Returns the config an external publisher must inject into its env.
	assert.ok(cfg.callbackUrl !== undefined, 'returns a callback URL to inject as BLOCKS_RT_CALLBACK_URL');

	// The grantee's IAM policy carries both halves of the publish path.
	const json = JSON.stringify(Template.fromStack(stack).toJSON());
	assert.ok(json.includes('execute-api:ManageConnections'), 'grants API Gateway ManageConnections (postToConnection)');
	assert.ok(json.includes('dynamodb:Query'), 'grants DynamoDB Query for connections-table subscriber lookup');
	// publish() prunes stale (410) connections via deleteBatch → BatchWrite, so the grant must
	// include the write action too (parity with the shared handler's read/write on the table).
	assert.ok(json.includes('dynamodb:BatchWriteItem'), 'grants DynamoDB write for stale-connection cleanup');
});
