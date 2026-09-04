// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for the Agent BB.
 *
 * Pin that the Agent provisions an AgentCore Runtime for the streaming loop that runs AS the shared
 * Blocks execution role (the same principal as the handler) — not a bespoke per-runtime role. That
 * shared role already carries everything the loop touches (Realtime publish via the handler wiring,
 * Bedrock, the conversation/message tables, the session bucket); the Agent adds only the
 * AgentCore-specific bits — the scoped `bedrock-agentcore` assume-role trust, Bedrock model access,
 * and the shared handler's permission to INVOKE the runtime — and injects the config location so the
 * container loads the same app config as the handler.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BlocksStack, BlocksPresets } from '@aws-blocks/core/cdk';
import type { DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { Agent } from './index.cdk.js';

/**
 * Inject LambdaCompute as the stack's default compute, the same way
 * `@aws-blocks/blocks` does for real apps. `main` (PR #459) made the Agent
 * resolve the stack's `defaultCompute` at construction (the Realtime/AgentCore
 * wiring reads it), so a bare handler-only stub stack (no default compute) can
 * no longer synthesize it — `BlocksStack.create` initializes the default
 * compute the getter resolves to. (`root as never` is core's existing plumbing
 * pattern for the factory signature.)
 */
const lambdaFactory: DefaultComputeFactory = (root) => new LambdaCompute(root as never, 'DefaultCompute');

/** A real directory to hand fromCodeAsset (any existing dir works for a synth-only test). */
const ASSET_DIR = dirname(fileURLToPath(import.meta.url));

let tmpDir: string;
let handlerPath: string;
let backendPath: string;

before(() => {
	// Building Blocks resolve to their mock entry points unless `--conditions=cdk`
	// is active; keep it set so `BlocksStack.create` produces real CloudFormation.
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
	// `BlocksStack.create` needs a real backend handler + backend module on disk
	// (it imports the backend module and points the handler compute at the file).
	tmpDir = mkdtempSync(join(ASSET_DIR, 'tmp-agent-cdk-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	backendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

async function synth(): Promise<Template> {
	const app = new cdk.App();
	// Real BlocksStack (with the shared executionRole/BlocksRole + a LambdaCompute default compute)
	// so the Agent can resolve its default compute. `id` === 'teststack' so BLOCKS_STACK_NAME (derived
	// from the owning root id) resolves to 'teststack', which the injection assertion below matches.
	const stack = await BlocksStack.create(app, 'teststack', {
		backendHandlerPath: handlerPath,
		backendCDKPath: backendPath,
		defaults: BlocksPresets.production,
		defaultComputeFactory: lambdaFactory,
	});
	// agentcoreAssetPath bypasses the synth-time co-bundle (which needs a BlocksStack backend path).
	new Agent(stack, 'agent', { systemPrompt: 'You are a test agent.', agentcoreAssetPath: ASSET_DIR });
	return Template.fromStack(stack);
}

test('CDK: Agent provisions an AgentCore Runtime for the loop', async () => {
	const template = await synth();
	assert.ok(
		Object.keys(template.findResources('AWS::BedrockAgentCore::Runtime')).length >= 1,
		'expected an AWS::BedrockAgentCore::Runtime resource',
	);
});

test('CDK: the loop runs as the shared execution role, which carries everything it touches', async () => {
	const template = await synth();
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
	// BLOCKS_STACK_NAME must be the owning root id (`backendStackName`) — the SAME value the handler
	// uses to derive resource names — so the container's namespace matches what CDK provisioned. Here
	// the owning BlocksStack's id is 'teststack', so backendStackName resolves to 'teststack'.
	assert.ok(runtimeJson.includes('BLOCKS_STACK_NAME'), 'runtime must be injected BLOCKS_STACK_NAME');
	assert.ok(runtimeJson.includes('teststack'), 'BLOCKS_STACK_NAME resolves to the owning root id');
});

test('CDK: the Agent adds the bedrock-agentcore assume-role trust to the shared role (scoped)', async () => {
	// Core is BB-agnostic — it does not trust bedrock-agentcore. The Agent adds that trust here, so
	// the AgentCore Runtime can assume the shared role it runs AS. It must be scoped by
	// aws:SourceAccount (AWS's recommended AgentCore trust policy), and lambda trust must remain.
	const template = await synth();
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

test('CDK: multiple agents add the identical shared-role grants ONCE, not per-agent', async () => {
	// Every agent would otherwise add the SAME bedrock-agentcore trust / Bedrock / InvokeAgentRuntime
	// statements to the one shared role. They're identical (stack-scoped), so they must be added
	// exactly once regardless of agent count — keeping the shared role's policy from bloating with
	// duplicates. (Overflow into managed policies is a normal CDK mechanism and not asserted against.)
	const app = new cdk.App();
	const stack = await BlocksStack.create(app, 'teststack', {
		backendHandlerPath: handlerPath,
		backendCDKPath: backendPath,
		defaults: BlocksPresets.production,
		defaultComputeFactory: lambdaFactory,
	});
	for (const id of ['agent1', 'agent2', 'agent3']) {
		new Agent(stack, id, { systemPrompt: 'You are a test agent.', agentcoreAssetPath: ASSET_DIR });
	}
	const template = Template.fromStack(stack);
	const json = JSON.stringify(template.toJSON());

	// Three runtimes (per-agent), but the shared-role grant statements appear once (deduped).
	assert.strictEqual(Object.keys(template.findResources('AWS::BedrockAgentCore::Runtime')).length, 3, 'three runtimes');
	const invokeGrants = json.split('bedrock-agentcore:InvokeAgentRuntime').length - 1;
	assert.strictEqual(invokeGrants, 1, `InvokeAgentRuntime should be granted once, found ${invokeGrants}`);
});
