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

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContainerScaling, ScalingSignal, ScopeParent } from '@aws-blocks/core';
import { getConfigDeployment, getConfigLocation } from '@aws-blocks/core/cdk';
import {
	ComputeBase,
	getBlocksRoot,
	getOrCreateOnRoot,
	getOrCreateVpc,
	getVpcContext,
	initializeVpc,
	registerVpcRequirements,
} from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { bundleContainerAsset } from './bundle.js';
import {
	buildContainerHealthWidgets,
	buildContainerLoggingWidgets,
	buildContainerTracingWidgets,
} from './observability.js';
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

/**
 * Default container image when the workload didn't set `image`. A stock, public,
 * AWS-hosted Node image on the SAME Node major as the Lambda runtime
 * ({@link DEFAULT_NODE_RUNTIME}, Node 24), so container and function behavior
 * match. Pulled remotely by ECS at task start — Blocks builds NO image, so a
 * deploy never needs a local Docker daemon. The app code is delivered separately
 * as an S3 asset and fetched at boot (see `bootstrap.mjs`).
 */
const DEFAULT_CONTAINER_IMAGE = 'public.ecr.aws/docker/library/node:24-slim';

/** Absolute in-container path the bootstrap runs from (also runs itself from here). */
const BOOTSTRAP_PATH = '/app/bootstrap.mjs';

/** SQS queue URLs an AsyncJob assigned to a container registers here so the compute's
 * queue-depth autoscaling can sum them. Keyed per compute via a Symbol on the instance. */
const OWNED_QUEUES: unique symbol = Symbol.for('blocks:ContainerOwnedQueues');

export class ContainerCompute extends ComputeBase {
	/**
	 * Brand enabling cross-copy identification via {@link ContainerCompute.isContainerCompute}.
	 * @internal
	 */
	readonly [CONTAINER_COMPUTE_BRAND] = true;

	/** Container compute is always container-type (drives AsyncJob delivery branching). */
	override readonly type = 'container' as const;
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
		// census of the app still shows a VPC is needed), then resolve one now —
		// the service is constructed here, during the backend import, well before
		// create()'s finalizeVpc runs.
		registerVpcRequirements(this as unknown as { readonly fullId: string } & typeof this, {
			requiresVpc: true,
			requiresEgress: true,
		});
		const root = getBlocksRoot(this);
		// Honor a customer-provided VPC: if `defaults.vpc.network` was set, the
		// backend published a `source: 'provided'` context before this import, so
		// it's already discoverable here — reuse it. Otherwise derive the one shared
		// Blocks VPC on the backend root (fixed id, so N containers share ONE VPC and
		// placement is order-independent) and publish it as a `source: 'derived'`
		// context. The `derived` tag is what keeps a stateful block (Database) from
		// auto-joining this VPC: joining a Blocks-derived VPC would move an existing
		// cluster on a routine change (e.g. adding this container) and replace it.
		// Stateless compute (this container, Lambda) shares it freely.
		const existingContext = getVpcContext(this);
		if (!existingContext) {
			const derived = getOrCreateVpc(root);
			initializeVpc(root, { network: derived }, 'derived');
		}
		const vpcContext = getVpcContext(this);

		this.logGroup = new LogGroup(this, 'TaskLogGroup', {
			retention: options?.logRetention ?? this.defaults.logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		const assetPath = this.buildCodeAsset();
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
			// Node base image. Blocks defaults Lambda to arm64 too. A custom `image`
			// must therefore be arm64 (multi-arch images resolve automatically).
			runtimePlatform: {
				cpuArchitecture: ecs.CpuArchitecture.ARM64,
				operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
			},
			taskRole: taskRole as Role,
		});

		const { bucketName: configBucketName, key: configKey } = getConfigLocation(this);

		// Upload the co-bundled app code as S3 assets (plain file upload — NO
		// Docker). The container pulls a stock Node image and fetches these bundles
		// at boot via bootstrap.mjs, so there is no local image build. CDK
		// asset-hashing tracks code changes and re-uploads on change automatically.
		//
		// IMPORTANT: each file is its OWN Asset. A directory Asset is archived into
		// a single `.zip` object (not individually-keyed files), and the stock Node
		// image has no `unzip`/zip reader — so the dependency-free bootstrap could
		// not extract it. Uploading each file as a regular-file Asset keys them
		// individually (`<hash>.js`), so the bootstrap can GET each one directly.
		const mainAsset = new s3assets.Asset(this, 'CodeMain', { path: join(assetPath, 'main.js') });
		const workerAsset = new s3assets.Asset(this, 'CodeWorker', { path: join(assetPath, 'worker.js') });
		const pkgAsset = new s3assets.Asset(this, 'CodePackageJson', { path: join(assetPath, 'package.json') });
		// The task runs as the execution role (= task role here); grant it read on
		// the asset objects so bootstrap.mjs can download them with the task role.
		mainAsset.grantRead(taskRole);
		workerAsset.grantRead(taskRole);
		pkgAsset.grantRead(taskRole);

