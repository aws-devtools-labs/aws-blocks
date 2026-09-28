// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
 * **Observability is compute-owned at deploy time.** Logging is always on (a
 * compute owns its log group and captures stdout; retention is a compute-level
 * setting), so there is no "enable logging" — logs always exist. Tracing, by
 * contrast, provisions real infrastructure (X-Ray) and has cost, so it is
 * enabled explicitly via {@link enableTracing} — which the framework calls on
 * every compute when the app contains a `Tracer` (presence-gated).
 *
 * The abstract base lives in core (a framework primitive); concrete computes
 * live in their own packages (e.g. `LambdaCompute` in `@aws-blocks/bb-lambda-compute`).
 *
 * @internal Not exported from the package's public entry points.
 */
export abstract class Compute extends Scope {
	/**
	 * API namespaces assigned to run on this compute — recorded so request
	 * routing can map a namespace to the compute that hosts it. Currently
	 * unpopulated (no compute assignment surface yet).
	 */
	readonly namespaces: string[] = [];

	/**
	 * Whether tracing has been enabled on this compute — flipped by
	 * {@link enableTracing}. Private so it can't be set independently of the
	 * infra; read internally by {@link dashboardSection} to decide whether to
	 * render the traces section.
	 */
	private tracerEnabled = false;

	/** Read-only view of {@link tracerEnabled} for subclasses (e.g. to guard
	 * their `tracingWidgets` builder). Subclasses can read but not set it. */
	protected get isTracerEnabled(): boolean {
		return this.tracerEnabled;
	}

	constructor(id: string, options?: ScopeOptions) {
		super(id, options);
		// Self-register on the owning stack so finalize steps (tracing, routing,
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
	 * Enable distributed tracing on this compute: mark it traced (so the Dashboard
	 * renders its traces section) and turn on the compute's active tracing via
	 * {@link applyTracing}. Idempotent — the framework calls this on **every**
	 * compute when the app contains a `Tracer` (tracing is presence-gated, not
	 * per-compute), so calling it more than once is a no-op.
	 */
	enableTracing(): void {
		if (this.tracerEnabled) return;
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
	 * Build this compute's CloudWatch Dashboard section: health widgets and log
	 * widgets **always** (logs are always captured for a compute), plus trace
	 * widgets **only when** tracing is enabled on this compute (via
	 * {@link enableTracing}).
	 *
	 * This is the single public entry the Dashboard Building Block uses; the
	 * per-kind builders below are `protected`. Whether the logs / traces sections
	 * are actually shown is a display choice the Dashboard makes on top (its
	 * `logs` / `traces` options) — this returns what the compute *has*.
	 *
	 * @param region - AWS region the widgets query metrics in.
	 */
	dashboardSection(region: string): ComputeDashboardSection {
		return {
			// The scope id (e.g. 'DefaultCompute', 'api') — short and readable for a
			// section header, and distinct per compute within a stack.
			label: this.id,
			health: this.healthWidgets(region),
			logging: this.loggingWidgets(region),
			tracing: this.tracerEnabled ? this.tracingWidgets(region) : undefined,
		};
	}

	/**
	 * Build this compute's health widget rows. Implemented by a concrete compute;
	 * obtained only via {@link dashboardSection}.
	 */
	protected abstract healthWidgets(region: string): IWidget[][];

	/**
	 * Build this compute's **log** widget rows for its own log group. Logs always
	 * exist, so this is always available; the Dashboard's `logs` option decides
	 * whether to render it.
	 */
	protected abstract loggingWidgets(region: string): IWidget[][];

	/**
	 * Build this compute's **trace** widget rows. Gated behind
	 * {@link dashboardSection} so it is only used when tracing is enabled.
	 */
	protected abstract tracingWidgets(region: string): IWidget[][];
}

/**
 * A compute's self-reported CloudWatch Dashboard section. `health` and `logging`
 * are always present; `tracing` is populated only when tracing is enabled on the
 * compute. (The Dashboard may still hide `logging` / `tracing` via its display
 * options.)
 */
export interface ComputeDashboardSection {
	/** Display label used as the compute's group header. */
	label: string;
	/** Health widget rows — always present. */
	health: IWidget[][];
	/** Log widget rows — always present (logs are always captured). */
	logging?: IWidget[][];
	/** Trace widget rows — present only when tracing is enabled. */
	tracing?: IWidget[][];
}
