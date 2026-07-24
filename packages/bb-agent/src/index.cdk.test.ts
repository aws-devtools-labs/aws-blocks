// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for the Agent construct's AgentCore Runtime provisioning.
 *
 * Verifies:
 * - Without an `agentcoreAssetPath`, synth succeeds and NO Runtime is created
 *   (existing apps keep synthesizing while the asset-build is opt-in).
 * - With an existing `agentcoreAssetPath`, synth provisions an
 *   `AWS::BedrockAgentCore::Runtime` from the code asset.
 * - Header-forwarding security invariant: the Runtime forwards the caller's
 *   `Authorization` header (so the container can derive `userId` from the
 *   gateway-validated JWT `sub`) ONLY when a JWT authorizer is configured.
 *   An IAM runtime (no authorizer) must NOT forward the header — otherwise a
 *   forgeable, un-validated token could reach the container.
 */
import assert from 'node:assert';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_NODE_RUNTIME, Scope } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { Construct } from 'constructs';
import { Agent } from './index.cdk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// `agentcoreAssetPath` just needs to be a real existing directory — the Runtime construct
// passes it to fromCodeAsset({ path }) and we only assert the Runtime resource is created,
// not its contents. Use the compiled dist/ dir (this test compiles to dist/index.cdk.test.js).
const ASSET_DIR = __dirname;

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
	const stack = new StubBlocksStack(app, 'teststack');
	const parent = new Scope('app');
	return { stack, parent };
}

test('CDK: Agent without agentcoreAssetPath synthesizes and creates NO Runtime', () => {
	const { stack, parent } = setup();
	new Agent(parent, 'chat', { systemPrompt: 'test' });
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 0);
});

test('CDK: Agent with an existing agentcoreAssetPath provisions an AgentCore Runtime', () => {
	const { stack, parent } = setup();
	new Agent(parent, 'chat', { systemPrompt: 'test', agentcoreAssetPath: ASSET_DIR });
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
});

test('CDK: an IAM Runtime (no authorizer) does NOT forward the Authorization header', () => {
	// Security invariant: with no auth configured the Runtime is IAM-gated and no
	// caller JWT exists. It must NOT set RequestHeaderConfiguration — the container
	// would otherwise trust a forgeable, un-validated `sub`.
	const { stack, parent } = setup();
	new Agent(parent, 'chat', { systemPrompt: 'test', agentcoreAssetPath: ASSET_DIR });
	const template = Template.fromStack(stack);
	const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
	const [runtime] = Object.values(runtimes);
	assert.equal(
		(runtime.Properties as any).RequestHeaderConfiguration,
		undefined,
		'IAM runtime must not forward the Authorization header',
	);
});

test('CDK: a JWT-authorizer Runtime forwards ONLY the Authorization header', () => {
	// With a JWT authorizer the gateway validates the token, so forwarding it lets
	// the container derive an unforgeable `userId` from the `sub` claim. The allowlist
	// must be exactly ['Authorization'] — nothing wider.
	const { stack, parent } = setup();
	new Agent(parent, 'chat', {
		systemPrompt: 'test',
		agentcoreAssetPath: ASSET_DIR,
		auth: { oidcDiscoveryUrl: 'https://issuer.example.com/.well-known/openid-configuration' },
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
		RequestHeaderConfiguration: { RequestHeaderAllowlist: ['Authorization'] },
	});
});

test('CDK: BB_AGENT_REQUIRE_VERIFIED_IDENTITY tracks the authorizer (fail-closed gate)', () => {
	// The container fails closed only when this env var is set. It must be present iff a JWT
	// authorizer is configured — gated on the SAME condition as RequestHeaderConfiguration so
	// the two can't drift. IAM runtime → absent (client-supplied identity is the intended path).
	const iam = setup();
	new Agent(iam.parent, 'chat', { systemPrompt: 'test', agentcoreAssetPath: ASSET_DIR });
	const iamRuntime = Object.values(
		Template.fromStack(iam.stack).findResources('AWS::BedrockAgentCore::Runtime'),
	)[0];
	assert.equal(
		(iamRuntime.Properties as any).EnvironmentVariables?.BB_AGENT_REQUIRE_VERIFIED_IDENTITY,
		undefined,
		'IAM runtime must not set the fail-closed gate',
	);

	const jwt = setup();
	new Agent(jwt.parent, 'chat', {
		systemPrompt: 'test',
		agentcoreAssetPath: ASSET_DIR,
		auth: { oidcDiscoveryUrl: 'https://issuer.example.com/.well-known/openid-configuration' },
	});
	Template.fromStack(jwt.stack).hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
		EnvironmentVariables: { BB_AGENT_REQUIRE_VERIFIED_IDENTITY: 'true' },
	});
});
