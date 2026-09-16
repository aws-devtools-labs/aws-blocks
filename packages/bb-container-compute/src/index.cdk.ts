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
import type { ComputeCapabilities } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
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
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
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

/** Default Fargate task sizing when the workload didn't request cpu/memory. */
const DEFAULT_CPU = 512;
const DEFAULT_MEMORY_MB = 1024;

/** Container port the runtime's health server listens on (worker mode still exposes it). */
const CONTAINER_PORT = 8080;

export class ContainerCompute extends Compute {
	/**
	 * Brand enabling cross-copy identification via {@link ContainerCompute.isContainerCompute}.
	 * @internal
	 */
	readonly [CONTAINER_COMPUTE_BRAND] = true;

	/** Container compute is always container-kind (drives AsyncJob delivery branching). */
	override readonly kind = 'container' as const;
	/** The capabilities this container was resolved from (poller reads timeoutSeconds). */
	override readonly capabilities: ComputeCapabilities;

	/** The Fargate service running the backend process. */
	readonly service?: ecs.FargateService;
	/** The task definition (its default container carries the injected env). */
	readonly taskDefinition?: ecs.FargateTaskDefinition;
	/** This container's CloudWatch log group (awslogs driver ships stdout/stderr here). */
	readonly logGroup: LogGroup;

	/** Its own container so setEnv can add env vars after construction. */
	private readonly container?: ecs.ContainerDefinition;

	constructor(scope: ScopeParent, id: string, options?: ContainerComputeProps) {
		super(id, { parent: scope });
		this.capabilities = options?.capabilities ?? {};

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
		// Derive/reuse the one shared VPC and initialize context on the owning STACK
		// (not `this`), so create()'s finalize sees it via isVpcInitialized(stack)
		// and doesn't create a second one. getVpcContext walks up the tree, so this
		// container (and every sibling) still resolves it.
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

		const assetPath = this.buildImageAsset();
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
		// ECS when a container compute exists. Done once per stack: several
		// container computes would otherwise pile up identical trust statements and
		// overflow the inline-policy limit.
		const taskRole = this.executionRole;
		this.appendEcsTrustOnce(taskRole);

		const cpu = this.capabilities.cpu ?? DEFAULT_CPU;
		const memoryLimitMiB = this.capabilities.memory ?? DEFAULT_MEMORY_MB;

		this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
			cpu,
			memoryLimitMiB,
			// The task role is the shared Blocks role (application permissions). The
			// separate executionRole (image pull + log write) is created by CDK.
			taskRole: taskRole as Role,
		});

		const { bucketName: configBucketName, key: configKey } = getConfigLocation(this);

		this.container = this.taskDefinition.addContainer('Backend', {
			image: this.capabilities.image
				? ecs.ContainerImage.fromRegistry(this.capabilities.image)
				: ecs.ContainerImage.fromAsset(assetPath),
			logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'blocks', logGroup: this.logGroup }),
			environment: {
				NODE_ENV: 'production',
				// The namespace the container rebuilds fullId (and every derived
				// resource name) from — the owning stack/backend's canonical root id,
				// the SAME value the Lambda handler/compute use.
				BLOCKS_STACK_NAME: this.backendStackName,
				// Config location so runContainer's loadConfigToProcessEnv() loads the
				// full app config (IAM to read it is inherited via the shared role).
				BLOCKS_CONFIG_BUCKET: configBucketName,
				BLOCKS_CONFIG_KEY: configKey,
				// Identifies this compute so an event block's poller only drains the
				// queues whose BLOCKS_HANDLER_OWNER matches (the owner-match seam).
				BLOCKS_COMPUTE_ID: this.fullId,
				// Worker mode: start owned pollers, no inbound RPC serving (routing to
				// containers is a separate front-door concern).
				BLOCKS_SERVICE_MODE: 'worker',
			},
			portMappings: [{ containerPort: CONTAINER_PORT }],
		});

		this.service = new ecs.FargateService(this, 'Service', {
			cluster: this.getOrCreateCluster(vpc),
			taskDefinition: this.taskDefinition,
			desiredCount: 1,
			vpcSubnets: vpcContext.computeSubnets,
			securityGroups: [vpcContext.computeSecurityGroup],
			// A worker drains a queue; brief overlap on redeploy is harmless and
			// avoids a gap where nothing polls.
			minHealthyPercent: 100,
			maxHealthyPercent: 200,
			// Fail (and roll back) a deploy quickly when tasks can't start, instead
			// of CloudFormation waiting up to ~3 hours for the service to stabilize.
			circuitBreaker: { rollback: true },
		});
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
	private buildImageAsset(): string | undefined {
		if (this.capabilities.image) {
			// A custom image is used verbatim (fromRegistry); no asset build needed.
			// Return a sentinel non-undefined so provisioning proceeds.
			return this.capabilities.image;
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
