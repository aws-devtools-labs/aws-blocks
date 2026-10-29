// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/**
 * Verifies `ContainerCompute` provisions a Fargate service in the framework's
 * central lazy VPC, runs AS the shared execution role, and appends the
 * `ecs-tasks` trust principal. Runs under `--conditions=cdk` for real constructs.
 *
 * A tiny co-bundled backend is written to a temp dir so the image asset builds
 * (the container skips provisioning when no backend module is discoverable).
 */
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';
import { BlocksPresets, BlocksStack } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
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
		assert.strictEqual(compute.type, 'container');
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

describe('ContainerCompute — review-finding fixes', () => {
	test('the Fargate service depends on the config deployment (boots after config exists)', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'ContainerConfigDepStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: (root: unknown) => new LambdaCompute(root as never, 'DefaultCompute'),
		} as never);

		const compute = new ContainerCompute(stack as never, 'worker', {
			size: { vcpu: 0.5, memory: 1024 },
		});
		// Register at least one config entry so finalizeConfigRegistry creates the
		// BucketDeployment the service must order itself after.
		const { registerConfig } = await import('@aws-blocks/core/cdk');
		registerConfig(compute as never, 'BLOCKS_SMOKE_FLAG', 'on');

		// finalizeConfigRegistry runs before compute.finalize() in create(); mirror
		// that ordering here so the deployment exists when finalize wires the dep.
		const { finalizeConfigRegistry } = await import('@aws-blocks/core/cdk');
		finalizeConfigRegistry(stack as never, (stack as never as { executionRole: unknown }).executionRole as never, [
			compute as never,
		]);
		compute.finalize();

		const template = Template.fromStack(stack as unknown as cdk.Stack);
		// Find the config BucketDeployment custom resource and the service, and
		// assert the service's DependsOn includes that deployment's logical id.
		const deployments = template.findResources('Custom::CDKBucketDeployment');
		const deploymentIds = Object.keys(deployments);
		assert.ok(deploymentIds.length >= 1, 'expected a config BucketDeployment');
		const services = template.findResources('AWS::ECS::Service');
		const service = Object.values(services)[0] as { DependsOn?: string[] };
		assert.ok(service.DependsOn, 'service should declare DependsOn');
		assert.ok(
			deploymentIds.some((id) => service.DependsOn!.includes(id)),
			`service DependsOn ${JSON.stringify(service.DependsOn)} should include a config deployment (${JSON.stringify(deploymentIds)})`,
		);
	});

	test('queue-depth autoscaling counts in-flight (NotVisible) messages, not just Visible', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'ContainerQueueDepthStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: (root: unknown) => new LambdaCompute(root as never, 'DefaultCompute'),
		} as never);

		const compute = new ContainerCompute(stack as never, 'worker', {
			size: { vcpu: 0.5, memory: 1024 },
			scaling: { minInstances: 1, maxInstances: 5, strategy: { on: 'queue-depth', backlogPerInstance: 100 } },
		});
		// Give the compute a queue to drain so the queue-depth policy is wired.
		const sqs = await import('aws-cdk-lib/aws-sqs');
		const q = new sqs.Queue(stack as unknown as cdk.Stack, 'OwnedQueue');
		compute.registerOwnedQueue(q);
		compute.finalize();

		const template = Template.fromStack(stack as unknown as cdk.Stack);
		// Step scaling renders a StepScaling policy plus CloudWatch alarms whose
		// metric math carries the SQS metrics. The backlog math must reference BOTH
		// the Visible and NotVisible metrics — otherwise a drained-but-processing
		// queue reads 0 and a task is scaled in from under an in-flight job.
		template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
			PolicyType: 'StepScaling',
		});
		const alarms = template.findResources('AWS::CloudWatch::Alarm');
		const serialized = JSON.stringify(Object.values(alarms).map((a) => (a as { Properties?: unknown }).Properties));
		assert.ok(
			serialized.includes('ApproximateNumberOfMessagesVisible'),
			'queue-depth alarm metric math should include ApproximateNumberOfMessagesVisible',
		);
		assert.ok(
			serialized.includes('ApproximateNumberOfMessagesNotVisible'),
			'queue-depth alarm metric math should include ApproximateNumberOfMessagesNotVisible (in-flight)',
		);
	});
});

