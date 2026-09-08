// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { RemovalPolicy } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

/**
 * Request-rate limits applied to an API Gateway stage. On a REST API these are
 * requests/second; on a WebSocket API the unit is messages/second across the
 * connection. `rateLimit` is the steady-state ceiling and `burstLimit` the
 * token-bucket size for short spikes.
 */
export interface BlocksThrottling {
	/** Steady-state request (or WebSocket message) rate ceiling, per second. */
	rateLimit: number;
	/** Token-bucket burst size for short spikes above `rateLimit`. */
	burstLimit: number;
}

/**
 * Default values for every Amazon-authored Building Block created within a
 * `BlocksStack` or `BlocksBackend`. A per-block option always overrides the
 * corresponding default (`option ?? scope.defaults.field`).
 *
 * Start from {@link BlocksPresets} and override individual fields as needed.
 */
export interface BlocksDefaults {
	/**
	 * What happens to a stateful resource (table, bucket, user pool) when the
	 * stack is deleted, via CDK/CloudFormation: `RETAIN` keeps the resource (and
	 * its data) behind; `DESTROY` tears it down. Applies only to CDK/CloudFormation
	 * deletions.
	 */
	removalPolicy: RemovalPolicy;

	/**
	 * Whether to block deletion of a stateful resource. Unlike `removalPolicy`,
	 * this guards against deletion through **any** path — CDK/CloudFormation as
	 * well as the CLI, API, and AWS console — until it is turned off.
	 */
	deletionProtection: boolean;

	/**
	 * CORS origins the compute's API accepts, as regular-expression patterns
	 * matched against the request `Origin` header. Empty means no cross-origin
	 * requests are allowed. The `sandbox` preset allows localhost so a local dev
	 * frontend can reach a deployed API; `production` allows none by default.
	 */
	allowedOrigins: string[];

	/**
	 * Whether stateful resources that support continuous backups keep them on by
	 * default — e.g. DynamoDB Point-in-Time Recovery, letting you restore to any
	 * second in the retention window. On in `production`, off in `sandbox` (where
	 * throwaway data isn't worth the backup-storage cost). Blocks whose service
	 * has no equivalent simply ignore it.
	 *
	 * `true` enables backups with the service's default window; `false` disables
	 * them; `{ retentionDays: n }` enables them and pins the window (a block
	 * clamps/validates `n` to its service's supported range — DynamoDB PITR is
	 * 1–35 days). Backups only have a window when on, so the two are one field.
	 */
	pointInTimeRecovery: boolean | { retentionDays: number };

	/**
	 * How long CloudWatch Logs keeps log events written by Blocks-managed log
	 * groups (the core handler Lambda, migration/GSI Lambdas, hosting compute,
	 * `bb-logger`, and API Gateway access logs) before expiring them. Without a
	 * retention set, AWS keeps log events forever, which grows cost unbounded —
	 * every Blocks-managed log group reads this default so retention is applied
	 * consistently.
	 */
	logRetention: RetentionDays;

	/**
	 * Request-rate limits applied to every Blocks-managed API Gateway stage: the
	 * core REST API, the SSR/hosting REST API, and the `bb-realtime` WebSocket
	 * stage. Protects the backend from runaway clients and caps blast radius.
	 * The sandbox preset caps tighter (200/400) than production (1000/2000) so a
	 * disposable stack is well-protected without throttling real production
	 * traffic. See {@link BlocksThrottling}.
	 */
	throttling: BlocksThrottling;

	/**
	 * Whether to emit structured JSON access logs from every Blocks-managed API
	 * Gateway stage to a dedicated CloudWatch log group (retention follows
	 * {@link logRetention}).
	 *
	 * **Off by default in both presets** — opt in with a per-stack override
	 * (`defaults: { ...BlocksPresets.production, accessLogging: true }`). It is
	 * off by default (rather than on for production) because enabling it
	 * provisions the account-level API Gateway CloudWatch Logs role, which is an
	 * account/region-level singleton: a second Blocks stack in the same
	 * account+region that also enables access logging can repoint that role on
	 * deploy or, on teardown, leave the survivor's access logging broken.
	 * Enabling it is therefore safe for **one Blocks stack per region** — see
	 * `ensureApiGatewayAccount` for the full multi-stack teardown caveat.
	 */
	accessLogging: boolean;
}

/**
 * Prepared starting points for {@link BlocksDefaults}. Pick one and override
 * individual fields with a spread:
 *
 * ```ts
 * defaults: { ...BlocksPresets.production, deletionProtection: false }
 * ```
 */
export const BlocksPresets = {
	/** Disposable development stacks: tear down cleanly, no delete guard, no backups. */
	sandbox: {
		removalPolicy: RemovalPolicy.DESTROY,
		deletionProtection: false,
		allowedOrigins: ['^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$'],
		pointInTimeRecovery: false,
		logRetention: RetentionDays.ONE_WEEK,
		throttling: { rateLimit: 200, burstLimit: 400 },
		accessLogging: false,
	},
	/**
	 * Durable, protected posture for permanent deployments. A higher throttle
	 * ceiling (1000/2000) than sandbox so the default doesn't 429 real
	 * production traffic — raise it via a per-stack `throttling` override for
	 * higher-volume APIs.
	 */
	production: {
		removalPolicy: RemovalPolicy.RETAIN,
		deletionProtection: true,
		allowedOrigins: [],
		pointInTimeRecovery: true,
		logRetention: RetentionDays.ONE_YEAR,
		throttling: { rateLimit: 1000, burstLimit: 2000 },
		// Off by default even in production: enabling access logging mutates the
		// account/region-level API Gateway CloudWatch role (a singleton). Opt in
		// per stack once you've confirmed a single Blocks stack owns it in the
		// region — see the `accessLogging` field doc.
		accessLogging: false,
	},
} satisfies Record<string, BlocksDefaults>;
