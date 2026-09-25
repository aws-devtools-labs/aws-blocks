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
			size: { vcpu: 0.5, memory: 1024 },
			scaling: { minInstances: 1, maxInstances: 5, strategy: { on: 'cpu', targetPercent: 65 } },
		});
		assert.ok(ContainerCompute.isContainerCompute(compute));
		assert.strictEqual(compute.kind, 'container');
		assert.strictEqual(compute.vcpu, 0.5);

		// Autoscaling is wired at finalize (after the backend import) so queue-depth
		// can see owned queues; call it directly here to exercise the policy wiring.
		compute.finalize();

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
		// Application Auto Scaling was provisioned (scalable target + a CPU policy).
		template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 1);
		template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
			PolicyType: 'TargetTrackingScaling',
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

	test('honors an app-provided VPC instead of deriving its own', async () => {
		const app = new cdk.App();
		const ec2 = await import('aws-cdk-lib/aws-ec2');
		// A held stack to host the imported-VPC reference (fromVpcAttributes needs a
		// scope but produces attribute-based subnets, so there's no cross-stack CFN
		// Ref — this mirrors an app importing a shared/persistent VPC by attributes).
		const refStack = new cdk.Stack(app, 'RefStack', { env: { account: '123456789012', region: 'us-east-1' } });
		const providedVpc = ec2.Vpc.fromVpcAttributes(refStack, 'ProvidedVpc', {
			vpcId: 'vpc-0123456789abcdef0',
			availabilityZones: ['us-east-1a', 'us-east-1b'],
			privateSubnetIds: ['subnet-0aaa', 'subnet-0bbb'],
			privateSubnetRouteTableIds: ['rtb-0aaa', 'rtb-0bbb'],
			publicSubnetIds: ['subnet-0ccc', 'subnet-0ddd'],
			publicSubnetRouteTableIds: ['rtb-0ccc', 'rtb-0ddd'],
		});

		const stack = await BlocksStack.create(app, 'ContainerByoVpcStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: { ...BlocksPresets.production, vpc: { network: providedVpc } },
			defaultComputeFactory: (root: unknown) => new LambdaCompute(root as never, 'DefaultCompute'),
		} as never);

		const compute = new ContainerCompute(stack as never, 'worker', {
			size: { vcpu: 0.5, memory: 1024 },
		});
		// Note: VPC selection happens in the constructor, so we don't call
		// finalize() here — its endpoint wiring needs route-table IDs that an
		// attribute-imported test VPC doesn't carry (a real fromLookup VPC does).

		const template = Template.fromStack(stack as unknown as cdk.Stack);
		// The provided VPC is imported (not owned by this stack), so this stack must
		// NOT create its own BlocksVpc — proving the compute reused the injected one.
		template.resourceCountIs('AWS::EC2::VPC', 0);
		// The Fargate service is still provisioned (into the provided VPC).
		template.resourceCountIs('AWS::ECS::Service', 1);
	});
});