describe('ContainerCompute — no local Docker (image + S3 code asset)', () => {
	test('runs a stock Node image via fromRegistry and ships code as an S3 asset — no image build', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'ContainerNoDockerStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: (root: unknown) => new LambdaCompute(root as never, 'DefaultCompute'),
		} as never);

		new ContainerCompute(stack as never, 'worker', { size: { vcpu: 0.5, memory: 1024 } });

		const template = Template.fromStack(stack as unknown as cdk.Stack);

		// The task runs the stock public Node 24 image by default, pulled by ECS —
		// NOT a locally-built image asset (which would carry an account/region ECR
		// URI). The command override runs the inlined bootstrap.
		template.hasResourceProperties('AWS::ECS::TaskDefinition', {
			ContainerDefinitions: Match.arrayWith([
				Match.objectLike({
					Image: 'public.ecr.aws/docker/library/node:24-slim',
					EntryPoint: ['node', '-e'],
					Command: Match.arrayWith([Match.stringLikeRegexp('bootstrap\\.mjs')]),
				}),
			]),
		});

		// The injected env carries the code-asset location + worker mode. Assert
		// each var independently (order-insensitive).
		const td = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0] as any;
		const env: Array<{ Name: string }> = td.Properties.ContainerDefinitions[0].Environment;
		const names = env.map((e) => e.Name);
		for (const required of [
			'BLOCKS_CODE_BUCKET',
			'BLOCKS_CODE_MAIN_KEY',
			'BLOCKS_CODE_WORKER_KEY',
			'BLOCKS_CODE_PKG_KEY',
			'BLOCKS_SERVICE_MODE',
			'BLOCKS_CONFIG_BUCKET',
		]) {
			assert.ok(names.includes(required), `expected env ${required}; got ${JSON.stringify(names)}`);
		}
		// No zip-prefix env should survive from the old directory-asset design.
		assert.ok(!names.includes('BLOCKS_CODE_PREFIX'), 'BLOCKS_CODE_PREFIX should be gone (per-file assets now)');

		// The container image is a stock registry string, so no ECR image-asset
		// repository is synthesized for it. (An image built via fromAsset would
		// reference an aws-cdk/assets ECR repo in the image URI — assert the image
		// is the literal stock string, which the check above already pins.)
		const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
		const images = Object.values(taskDefs).flatMap((td: any) =>
			(td.Properties?.ContainerDefinitions ?? []).map((c: any) => c.Image),
		);
		assert.ok(
			images.every((img: unknown) => typeof img === 'string' && !String(img).includes('dkr.ecr')),
			`no container image should be a built ECR asset; got ${JSON.stringify(images)}`,
		);
	});

	test('a custom image is used verbatim (still no local build)', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'ContainerCustomImageStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: (root: unknown) => new LambdaCompute(root as never, 'DefaultCompute'),
		} as never);

		new ContainerCompute(stack as never, 'worker', {
			size: { vcpu: 0.5, memory: 1024 },
			image: 'public.ecr.aws/example/custom-node:24',
		});

		const template = Template.fromStack(stack as unknown as cdk.Stack);
		template.hasResourceProperties('AWS::ECS::TaskDefinition', {
			ContainerDefinitions: Match.arrayWith([
				Match.objectLike({ Image: 'public.ecr.aws/example/custom-node:24' }),
			]),
		});
	});
});

