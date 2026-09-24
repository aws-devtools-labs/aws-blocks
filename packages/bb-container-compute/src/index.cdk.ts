// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A container-backed {@link Compute}: a long-lived AWS Fargate service that runs
 * the Blocks backend as a persistent process and self-starts its owned event
 * pollers (see core's `runContainer`). Selected by the public `Compute` block
 * when a workload's capabilities exceed Lambda's envelope (a wall-clock budget
 * over 15 minutes, an explicit CPU request, a long-lived process, or a custom
 * image).
 *
 * The tasks run AS the shared Blocks execution role (`this.executionRole`), so
 * every Building Block's grants reach the container exactly as they reach the
 * Lambda handler — no per-compute least-privilege analysis, matching the shared
 * handler's trust boundary.
 *
 * **VPC.** Fargate tasks are intrinsically VPC-resident, so this compute hooks
 * into the framework's central lazy VPC: it derives (or reuses) the one shared
 * app VPC in its constructor via `getOrCreateVpc` + `initializeVpc`, and places
 * its tasks in the `private-with-egress` tier (NAT egress for image pulls, logs,
 * and AWS APIs). A Lambda-only sibling in the same app joins the same VPC.
 *
 * @internal Not customer-instantiable — customers use the generic `Compute`
 * block, which builds this when the capabilities call for a container.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ContainerScaling, ScalingSignal, ScopeParent } from '@aws-blocks/core';
import { getConfigLocation } from '@aws-blocks/core/cdk';
import {
	Compute,
	getOrCreateVpc,
	getVpcContext,
	initializeVpc,
	isVpcInitialized,
	registerVpcRequirements,
} from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { buildContainerHealthWidgets, buildContainerLoggingWidgets, buildContainerTracingWidgets } from './observability.js';
import { bundleContainerAsset } from './bundle.js';
import type { ContainerComputeProps } from './types.js';

export type { ContainerComputeProps } from './types.js';

/**
 * Process-global brand marking a {@link ContainerCompute} instance. Registered
 * via `Symbol.for` (like `LambdaCompute`'s brand) so identification survives
 * duplicate `bb-container-compute` copies in one dependency tree, where
 * `instanceof` fails because each copy has a distinct class object.
 */
const CONTAINER_COMPUTE_BRAND: unique symbol = Symbol.for('blocks:ContainerCompute');

/** Fargate CPU units per vCPU. */
const CPU_UNITS_PER_VCPU = 1024;
/** Default Fargate task sizing when the workload didn't set `size`. */
const DEFAULT_VCPU = 0.5;
const DEFAULT_MEMORY_MB = 1024;

/** Container port the runtime's health server listens on (worker mode still exposes it). */
const CONTAINER_PORT = 8080;

/** SQS queue URLs an AsyncJob assigned to a container registers here so the compute's
 * queue-depth autoscaling can sum them. Keyed per compute via a Symbol on the instance. */
const OWNED_QUEUES: unique symbol = Symbol.for('blocks:ContainerOwnedQueues');

export class ContainerCompute extends Compute {
	/**
	 * Brand enabling cross-copy identification via {@link ContainerCompute.isContainerCompute}.
	 * @internal
	 */
	readonly [CONTAINER_COMPUTE_BRAND] = true;

	/** Container compute is always container-kind (drives AsyncJob delivery branching). */
	override readonly kind = 'container' as const;
	/** This container's vCPU count (from `size`), read by AsyncJob for per-CPU concurrency math. */
	override readonly vcpu: number;

	/** The Fargate service running the backend process. */
	readonly service?: ecs.FargateService;
	/** The task definition (its default container carries the injected env). */
	readonly taskDefinition?: ecs.FargateTaskDefinition;
	/** This container's CloudWatch log group (awslogs driver ships stdout/stderr here). */
	readonly logGroup: LogGroup;

	/** The scaling config, retained so finalize can wire queue-depth once queues are known. */
	private readonly scalingConfig?: ContainerScaling;
	/** Its own container so setEnv can add env vars after construction. */
	private readonly container?: ecs.ContainerDefinition;