		this.container = this.taskDefinition.addContainer('Backend', {
			// Stock public Node image by default, or the customer's image verbatim —
			// either way via fromRegistry (a remote pull, never a local build). The
			// image supplies the runtime environment (it must provide Node 24 on
			// PATH); Blocks injects the app code at boot via the command override.
			image: ecs.ContainerImage.fromRegistry(options?.image ?? DEFAULT_CONTAINER_IMAGE),
			// Override the image's entrypoint/command: write the bootstrap to disk
			// from a base64 arg (so no extra object to fetch), then run it. The
			// bootstrap fetches main.js/worker.js/package.json from the S3 assets'
			// exact keys using the task role and execs the parent. This is the
			// sanctioned ECS "generic image + command override" pattern; see
			// bootstrap.mjs.
			entryPoint: ['node', '-e'],
			command: [this.buildBootstrapLauncher(assetPath)],
			logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'blocks', logGroup: this.logGroup }),
			environment: {
				NODE_ENV: 'production',
				BLOCKS_STACK_NAME: this.backendStackName,
				BLOCKS_CONFIG_BUCKET: configBucketName,
				BLOCKS_CONFIG_KEY: configKey,
				BLOCKS_COMPUTE_ID: this.fullId,
				BLOCKS_SERVICE_MODE: 'worker',
				// Where bootstrap.mjs fetches each app bundle from (same bucket; the
				// three files are individually-keyed S3 assets).
				BLOCKS_CODE_BUCKET: mainAsset.s3BucketName,
				BLOCKS_CODE_MAIN_KEY: mainAsset.s3ObjectKey,
				BLOCKS_CODE_WORKER_KEY: workerAsset.s3ObjectKey,
				BLOCKS_CODE_PKG_KEY: pkgAsset.s3ObjectKey,
			},
			portMappings: [{ containerPort: CONTAINER_PORT }],
		});

		this.service = new ecs.FargateService(this, 'Service', {
			cluster: this.getOrCreateCluster(vpcContext.vpc),
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
		// Order the service after the config upload: the container parent loads
		// config once at boot (loadConfigToProcessEnv) and never retries, so if the
		// task starts before the config object exists it registers zero pollers and
		// sits idle while the health check still reports ok. The dependency is on
		// the deployment that writes blocks-config.json; getConfigDeployment is
		// available here because finalize() runs after finalizeConfigRegistry.
		if (this.service) {
			const configDeployment = getConfigDeployment(this);
			if (configDeployment) this.service.node.addDependency(configDeployment);
		}

		const cfg = this.scalingConfig;
		if (!this.service || !cfg || cfg.maxInstances <= 1) return;

		const scalable = this.service.autoScaleTaskCount({
			minCapacity: cfg.minInstances,
			maxCapacity: cfg.maxInstances,
		});

		// Resolve the strategy: explicit signals, or an inferred default. A compute
		// that drains queues defaults to queue-depth; otherwise CPU.
		const ownedQueues = (this as unknown as { [OWNED_QUEUES]?: sqs.IQueue[] })[OWNED_QUEUES] ?? [];
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
				// queue-depth: sum the backlog across every owned queue and step
				// scale on the total. Target tracking rejects a math expression (CDK's
				// scaleToTrackCustomMetric wants a direct metric), so the sum-across-
				// queues signal uses step scaling: add capacity as the backlog grows in
				// multiples of backlogPerInstance, remove it as it shrinks. The steps
				// are relative to the current task count via changeInCapacity.
				if (ownedQueues.length === 0) continue;
				const using: Record<string, cloudwatch.IMetric> = {};
				ownedQueues.forEach((q, i) => {
					// Count BOTH visible and in-flight (NotVisible) messages. Visible
					// alone drops to 0 the instant a long-running job picks a message up,
					// so a queue fully drained into still-running jobs would read empty
					// and scale a task in from under an in-flight delivery. Including
					// NotVisible keeps the backlog non-zero until the work actually
					// finishes, so scale-in waits for the jobs, not just the queue.
					using[`v${i}`] = q.metricApproximateNumberOfMessagesVisible();
					using[`n${i}`] = q.metricApproximateNumberOfMessagesNotVisible();
				});
				const backlog = new cloudwatch.MathExpression({
					expression: Object.keys(using).join(' + '),
					usingMetrics: using,
					label: 'Backlog',
					period: cdk.Duration.minutes(1),
				});
				const per = signal.backlogPerInstance;
				scalable.scaleOnMetric(`QueueDepthScaling`, {
					metric: backlog,
					// Steps are relative to the current task count (CHANGE_IN_CAPACITY).
					// An empty backlog removes a task per interval (scale toward min);
					// each additional `per` messages of backlog adds instances. Without
					// the `{ upper: 0, change: -1 }` step the service would never scale
					// in — step scaling only removes capacity when a `change < 0` step
					// exists — leaving tasks pinned at the scaled-out count (full Fargate
					// cost) long after the queue drains.
					scalingSteps: [
						{ upper: 0, change: -1 },
						{ upper: per, change: 0 },
						{ lower: per, change: +1 },
						{ lower: per * 5, change: +3 },
					],
					adjustmentType: cdk.aws_applicationautoscaling.AdjustmentType.CHANGE_IN_CAPACITY,
					cooldown: cdk.Duration.minutes(1),
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
	 * policy, once per role. Keyed on the **role object** (not the stack) so two
	 * backends sharing one `cdk.Stack` each stamp their own `executionRole` — a
	 * stack-keyed guard would add the trust to the first backend's role only, and
	 * the second backend's tasks could not assume their role. `assumeRolePolicy`
	 * exists only on a concrete `iam.Role`; core always creates BlocksRole
	 * concretely, so narrow and fail loud if that ever changes.
	 */
	private appendEcsTrustOnce(role: cdk.aws_iam.IRole): void {
		const KEY = Symbol.for('BLOCKS_CONTAINER_ECS_TRUST');
		const roleAny = role as unknown as Record<symbol, boolean | undefined>;
		if (roleAny[KEY]) return;
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
		roleAny[KEY] = true;
	}

	/**
	 * One shared ECS cluster per backend root (BlocksStack/BlocksBackend) so
	 * multiple container computes share it rather than each standing up their own,
	 * and so two backends in one stack get independent clusters. Created on the
	 * root at a fixed id, mirroring the shared VPC.
	 */
	private getOrCreateCluster(vpc: ec2.IVpc): ecs.Cluster {
		return getOrCreateOnRoot(
			this,
			Symbol.for('BLOCKS_CONTAINER_CLUSTER'),
			(root) => new ecs.Cluster(root, 'BlocksContainerCluster', { vpc }),
		);
	}

	private getClusterName(): string {
		const rootAny = getBlocksRoot(this) as unknown as Record<symbol, ecs.Cluster | undefined>;
		return rootAny[Symbol.for('BLOCKS_CONTAINER_CLUSTER')]?.clusterName ?? '';
	}

	/**
	 * Co-bundle the app backend + `runContainer()` into an S3 **code asset** dir
	 * (NOT a Docker build context). Returns undefined when the backend module path
	 * can't be discovered (isolated unit tests) — the caller then skips
	 * provisioning. See {@link bundleContainerAsset}.
	 */
	private buildCodeAsset(): string | undefined {
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

	/**
	 * Build the `node -e` program string the task runs as its command override.
	 *
	 * The container's own code (`main.js`/`worker.js`) lives in S3 and is fetched
	 * at boot — but the fetcher itself (`bootstrap.mjs`) can't be fetched the same
	 * way without a chicken-and-egg. So we inline the committed `bootstrap.mjs`
	 * verbatim: write it to {@link BOOTSTRAP_PATH} and import it. The script then
	 * reads `BLOCKS_CODE_BUCKET`/`BLOCKS_CODE_PREFIX`, downloads the bundles with
	 * the task role, and execs the parent. No extra S3 round-trip for the booter,
	 * and nothing baked into the image.
	 *
	 * @param assetDir - the synth-time asset dir containing `bootstrap.mjs`.
	 */
	private buildBootstrapLauncher(assetDir: string): string {
		const bootstrapSource = readFileSync(join(assetDir, 'bootstrap.mjs'), 'utf8');
		const b64 = Buffer.from(bootstrapSource, 'utf8').toString('base64');
		// Write the ESM bootstrap to disk, then import() it (node -e runs CJS, so we
		// can't inline ESM syntax directly — import() of a file works from CJS).
		return [
			'const {writeFileSync,mkdirSync}=require("node:fs");',
			'mkdirSync("/app",{recursive:true});',
			`writeFileSync(${JSON.stringify(BOOTSTRAP_PATH)},Buffer.from(${JSON.stringify(b64)},"base64"));`,
			`import(${JSON.stringify(BOOTSTRAP_PATH)}).catch(e=>{console.error(e);process.exit(1);});`,
		].join('');
	}
}
