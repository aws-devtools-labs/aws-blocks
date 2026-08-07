// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

const HARDENING_KEY = Symbol.for('BLOCKS_HARDENING_DEFAULTS');

/**
 * Stack-wide infrastructure-hardening defaults, shared by every Building Block.
 *
 * Building Blocks provision AWS resources (Lambdas, API Gateways, DynamoDB
 * tables, …) that each need the same class of security/durability settings —
 * log retention, API throttling, point-in-time recovery, and so on. Rather than
 * have every block reinvent (and inconsistently name) these knobs, blocks read
 * a single stack-level default and let a per-block option override it.
 *
 * Resolution order for any one value is, from lowest to highest precedence:
 *
 *   framework secure default  <  stack-level `hardening` prop  <  per-block option
 *
 * i.e. `perBlockOption ?? stackDefault.field ?? FRAMEWORK_DEFAULT`. A block
 * never has to opt in to get a safe value, a whole app can be retuned in one
 * place via `BlocksStack`/`BlocksBackend`'s `hardening` prop, and a single
 * block can still override locally when it has a good reason.
 *
 * All fields are optional; omitted fields fall back to {@link FRAMEWORK_HARDENING_DEFAULTS}.
 */
export interface HardeningDefaults {
	/**
	 * CloudWatch log retention applied to log groups that blocks create
	 * explicitly (e.g. API Gateway access logs). Without a default, Lambda /
	 * API log groups are created by AWS with **infinite** retention, which
	 * accrues cost indefinitely. Defaults to {@link RetentionDays.ONE_MONTH}
	 * — the value already used by the hosting compute construct and bb-logger.
	 */
	logRetention?: RetentionDays;

	/**
	 * Default request throttling applied to API Gateway stages that blocks
	 * create (REST and WebSocket). Protects every request entry point from a
	 * single misbehaving client driving unbounded volume. Defaults to
	 * `{ rateLimit: 100, burstLimit: 200 }`.
	 */
	apiThrottle?: {
		/** Steady-state requests/second sustained across the stage. */
		rateLimit?: number;
		/** Token-bucket burst depth (max concurrent requests). */
		burstLimit?: number;
	};

	/**
	 * Whether API Gateway stages emit structured access logs to a CloudWatch
	 * log group. Off by default at AWS; without logs a stage has zero request
	 * observability. Defaults to `true`.
	 */
	apiAccessLogs?: boolean;

	/**
	 * Whether DynamoDB tables that blocks create enable point-in-time recovery
	 * (continuous backups, 35-day restore window). Not enabled by DynamoDB by
	 * default. Defaults to `true` on production and `false` in sandbox mode
	 * (sandbox tables are disposable, and PITR adds cost).
	 */
	pointInTimeRecovery?: boolean;
}

/**
 * Framework secure defaults — the floor every block gets when neither a
 * stack-level `hardening` prop nor a per-block option is supplied.
 *
 * `pointInTimeRecovery` is intentionally left undefined here because its safe
 * value is sandbox-dependent; resolve it with {@link resolvePointInTimeRecovery}.
 */
export const FRAMEWORK_HARDENING_DEFAULTS = {
	logRetention: RetentionDays.ONE_MONTH,
	apiThrottle: { rateLimit: 100, burstLimit: 200 },
	apiAccessLogs: true,
} as const;

/**
 * Register the stack-wide hardening defaults. Called once by
 * `BlocksStack.create` / `BlocksBackend.create` from the `hardening` prop,
 * before the app's blocks are constructed, so any block can read it.
 *
 * Stored on the stack instance under a `Symbol.for` key — the same
 * stack-scoped, synth-time storage pattern used by the config registry.
 */
export function registerStackHardeningDefaults(scope: Construct, defaults: HardeningDefaults | undefined): void {
	if (!defaults) return;
	const stack = cdk.Stack.of(scope);
	(stack as unknown as Record<symbol, unknown>)[HARDENING_KEY] = defaults;
}

/**
 * Read the stack-wide hardening defaults for the stack that owns `scope`.
 * Returns an empty object when none were registered, so callers can always
 * safely read fields off the result.
 *
 * A block resolves an effective value as, e.g.:
 * ```ts
 * const d = getStackHardeningDefaults(this);
 * const retention = options?.logRetention
 *   ?? d.logRetention
 *   ?? FRAMEWORK_HARDENING_DEFAULTS.logRetention;
 * ```
 */
export function getStackHardeningDefaults(scope: Construct): HardeningDefaults {
	const stack = cdk.Stack.of(scope);
	return (
		((stack as unknown as Record<symbol, unknown>)[HARDENING_KEY] as HardeningDefaults | undefined) ?? {}
	);
}

/** True when the stack is being synthesized in sandbox mode. */
function isSandbox(scope: Construct): boolean {
	const ctx = cdk.Stack.of(scope).node.tryGetContext('sandboxMode');
	return ctx === 'true' || ctx === true;
}

/**
 * Resolve the effective log retention for a block, honoring (highest first)
 * the per-block option, the stack-level default, then the framework default.
 */
export function resolveLogRetention(scope: Construct, perBlock?: RetentionDays): RetentionDays {
	return perBlock ?? getStackHardeningDefaults(scope).logRetention ?? FRAMEWORK_HARDENING_DEFAULTS.logRetention;
}

/**
 * Resolve the effective API throttle settings for a block. Per-field
 * precedence (per-block option → stack default → framework default) so a
 * caller can override just the rate or just the burst.
 */
export function resolveApiThrottle(
	scope: Construct,
	perBlock?: { rateLimit?: number; burstLimit?: number },
): { rateLimit: number; burstLimit: number } {
	const stackDefault = getStackHardeningDefaults(scope).apiThrottle;
	return {
		rateLimit:
			perBlock?.rateLimit ?? stackDefault?.rateLimit ?? FRAMEWORK_HARDENING_DEFAULTS.apiThrottle.rateLimit,
		burstLimit:
			perBlock?.burstLimit ?? stackDefault?.burstLimit ?? FRAMEWORK_HARDENING_DEFAULTS.apiThrottle.burstLimit,
	};
}

/**
 * Resolve whether API access logging is enabled, honoring the per-block
 * option, the stack-level default, then the framework default (`true`).
 */
export function resolveApiAccessLogs(scope: Construct, perBlock?: boolean): boolean {
	return perBlock ?? getStackHardeningDefaults(scope).apiAccessLogs ?? FRAMEWORK_HARDENING_DEFAULTS.apiAccessLogs;
}

/**
 * Resolve whether a DynamoDB table should enable point-in-time recovery. The
 * framework default is sandbox-dependent (on in production, off in sandbox),
 * so this is resolved here rather than as a static constant.
 */
export function resolvePointInTimeRecovery(scope: Construct, perBlock?: boolean): boolean {
	return perBlock ?? getStackHardeningDefaults(scope).pointInTimeRecovery ?? !isSandbox(scope);
}
