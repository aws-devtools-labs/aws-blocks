// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies `ContainerCompute` provisions a Fargate service in the framework's
 * central lazy VPC, runs AS the shared execution role, and appends the
 * `ecs-tasks` trust principal. Runs under `--conditions=cdk` for real constructs.
 *
 * A tiny co-bundled backend is written to a temp dir so the image asset builds
 * (the container skips provisioning when no backend module is discoverable).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Match } from 'aws-cdk-lib/assertions';
import { BlocksStack, BlocksPresets } from '@aws-blocks/core/cdk';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';
import { ContainerCompute } from './index.cdk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let tmpDir: string;
let handlerPath: string;
let backendPath: string;

before(() => {
	tmpDir = mkdtempSync(join(__dirname, 'tmp-container-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	// A no-op backend so the co-bundle has something to import.
	backendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('ContainerCompute — Fargate in the shared VPC', () => {
	test('provisions a Fargate service, cluster, and a shared VPC', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'ContainerStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: (root: unknown) => new LambdaCompute(root as never, 'DefaultCompute'),
		} as never);

		const compute = new ContainerCompute(stack as never, 'worker', {
			capabilities: { timeoutSeconds: 1800, longLived: true, cpu: 512, memory: 1024 },
		});
		assert.ok(ContainerCompute.isContainerCompute(compute));
		assert.strictEqual(compute.kind, 'container');

		const template = Template.fromStack(stack as unknown as cdk.Stack);
		// A VPC was lazily derived (the container requires one).
		template.resourceCountIs('AWS::EC2::VPC', 1);
		// A Fargate service + task definition + cluster.
		template.resourceCountIs('AWS::ECS::Cluster', 1);
		template.resourceCountIs('AWS::ECS::Service', 1);
		template.hasResourceProperties('AWS::ECS::TaskDefinition', {
			RequiresCompatibilities: ['FARGATE'],
			Cpu: '512',
			Memory: '1024',
		});
		// The shared role trusts ecs-tasks (appended by the container compute).
		template.hasResourceProperties('AWS::IAM::Role', {
			AssumeRolePolicyDocument: {
				Statement: Match.arrayWith([
					Match.objectLike({
						Principal: { Service: 'ecs-tasks.amazonaws.com' },
					}),
				]),
			},
		});
	});
});
