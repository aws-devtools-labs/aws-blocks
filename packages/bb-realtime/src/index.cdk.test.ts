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

// ── publishCallbackUrl ─────────────────────────────────────────────────────────

/**
 * Minimal StubBlocksStack: provides the shared executionRole + handler (which assumes it) and roots
 * Scope via CURRENT_BLOCKS_STACK. The connections `DistributedTable` inside Realtime's shared infra
 * grants the shared `executionRole`, so the stub must expose one (mirrors the real BlocksStack).
 */
class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly executionRole: cdk.aws_iam.IRole;
	public readonly id: string;
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
		this.executionRole = new Role(this, 'BlocksRole', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
			role: this.executionRole,
		});
	}
}

/** Trivial StandardSchemaV1 that accepts anything — enough to define a namespace. */
const anySchema = { '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) } } as any;

test('CDK: publishCallbackUrl() returns the shared WebSocket stage callback URL to inject', () => {
	const app = new cdk.App();
	new StubBlocksStack(app, 'teststack'); // sets CURRENT_BLOCKS_STACK + provides the shared handler
	const parent = new Scope('app'); // roots to CURRENT_BLOCKS_STACK

	const rt = new Realtime(parent, 'rt', { namespaces: { chunks: Realtime.namespace(anySchema) } });

	// The one thing a co-located compute (e.g. the Agent BB's AgentCore Runtime) needs to publish —
	// it runs AS the shared execution role, which already holds the publish grants, so no IAM grant
	// is exposed; only this endpoint, which it injects as BLOCKS_RT_CALLBACK_URL.
	const url = rt.publishCallbackUrl();
	assert.strictEqual(typeof url, 'string', 'returns the API Gateway WebSocket callback URL as a string');
	assert.ok(url.length > 0, 'callback URL is non-empty');
});