	constructor(scope: ScopeParent, id: string, options?: ContainerComputeProps) {
		super(id, { parent: scope });
		const size = options?.size;
		this.vcpu = size?.vcpu ?? DEFAULT_VCPU;
		this.scalingConfig = options?.scaling;

		// A Fargate service needs a VPC. Declare the requirement centrally (so a
		// census of the app still shows a VPC is needed) and then materialize the
		// shared VPC now — the service is constructed here, during the backend
		// import, well before create()'s finalizeVpc runs. initializeVpc is guarded
		// so whichever of {this constructor, finalizeVpc} runs first wins and the
		// security group + context are created exactly once (isVpcInitialized).
		registerVpcRequirements(this as unknown as { readonly fullId: string } & typeof this, {
			requiresVpc: true,
			requiresEgress: true,
		});
		const stack = cdk.Stack.of(this);
		const vpc = getOrCreateVpc(stack);
		if (!isVpcInitialized(stack)) {
			initializeVpc(stack, { network: vpc });
		}
		const vpcContext = getVpcContext(this);

		this.logGroup = new LogGroup(this, 'TaskLogGroup', {
			retention: options?.logRetention ?? this.defaults.logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		const assetPath = this.buildImageAsset(options?.image);
		if (!assetPath || !vpcContext) {
			// No backend module discoverable (isolated unit test without a
			// BlocksStack) — skip provisioning rather than fail synth, mirroring how
			// the AgentCore runtime degrades. A test that wants the infra provides a
			// real stack.
			return;
		}

		// Run AS the shared Blocks execution role (task role) so every BB grant
		// reaches the container. Append the ecs-tasks trust principal to the shared
		// role's assume policy — added here (not in core) so the role only trusts
		// ECS when a container compute exists. Done once per stack.
		const taskRole = this.executionRole;
		this.appendEcsTrustOnce(taskRole);

		const cpu = Math.round(this.vcpu * CPU_UNITS_PER_VCPU);
		const memoryLimitMiB = size?.memory ?? DEFAULT_MEMORY_MB;

		this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
			cpu,
			memoryLimitMiB,
			// ARM64 (Graviton): cheaper at equal performance and matches the arm64
			// image Blocks builds. Blocks defaults Lambda to arm64 too.
			runtimePlatform: {
				cpuArchitecture: ecs.CpuArchitecture.ARM64,
				operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
			},
			taskRole: taskRole as Role,
		});

		const { bucketName: configBucketName, key: configKey } = getConfigLocation(this);

		this.container = this.taskDefinition.addContainer('Backend', {
			image: options?.image
				? ecs.ContainerImage.fromRegistry(options.image)
				: ecs.ContainerImage.fromAsset(assetPath, { platform: Platform.LINUX_ARM64 }),
			logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'blocks', logGroup: this.logGroup }),
			environment: {
				NODE_ENV: 'production',
				BLOCKS_STACK_NAME: this.backendStackName,
				BLOCKS_CONFIG_BUCKET: configBucketName,
				BLOCKS_CONFIG_KEY: configKey,
				BLOCKS_COMPUTE_ID: this.fullId,
				BLOCKS_SERVICE_MODE: 'worker',
			},
			portMappings: [{ containerPort: CONTAINER_PORT }],
		});

		this.service = new ecs.FargateService(this, 'Service', {
			cluster: this.getOrCreateCluster(vpc),
			taskDefinition: this.taskDefinition,
			desiredCount: this.scalingConfig?.minInstances ?? 1,
			vpcSubnets: vpcContext.computeSubnets,
			securityGroups: [vpcContext.computeSecurityGroup],
			minHealthyPercent: 100,
			maxHealthyPercent: 200,
			circuitBreaker: { rollback: true },
		});
	}

	/**
	 * Register an SQS queue this compute drains, so queue-depth autoscaling can sum
	 * across every queue on the compute. Called by an AsyncJob assigned here.
	 * @internal
	 */
	registerOwnedQueue(queue: sqs.IQueue): void {
		const holder = this as unknown as { [OWNED_QUEUES]?: sqs.IQueue[] };
		if (!holder[OWNED_QUEUES]) holder[OWNED_QUEUES] = [];
		holder[OWNED_QUEUES].push(queue);
	}

	/**
	 * Wire Application Auto Scaling on the service from {@link scalingConfig}.
	 * Overrides the base finalize hook so queue-depth scaling can see every
	 * AsyncJob queue registered via {@link registerOwnedQueue} during the backend
	 * import. No-op when scaling is absent or bounded to a single instance.
	 */
	override finalize(): void {
		const cfg = this.scalingConfig;
		if (!this.service || !cfg || cfg.maxInstances <= 1) return;

		const scalable = this.service.autoScaleTaskCount({
			minCapacity: cfg.minInstances,
			maxCapacity: cfg.maxInstances,
		});

		// Resolve the strategy: explicit signals, or an inferred default. A compute
		// that drains queues defaults to queue-depth; otherwise CPU.
		const ownedQueues =
			(this as unknown as { [OWNED_QUEUES]?: sqs.IQueue[] })[OWNED_QUEUES] ?? [];
		let signals: ScalingSignal[];
		if (cfg.strategy) {
			signals = Array.isArray(cfg.strategy) ? cfg.strategy : [cfg.strategy];
		} else if (ownedQueues.length > 0) {
			signals = [{ on: 'queue-depth', backlogPerInstance: 100 }];
		} else {
			signals = [{ on: 'cpu', targetPercent: 65 }];
		}

		for (const signal of signals) {
			if (signal.on === 'cpu') {
				scalable.scaleOnCpuUtilization(`CpuScaling`, { targetUtilizationPercent: signal.targetPercent });
			} else if (signal.on === 'memory') {
				scalable.scaleOnMemoryUtilization(`MemoryScaling`, { targetUtilizationPercent: signal.targetPercent });
			} else {
				// queue-depth: sum visible messages across every owned queue, tracked
				// per instance. Metric math because the target divides by task count.
				if (ownedQueues.length === 0) continue;
				const using: Record<string, cloudwatch.IMetric> = {};
				ownedQueues.forEach((q, i) => {
					using[`m${i}`] = q.metricApproximateNumberOfMessagesVisible();
				});
				const backlog = new cloudwatch.MathExpression({
					expression: Object.keys(using).join(' + '),
					usingMetrics: using,
					label: 'BacklogVisible',
				});
				scalable.scaleToTrackCustomMetric(`QueueDepthScaling`, {
					metric: backlog,
					targetValue: signal.backlogPerInstance,
				});
			}
		}
	}

	/**
	 * Inject a runtime configuration value as a container env var. Called by the
	 * framework (e.g. finalizeConfigRegistry) after construction; the container
	 * definition exists by then for any provisioned compute.
	 */
	setEnv(key: string, value: string): void {
		this.container?.addEnvironment(key, value);
	}

	/**
	 * Type guard for a {@link ContainerCompute} that survives duplicate
	 * `bb-container-compute` copies in one dependency tree — checks the
	 * process-global brand rather than class identity.
	 */
	static isContainerCompute(x: unknown): x is ContainerCompute {
		return (
			typeof x === 'object' &&
			x !== null &&
			(x as { [CONTAINER_COMPUTE_BRAND]?: unknown })[CONTAINER_COMPUTE_BRAND] === true
		);
	}

	protected applyTracing(): void {
		// ADOT sidecar / X-Ray for containers is a later observability task; the
		// container still ships stdout traces via the log driver. No-op for now so
		// enabling a Tracer doesn't fail on a container compute.
	}

	protected healthWidgets(region: string): IWidget[][] {
		return buildContainerHealthWidgets(this.service?.serviceName ?? this.fullId, this.getClusterName(), region);
	}

	protected loggingWidgets(region: string): IWidget[][] {
		return buildContainerLoggingWidgets(this.logGroup.logGroupName, region);
	}

	protected tracingWidgets(region: string): IWidget[][] {
		return buildContainerTracingWidgets(this.service?.serviceName ?? this.fullId, region);
	}

	/**
	 * Append the `ecs-tasks` service principal to the shared role's assume-role
	 * policy, once per stack. `assumeRolePolicy` exists only on a concrete
	 * `iam.Role`; core always creates BlocksRole concretely, so narrow and fail
	 * loud if that ever changes.
	 */
	private appendEcsTrustOnce(role: cdk.aws_iam.IRole): void {
		const stack = cdk.Stack.of(this);
		const KEY = Symbol.for('BLOCKS_CONTAINER_ECS_TRUST');
		const stackAny = stack as unknown as Record<symbol, boolean | undefined>;
		if (stackAny[KEY]) return;
		if (!(role instanceof Role)) {
			throw new Error(
				'ContainerCompute requires the shared Blocks execution role to be a concrete iam.Role to add its ecs-tasks trust',
			);
		}
		role.assumeRolePolicy?.addStatements(
			new cdk.aws_iam.PolicyStatement({
				effect: cdk.aws_iam.Effect.ALLOW,
				principals: [new ServicePrincipal('ecs-tasks.amazonaws.com')],
				actions: ['sts:AssumeRole'],
			}),
		);
		stackAny[KEY] = true;
	}

	/**
	 * One shared ECS cluster per stack (keyed on the stack) so multiple container
	 * computes share it rather than each standing up their own.
	 */
	private getOrCreateCluster(vpc: ec2.IVpc): ecs.Cluster {
		const stack = cdk.Stack.of(this);
		const KEY = Symbol.for('BLOCKS_CONTAINER_CLUSTER');
		const stackAny = stack as unknown as Record<symbol, ecs.Cluster | undefined>;
		if (stackAny[KEY]) return stackAny[KEY]!;
		const cluster = new ecs.Cluster(stack, 'BlocksContainerCluster', { vpc });
		stackAny[KEY] = cluster;
		return cluster;
	}

	private getClusterName(): string {
		const stackAny = cdk.Stack.of(this) as unknown as Record<symbol, ecs.Cluster | undefined>;
		return stackAny[Symbol.for('BLOCKS_CONTAINER_CLUSTER')]?.clusterName ?? '';
	}

	/**
	 * Co-bundle the app backend + `runContainer()` into a Docker build context dir.
	 * Returns undefined when the backend module path can't be discovered (isolated
	 * unit tests) — the caller then skips provisioning.
	 */
	private buildImageAsset(image?: string): string | undefined {
		if (image) {
			// A custom image is used verbatim (fromRegistry); no asset build needed.
			// Return a sentinel non-undefined so provisioning proceeds.
			return image;
		}
		const stack = (globalThis as any).CURRENT_BLOCKS_STACK as { backendModulePath?: string } | undefined;
		const backendModulePath = stack?.backendModulePath;
		if (!backendModulePath) return undefined;
		const outDir = join(
			cdk.App.of(this)?.outdir ?? cdk.Stack.of(this).node.tryGetContext('cdk.out') ?? '.cdk-container',
			`container-${this.fullId}`,
		);
		mkdirSync(outDir, { recursive: true });
		return bundleContainerAsset(backendModulePath, outDir);
	}
}
