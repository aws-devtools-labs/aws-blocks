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
