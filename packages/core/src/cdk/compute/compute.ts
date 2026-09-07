// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Annotations } from 'aws-cdk-lib';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
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
	 * Whether a Logger targets this compute — flipped by {@link enableLogging}.
	 * Private so only the compute itself can set it (an observability BB signals
	 * intent by calling `enableLogging`, never by mutating this); read internally
	 * by {@link dashboardSection} to decide whether to render the logs section.
	 */
	private loggerEnabled = false;

	/**
	 * Whether a Tracer targets this compute — flipped by {@link enableTracing}.
	 * Private for the same reason as {@link loggerEnabled}.
	 */
	private tracerEnabled = false;

	/**
	 * The last explicit log retention (in days) written via {@link setLogRetention}.
	 * Tracked so a later, conflicting explicit value can warn about the silent
	 * last-wins (several Loggers can target one compute and all describe its one
	 * log group). Private — only {@link setLogRetention} sets it.
	 */
	private explicitLogRetentionDays?: number;

	/** Read-only view of {@link loggerEnabled} for subclasses (e.g. to guard their
	 * `loggingWidgets` builder). Subclasses can read but not set it. */
	protected get isLoggerEnabled(): boolean {
		return this.loggerEnabled;
	}

	/** Read-only view of {@link tracerEnabled} for subclasses (e.g. to guard their
	 * `tracingWidgets` builder). Subclasses can read but not set it. */
	protected get isTracerEnabled(): boolean {
		return this.tracerEnabled;
	}

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
	 * Attach a Logger to this compute: records that logs should be shown (so the
	 * Dashboard renders this compute's logs section) and, when an explicit
	 * `retentionDays` is given, sets the retention on the compute's single log
	 * group. Presence-based — the Logger Building Block calls this to signal
	 * intent, targeting the right compute without touching a specific function's
	 * log group.
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
		this.loggerEnabled = true;
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
	 * Enable distributed tracing on this compute: record that traces should be
	 * shown (so the Dashboard renders this compute's traces section) and turn on
	 * the compute's active tracing via {@link applyTracing}. The Tracer Building
	 * Block calls this instead of poking a specific function so tracing targets
	 * the right compute.
	 */
	enableTracing(): void {
		this.tracerEnabled = true;
		this.applyTracing();
	}

	/**
	 * Turn on this compute's active tracing (e.g. X-Ray) and grant its role the
	 * permission to publish trace segments. Called by {@link enableTracing};
	 * `protected` so tracing can't be turned on without marking the compute
	 * traced.
	 */
	protected abstract applyTracing(): void;

	/**
	 * Build this compute's CloudWatch Dashboard section: its health widgets
	 * always, plus its log / trace widgets **only when** a Logger / Tracer is
	 * attached to this compute (via {@link enableLogging} / {@link enableTracing}).
	 *
	 * This is the single public entry the Dashboard Building Block uses; the
	 * per-kind builders below are `protected` so a caller cannot obtain log or
	 * trace widgets for a compute that has no logging / tracing enabled (which
	 * would render empty, misleading widgets).
	 *
	 * @param region - AWS region the widgets query metrics in.
	 */
	dashboardSection(region: string): ComputeDashboardSection {
		return {
			// The scope id (e.g. 'DefaultCompute', 'api') — short and readable for a
			// section header, and distinct per compute within a stack. (Not fullId,
			// which is stack-prefixed and verbose.)
			label: this.id,
			health: this.healthWidgets(region),
			logging: this.loggerEnabled ? this.loggingWidgets(region) : undefined,
			tracing: this.tracerEnabled ? this.tracingWidgets(region) : undefined,
		};
	}

	/**
	 * Build this compute's health widget rows (rows of `IWidget`). Implemented by
	 * a concrete compute; obtained only via {@link dashboardSection}.
	 *
	 * @param region - AWS region the widgets query metrics in.
	 */
	protected abstract healthWidgets(region: string): IWidget[][];

	/**
	 * Build this compute's **log** widget rows (recent-errors query + log-volume
	 * graph) for its own log group. Gated behind {@link dashboardSection} so it
	 * is only used when a Logger is attached.
	 *
	 * @param region - AWS region the widgets query in.
	 */
	protected abstract loggingWidgets(region: string): IWidget[][];

	/**
	 * Build this compute's **trace** widget rows (an X-Ray trace list filtered to
	 * this compute). Gated behind {@link dashboardSection} so it is only used
	 * when a Tracer is attached.
	 *
	 * @param region - AWS region the widget queries in.
	 */
	protected abstract tracingWidgets(region: string): IWidget[][];
}

/**
 * A compute's self-reported CloudWatch Dashboard section. `health` is always
 * present; `logging` / `tracing` are populated only when a Logger / Tracer is
 * attached to the compute.
 */
export interface ComputeDashboardSection {
	/** Display label used as the compute's group header. */
	label: string;
	/** Health widget rows — always present. */
	health: IWidget[][];
	/** Log widget rows — present when a Logger is attached. */
	logging?: IWidget[][];
	/** Trace widget rows — present when a Tracer is attached. */
	tracing?: IWidget[][];
}
