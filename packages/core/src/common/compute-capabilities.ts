// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The compute type model. A customer states the *type* of compute explicitly
 * (never inferred from other attributes) and configures it with options scoped
 * to that type. Service names never appear in the surface — `serverless`,
 * `container`, etc. name the general kind of compute, not the AWS service that
 * backs it.
 *
 * See `docs/design/compute-selection-api.md` for the design rationale.
 */

/**
 * The general kind of compute. Stated explicitly by the customer.
 *
 * - `serverless` — pay-as-you-go, per-request, short-lived (Lambda today).
 * - `container` — a long-running / long-lived process (Fargate today).
 *
 * `vm` (an instance you manage) and `kubernetes` (container orchestration) are
 * reserved for future release.
 *
 * NOTE: these names are provisional; a forward-compatible naming axis across all
 * types is still being settled (see the design doc).
 */
export type ComputeType = 'serverless' | 'container';

/** AWS Lambda's maximum function timeout (15 minutes), in seconds. */
export const LAMBDA_MAX_TIMEOUT_SECONDS = 900;

/**
 * Valid Fargate vCPU + memory (MB) combinations. Each vCPU size permits only its
 * listed memory values, so an invalid pair cannot be represented. This matrix is
 * container-specific; future `vm`/`kubernetes` types bring their own size types.
 *
 * Memory steps: 1 GB up to 4 vCPU, 4 GB at 8 vCPU, 8 GB at 16 vCPU — the real
 * Fargate task-size constraints.
 */
export type ContainerSize =
	| { vcpu: 0.25; memory: 512 | 1024 | 2048 }
	| { vcpu: 0.5; memory: 1024 | 2048 | 3072 | 4096 }
	| { vcpu: 1; memory: 2048 | 3072 | 4096 | 5120 | 6144 | 7168 | 8192 }
	| {
			vcpu: 2;
			memory: 4096 | 5120 | 6144 | 7168 | 8192 | 9216 | 10240 | 11264 | 12288 | 13312 | 14336 | 15360 | 16384;
	  }
	| {
			vcpu: 4;
			memory:
				| 8192
				| 9216
				| 10240
				| 11264
				| 12288
				| 13312
				| 14336
				| 15360
				| 16384
				| 17408
				| 18432
				| 19456
				| 20480
				| 21504
				| 22528
				| 23552
				| 24576
				| 25600
				| 26624
				| 27648
				| 28672
				| 29696
				| 30720;
	  }
	| {
			vcpu: 8;
			memory: 16384 | 20480 | 24576 | 28672 | 32768 | 36864 | 40960 | 45056 | 49152 | 53248 | 57344 | 61440;
	  }
	| {
			vcpu: 16;
			memory: 32768 | 40960 | 49152 | 57344 | 65536 | 73728 | 81920 | 90112 | 98304 | 106496 | 114688 | 122880;
	  };

/** A signal that drives container autoscaling between the instance bounds. */
export type ScalingSignal =
	| { on: 'cpu'; targetPercent: number }
	| { on: 'memory'; targetPercent: number }
	| { on: 'queue-depth'; backlogPerInstance: number };

/**
 * Container instance-count bounds and scaling strategy.
 *
 * `minInstances`/`maxInstances` bound the running task count. `strategy` (one
 * signal or several) drives scaling between them; with several, scale-out
 * follows whichever signal demands the most instances and scale-in requires all
 * to agree. Omit `strategy` and Blocks infers one by workload — queue depth for
 * a compute that drains AsyncJob queues, CPU otherwise.
 */
export interface ContainerScaling {
	/**
	 * Fewest running instances. `0` lets the compute scale to zero between jobs:
	 * a waiting AsyncJob message or CronJob tick then starts an instance, which
	 * takes a few minutes. Only meaningful for a compute that drains jobs.
	 */
	minInstances: number;
	/** Most running instances. At least 1. */
	maxInstances: number;
	strategy?: ScalingSignal | ScalingSignal[];
}

/**
 * Options for a `serverless` compute. `serverless` has an inherent runtime
 * ceiling (the platform function timeout); container/VM do not, so this field is
 * unique to this type.
 */
export interface ServerlessComputeOptions {
	/**
	 * Memory (MB). CPU scales with memory on a serverless compute. The default is
	 * sized for the shared handler, which serves both the synchronous API path
	 * and async (SQS/AsyncJob) work; an API-only compute that never drains a
	 * queue can usually run on far less. Lower it when the compute handles only
	 * request/response traffic.
	 */
	memory?: number;
	/**
	 * The compute's inherent max runtime ceiling, in seconds (the Lambda function
	 * timeout, up to {@link LAMBDA_MAX_TIMEOUT_SECONDS}). A ceiling, not a job's
	 * deadline: a job's `timeoutSeconds` must be ≤ it. Defaults to the platform
	 * maximum.
	 *
	 * This is the ASYNC ceiling: the synchronous API path is bounded separately
	 * by API Gateway's 29s integration timeout no matter how high this is, so
	 * raising it only affects async/queue work. An API-only compute does not need
	 * a large value here, but keep it at or above 30s: the handler caps each HTTP
	 * request at the smaller of its 28s guard and this timeout, so a smaller value
	 * cuts the sync request deadline short. Leave it at the default unless async
	 * jobs need a specific ceiling.
	 */
	maxTimeoutSeconds?: number;
}

/** Options for a `container` compute. */
export interface ContainerComputeOptions {
	/** A valid vCPU + memory combination. */
	size?: ContainerSize;
	/** Instance-count bounds and scaling strategy. */
	scaling?: ContainerScaling;
	/**
	 * The container image to run, as a public or ECR registry URI. Used verbatim
	 * (pulled by ECS at task start — Blocks builds no image, so deploying needs no
	 * local Docker).
	 *
	 * Your application code is NOT baked into this image; Blocks delivers it
	 * separately and the container fetches it at boot. So the image only has to
	 * provide the **runtime environment**: it must have a **Node 24** runtime on
	 * `PATH` (matching the Lambda runtime), plus any system libraries your handlers
	 * need (e.g. image/video tooling). Use this to add such libraries — otherwise
	 * omit it.
	 *
	 * @default `public.ecr.aws/docker/library/node:24-slim` — a stock, public,
	 * AWS-hosted Node 24 image. Must be arm64-compatible (Blocks runs Fargate on
	 * Graviton); multi-arch images resolve automatically.
	 */
	image?: string;
}

/**
 * The discriminated options union a customer passes to `new Compute(scope, id, …)`.
 * Each `type` carries only its own options, so an attribute that doesn't apply
 * to the chosen type is a compile error.
 */
export type ComputeOptions =
	| ({ type: 'serverless' } & ServerlessComputeOptions)
	| ({ type: 'container' } & ContainerComputeOptions);

/**
 * Per-instance concurrency for a job on a container: `maxConcurrencyPerCPU`
 * multiplied by the compute's vCPU count, rounded up, floored at one. A
 * fractional-vCPU instance still runs at least one unit of work, and rounding up
 * never drops below the requested ratio.
 *
 * @param maxConcurrencyPerCPU - the job's requested concurrency per vCPU.
 * @param vcpu - the compute's `size.vcpu`.
 */
export function resolvePerInstanceConcurrency(maxConcurrencyPerCPU: number, vcpu: number): number {
	return Math.max(1, Math.ceil(maxConcurrencyPerCPU * vcpu));
}
