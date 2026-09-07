// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Annotations } from 'aws-cdk-lib';
import type { ScopeOptions } from '../../common/index.js';
import { Scope } from '../index.js';
import { registerCompute } from './compute-registry.js';

/**
 * Base class for a Blocks *compute* — a runtime that executes handler code
 * (Lambda today; containers later). A compute owns the physical function/service
 * plus its ingress, and receives config via {@link setEnv}.
 *
 * The backend entry and stack name a compute needs are inherited from
 * {@link Scope} (`backendHandlerPath` / `backendStackName`), which resolve them
 * from the owning BlocksStack/BlocksBackend — never caller-supplied, so every
 * compute in an app runs the same backend and agrees on the resource-name
 * namespace.
 *
 * The abstract base lives in core (a framework primitive); concrete computes
 * live in their own packages (e.g. `LambdaCompute` in `@aws-blocks/bb-lambda-compute`).
 *
 * @internal Not exported from the package's public entry points. Customers
 * cannot instantiate a compute until the customer-facing surface exists.
 */
export abstract class Compute extends Scope {
	/**
	 * API namespaces assigned to run on this compute — recorded so request
	 * routing can map a namespace to the compute that hosts it. Currently
	 * unpopulated (no compute assignment surface yet).
	 */
	readonly namespaces: string[] = [];

	/**
	 * The last explicit log retention (in days) written via {@link enableLogging}.
	 * Tracked so a later, conflicting explicit value can warn about the silent
	 * last-wins (several Loggers can target one compute and all describe its one
	 * log group). Private — only {@link enableLogging} sets it.
	 */
	private explicitLogRetentionDays?: number;

	constructor(id: string, options?: ScopeOptions) {
		super(id, options);
		// Self-register on the owning stack so finalize steps (config, routing,
		// dashboards) can enumerate every compute without a separate discovery
		// pass. Scoped per stack, so a multi-stack synth keeps lists isolated.
		registerCompute(this);
	}

	/**
	 * Inject a runtime configuration value (an environment variable) into this
	 * compute. The framework calls this instead of `handler.addEnvironment()`
	 * directly so config targets the right compute.
	 */
	abstract setEnv(key: string, value: string): void;

	/**
	 * Attach a Logger to this compute. When an explicit `retentionDays` is given,
	 * sets the retention on the compute's single log group. The Logger Building
	 * Block calls this so logging targets the right compute without touching a
	 * specific function's log group.
	 *
	 * The Logger only knows about `enableLogging`; the compute owns the rest. A
	 * compute already owns one log group (created with the stack-wide
	 * `defaults.logRetention`), so no second group is spawned. The compute also
	 * owns the shared policy for `retentionDays`: because several Loggers can
	 * target one compute and all describe the same group, the **last** explicit
	 * value wins and a synth warning is emitted if a later call disagrees with an
	 * earlier one (so the clobber isn't silent). A bare `enableLogging()` (no
	 * `retentionDays`) leaves the group's retention untouched.
	 *
	 * @param retentionDays - Optional CloudWatch Logs retention, in days. When
	 *   omitted, the group keeps the stack-wide `defaults.logRetention`.
	 */
	enableLogging(retentionDays?: number): void {
		if (retentionDays === undefined) return;

		if (this.explicitLogRetentionDays !== undefined && this.explicitLogRetentionDays !== retentionDays) {
			Annotations.of(this).addWarningV2(
				'@aws-blocks/core:log-retention-conflict',
				`Compute "${this.id}": log retention set to ${retentionDays} day(s), overriding an earlier ` +
					`explicit ${this.explicitLogRetentionDays} day(s) — all Loggers on a compute share its one ` +
					'log group, so the last value wins. Set a single explicit retention (or rely on the ' +
					'stack-wide `defaults.logRetention`) to avoid the ambiguity.',
			);
		}
		this.explicitLogRetentionDays = retentionDays;
		this.applyLogRetention(retentionDays);
	}

	/**
	 * Reconfigure this compute's log group retention to `retentionDays`.
	 * Implemented by the concrete compute (which owns the group); invoked only
	 * via {@link enableLogging} so the last-wins + conflict-warning policy always
	 * runs. `protected` so retention can't be changed without that policy.
	 */
	protected abstract applyLogRetention(retentionDays: number): void;

	/**
	 * Enable distributed tracing on this compute: turn on the compute's active
	 * tracing via {@link applyTracing}. The Tracer Building Block calls this
	 * instead of poking a specific function so tracing targets the right compute.
	 */
	enableTracing(): void {
		this.applyTracing();
	}

	/**
	 * Turn on this compute's active tracing (e.g. X-Ray) and grant its role the
	 * permission to publish trace segments. Called by {@link enableTracing};
	 * `protected` so tracing can't be turned on without going through it.
	 */
	protected abstract applyTracing(): void;
}