describe('ContainerCompute — scale from zero (minInstances: 0)', () => {
	async function makeScalingStack(id: string) {
		const app = new cdk.App();
		return BlocksStack.create(app, id, {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: (root: unknown) => new LambdaCompute(root as never, 'DefaultCompute'),
		} as never);
	}

	/** Build a compute that drains one queue, finalize it, and return the template. */
	async function synthWithQueue(id: string, scaling: { minInstances: number; maxInstances: number }) {
		const stack = await makeScalingStack(id);
		const compute = new ContainerCompute(stack as never, 'worker', { size: { vcpu: 0.25, memory: 512 }, scaling });
		const sqs = await import('aws-cdk-lib/aws-sqs');
		compute.registerOwnedQueue(new sqs.Queue(stack as unknown as cdk.Stack, 'OwnedQueue'));
		compute.finalize();
		return Template.fromStack(stack as unknown as cdk.Stack);
	}

	/** Alarms whose metric math reads only the Visible count: the wake policy's alarm. */
	function wakeAlarms(template: Template) {
		return Object.values(template.findResources('AWS::CloudWatch::Alarm'))
			.map((a) => (a as { Properties: Record<string, unknown> }).Properties)
			.filter((p) => {
				const s = JSON.stringify(p.Metrics ?? []);
				return s.includes('ApproximateNumberOfMessagesVisible') && !s.includes('NotVisible');
			});
	}

	test('deploys at zero tasks and adds a task when a message is waiting', async () => {
		const template = await synthWithQueue('ContainerScaleFromZero', { minInstances: 0, maxInstances: 2 });

		template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0 });
		template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
			MinCapacity: 0,
			MaxCapacity: 2,
		});

		// The wake alarm fires at one or more waiting (Visible) messages. It must
		// not count in-flight messages, or a running job would keep adding tasks.
		const alarms = wakeAlarms(template);
		assert.strictEqual(alarms.length, 1, `one wake alarm; got ${JSON.stringify(alarms)}`);
		assert.strictEqual(alarms[0].ComparisonOperator, 'GreaterThanOrEqualToThreshold');
		assert.strictEqual(alarms[0].Threshold, 1);

		// Its policy adds one task.
		const policies = Object.values(template.findResources('AWS::ApplicationAutoScaling::ScalingPolicy')).map(
			(p) => (p as { Properties: Record<string, any> }).Properties,
		);
		const wake = policies.find((p) => String(p.PolicyName).includes('WakeOnWaitingMessages'));
		assert.ok(wake, `a wake policy exists; got ${policies.map((p) => p.PolicyName).join(', ')}`);
		assert.deepStrictEqual(
			wake.StepScalingPolicyConfiguration.StepAdjustments.map(
				(s: { ScalingAdjustment: number }) => s.ScalingAdjustment,
			),
			[1],
		);
	});

	test('wires autoscaling for minInstances 0 even when maxInstances is 1', async () => {
		const template = await synthWithQueue('ContainerScaleFromZeroMaxOne', { minInstances: 0, maxInstances: 1 });
		template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
			MinCapacity: 0,
			MaxCapacity: 1,
		});
		assert.strictEqual(wakeAlarms(template).length, 1);
	});

	test('a compute that keeps at least one task gets no wake policy', async () => {
		const template = await synthWithQueue('ContainerNoWake', { minInstances: 1, maxInstances: 3 });
		assert.strictEqual(wakeAlarms(template).length, 0);
	});

	test('a single fixed instance still gets no autoscaling', async () => {
		const template = await synthWithQueue('ContainerFixedOne', { minInstances: 1, maxInstances: 1 });
		template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0);
	});

	test('rejects instance bounds that would fail at deploy', async () => {
		const stack = await makeScalingStack('ContainerBadBounds');
		const cases: Array<[{ minInstances: number; maxInstances: number }, RegExp]> = [
			[{ minInstances: -1, maxInstances: 2 }, /minInstances must be an integer of 0 or more/],
			[{ minInstances: 0.5, maxInstances: 2 }, /minInstances must be an integer of 0 or more/],
			[{ minInstances: 0, maxInstances: 0 }, /maxInstances must be an integer of 1 or more/],
			[{ minInstances: 3, maxInstances: 2 }, /minInstances \(3\) must not exceed maxInstances \(2\)/],
		];
		cases.forEach(([scaling, message], i) => {
			assert.throws(() => new ContainerCompute(stack as never, `bad${i}`, { scaling }), message);
		});
	});
});
