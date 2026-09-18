// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Capability attributes that describe *what* a workload needs from its compute,
 * expressed as service-agnostic traits rather than an AWS service name. Blocks
 * reads these to select the backing service (see {@link selectComputeKind}): a
 * short, memory-modest, request/response workload fits Lambda; anything that
 * exceeds Lambda's envelope — a longer wall-clock budget, more memory, an
 * explicit long-lived process, or a custom container image — is placed on a
 * container (Fargate) instead.
 *
 * This is the single source of truth for both the customer-facing `Compute`
 * block (which takes these as its options) and the internal selection logic, so
 * the block's public surface never mentions Lambda or Fargate.
 */
export interface ComputeCapabilities {
	/**
	 * Wall-clock budget for a single unit of work, in seconds. On a Lambda-backed
	 * compute this maps to the function timeout (hard-capped at 900s by the
	 * platform); on a container it is enforced in-process by the poller, which
	 * aborts a handler that runs past it. A value above
	 * {@link LAMBDA_MAX_TIMEOUT_SECONDS} therefore forces a container.
	 *
	 * @default undefined — the compute uses its platform default.
	 */
	timeoutSeconds?: number;

	/**
	 * Memory available to the workload, in MB. Above {@link LAMBDA_MAX_MEMORY_MB}
	 * (Lambda's ceiling) this forces a container. On a container it sets the task
	 * memory.
	 *
	 * @default undefined — the compute uses its platform default.
	 */
	memory?: number;

	/**
	 * vCPU units for the workload (1024 = 1 vCPU), Fargate's unit. Lambda derives
	 * CPU from memory and has no independent CPU knob, so setting this forces a
	 * container (there is no way to honor an explicit CPU request on Lambda).
	 *
	 * @default undefined
	 */
	cpu?: number;

	/**
	 * Whether the workload is a **long-lived process** rather than a
	 * per-invocation function — e.g. it drains a queue continuously, holds
	 * persistent connections, or keeps warm state between units of work. A
	 * long-lived workload cannot run on Lambda's per-invocation model, so this
	 * forces a container.
	 *
	 * @default false
	 */
	longLived?: boolean;

	/**
	 * A custom container image reference (an ECR image URI or a local build
	 * context path) to run instead of the Blocks-built default image. Supplying
	 * one is intrinsically a container request, so it forces a container.
	 *
	 * @default undefined — Blocks builds and runs its standard image.
	 */
	image?: string;

	/**
	 * On a container, the maximum number of jobs this compute processes at once
	 * per task. This is the primary **per-task cost lever**: each in-flight job
	 * runs in its own worker thread, so this bounds concurrent CPU/memory use, and
	 * you size the task's `cpu`/`memory` to match. Ignored on Lambda (which scales
	 * by concurrent invocations, not an in-process cap).
	 *
	 * @default a conservative framework default (container jobs are typically
	 * heavy); raise it alongside `cpu`/`memory` for higher throughput per task.
	 */
	maxConcurrency?: number;

	/**
	 * Task-count autoscaling for a container compute — the layer above
	 * {@link maxConcurrency} (which caps jobs *per task*). Scales the number of
	 * tasks between `minTasks` and `maxTasks`, targeting roughly
	 * `backlogPerTask` visible queue messages per task. Reserved for a future
	 * release; declaring it today has no effect yet. It is an options field so
	 * adding the behavior later is non-breaking.
	 *
	 * @default undefined — a single task (no autoscaling).
	 */
	scaling?: {
		/** Minimum running tasks. */
		minTasks?: number;
		/** Maximum running tasks. */
		maxTasks?: number;
		/** Target visible-queue-messages per task for target tracking. */
		backlogPerTask?: number;
	};
}

/**
 * Which backing service a {@link Compute} resolves to. `'lambda'` for a
 * per-invocation function; `'container'` for a long-lived Fargate task. Internal
 * — customers only ever see the generic `Compute` block.
 * @internal
 */
export type ComputeKind = 'lambda' | 'container';

/**
 * The public-facing handle for a compute a customer can hand to a handler-bearing
 * block (e.g. `new AsyncJob(scope, id, { compute })`). It is intentionally opaque:
 * a Building Block only needs to *pass it back* to the framework, which resolves
 * the concrete compute internally. Both the CDK `Compute` construct and the inert
 * mock/browser compute stubs satisfy this empty marker structurally, so a BB's
 * options type can reference it without importing CDK — the same cross-entry-safe
 * pattern the SDK-identifier and value markers use.
 *
 * The brand keeps it from collapsing to `unknown`/`{}` (which would accept any
 * value); it is never read at runtime.
 */
export interface ComputeHandle {
	/** @internal Nominal brand — never populated; present only so the type is distinct. */
	readonly __blocksCompute?: never;
}

/** AWS Lambda's maximum function timeout (15 minutes), in seconds. */
export const LAMBDA_MAX_TIMEOUT_SECONDS = 900;

/** AWS Lambda's maximum function memory, in MB. */
export const LAMBDA_MAX_MEMORY_MB = 10_240;

/**
 * Select the backing compute kind from capability attributes. A workload runs on
 * Lambda unless it declares something Lambda cannot provide — a wall-clock
 * budget beyond 15 minutes, more than 10 GB of memory, an explicit CPU request
 * (Lambda has no CPU knob), a long-lived process, or a custom image — any of
 * which places it on a container instead.
 *
 * The rule is deliberately conservative: absent any capability that Lambda
 * can't satisfy, the cheaper request/response Lambda wins, so a plain
 * `new Compute(scope, 'x')` stays Lambda and matches today's default.
 */
export function selectComputeKind(caps: ComputeCapabilities): ComputeKind {
	if (caps.longLived === true) return 'container';
	if (caps.image !== undefined) return 'container';
	if (caps.cpu !== undefined) return 'container';
	if (caps.timeoutSeconds !== undefined && caps.timeoutSeconds > LAMBDA_MAX_TIMEOUT_SECONDS) return 'container';
	if (caps.memory !== undefined && caps.memory > LAMBDA_MAX_MEMORY_MB) return 'container';
	return 'lambda';
}
