// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for the Agent BB.
 *
 * Pins that the Agent provisions an AgentCore Runtime for the streaming loop and that its
 * dedicated execution role — a SEPARATE principal from the shared Blocks handler — is granted
 * everything the loop touches: Realtime publish (postToConnection + connections-table query),
 * Bedrock, the conversation/message tables, and the session bucket. Also pins that the shared
 * handler is granted permission to INVOKE the runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template } from 'aws-cdk-lib/assertions';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Scope, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { Agent } from './index.cdk.js';

/**
 * Minimal StubBlocksStack: provides the shared executionRole + handler (which assumes it) and
 * roots Scope via CURRENT_BLOCKS_STACK — mirrors how the AgentCore runtime resolves the shared role.
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

/** A real directory to hand fromCodeAsset (any existing dir works for a synth-only test). */
const ASSET_DIR = dirname(fileURLToPath(import.meta.url));

function synth(): Template {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'teststack');
	const parent = new Scope('app'); // roots to CURRENT_BLOCKS_STACK
	// agentcoreAssetPath bypasses the synth-time co-bundle (which needs a BlocksStack backend path).
	new Agent(parent, 'agent', { systemPrompt: 'You are a test agent.', agentcoreAssetPath: ASSET_DIR });
	return Template.fromStack(stack);
}

test('CDK: Agent provisions an AgentCore Runtime for the loop', () => {
	const template = synth();
	assert.ok(
		Object.keys(template.findResources('AWS::BedrockAgentCore::Runtime')).length >= 1,
		'expected an AWS::BedrockAgentCore::Runtime resource',
	);
});

test('CDK: the loop runs as the shared execution role, which carries everything it touches', () => {
	const template = synth();
	const json = JSON.stringify(template.toJSON());
	// Realtime publish (both halves) — load-bearing for streaming from the container. Granted to the
	// shared role by the Realtime BB's handler wiring (not by the Agent), and inherited because the
	// loop runs AS that role.
	assert.ok(json.includes('execute-api:ManageConnections'), 'Realtime postToConnection');
	assert.ok(json.includes('dynamodb:Query'), 'connections-table + history query');
	// Model + storage the loop uses (Bedrock granted here; S3/DynamoDB via the child BBs).
	assert.ok(json.includes('bedrock:InvokeModel'), 'Bedrock invoke');
	assert.ok(json.includes('s3:GetObject'), 'session-bucket access (via FileBucket)');
	// The RPC handler (also the shared role) can start the loop.
	assert.ok(json.includes('bedrock-agentcore:InvokeAgentRuntime'), 'InvokeAgentRuntime');
	// The runtime runs AS the shared BlocksRole — not a bespoke per-runtime role. Its RoleArn
	// should reference BlocksRole, and there should be no `RuntimeRole` construct anywhere.
	const runtime = Object.values(template.findResources('AWS::BedrockAgentCore::Runtime'))[0] as { Properties?: Record<string, unknown> };
	assert.ok(JSON.stringify(runtime.Properties ?? {}).includes('BlocksRole'), 'runtime executionRole should be the shared BlocksRole');
	assert.ok(!json.includes('RuntimeRole'), 'no bespoke per-runtime role should be created');
	// The container is given the config location so loadConfigToProcessEnv() loads the same full app
	// config as the handler (delivers BLOCKS_RT_CALLBACK_URL + any config-backed BB values a tool needs).
	const runtimeJson = JSON.stringify(runtime.Properties ?? {});
	assert.ok(runtimeJson.includes('BLOCKS_CONFIG_BUCKET'), 'runtime must be injected BLOCKS_CONFIG_BUCKET');
	assert.ok(runtimeJson.includes('BLOCKS_CONFIG_KEY'), 'runtime must be injected BLOCKS_CONFIG_KEY');
});

test('CDK: the Agent adds the bedrock-agentcore assume-role trust to the shared role (scoped)', () => {
	// Core is BB-agnostic — it does not trust bedrock-agentcore. The Agent adds that trust here, so
	// the AgentCore Runtime can assume the shared role it runs AS. It must be scoped by
	// aws:SourceAccount (AWS's recommended AgentCore trust policy), and lambda trust must remain.
	const template = synth();
	const roles = template.findResources('AWS::IAM::Role');
	const blocksRoleId = Object.keys(roles).find(k => k.includes('BlocksRole'));
	assert.ok(blocksRoleId, 'expected the shared BlocksRole');

	const statements = roles[blocksRoleId].Properties.AssumeRolePolicyDocument.Statement as Array<{
		Principal?: { Service?: string | string[] };
		Condition?: Record<string, Record<string, unknown>>;
	}>;
	const servicesOf = (s: (typeof statements)[number]) => {
		const svc = s.Principal?.Service;
		return Array.isArray(svc) ? svc : svc ? [svc] : [];
	};
	const services = statements.flatMap(servicesOf);
	assert.ok(services.includes('lambda.amazonaws.com'), 'shared role must stay Lambda-assumable');
	assert.ok(services.includes('bedrock-agentcore.amazonaws.com'), 'shared role must be assumable by the AgentCore Runtime');

	const agentCoreStmt = statements.find(s => servicesOf(s).includes('bedrock-agentcore.amazonaws.com'));
	assert.ok(agentCoreStmt?.Condition, 'AgentCore trust statement must carry a scoping Condition');
	assert.ok(
		JSON.stringify(agentCoreStmt.Condition).includes('aws:SourceAccount'),
		'AgentCore trust must be scoped by aws:SourceAccount',
	);
});

test('CDK: multiple agents add the identical shared-role grants ONCE, not per-agent', () => {
	// Every agent would otherwise add the SAME bedrock-agentcore trust / Bedrock / InvokeAgentRuntime
	// statements to the one shared role. They're identical (stack-scoped), so they must be added
	// exactly once regardless of agent count — keeping the shared role's policy from bloating with
	// duplicates. (Overflow into managed policies is a normal CDK mechanism and not asserted against.)
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'teststack');
	const parent = new Scope('app');
	for (const id of ['agent1', 'agent2', 'agent3']) {
		new Agent(parent, id, { systemPrompt: 'You are a test agent.', agentcoreAssetPath: ASSET_DIR });
	}
	const template = Template.fromStack(stack);
	const json = JSON.stringify(template.toJSON());

	// Three runtimes (per-agent), but the shared-role grant statements appear once (deduped).
	assert.strictEqual(Object.keys(template.findResources('AWS::BedrockAgentCore::Runtime')).length, 3, 'three runtimes');
	const invokeGrants = json.split('bedrock-agentcore:InvokeAgentRuntime').length - 1;
	assert.strictEqual(invokeGrants, 1, `InvokeAgentRuntime should be granted once, found ${invokeGrants}`);
});
