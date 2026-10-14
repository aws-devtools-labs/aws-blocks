// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { RemovalPolicy } from 'aws-cdk-lib';
import type { IManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { BlocksVpcOptions } from './vpc-types.js';

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
	 * core shared REST API stage and the `bb-realtime` WebSocket stage. Protects
	 * the backend from runaway clients and caps blast radius.
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

	/**
	 * Place the app's compute and VPC-resident resources in a VPC. Pass a
	 * standard CDK VPC — Blocks handles Lambda placement, endpoint provisioning
	 * (based on which Building Blocks are in scope), and security-group wiring.
	 *
	 * Omit for no VPC (the preset default — Lambda runs in the AWS-managed
	 * network). A Building Block that can't function without a VPC causes Blocks
	 * to derive one on demand even when this is unset.
	 */
	vpc?: BlocksVpcOptions;

	/**
	 * An IAM **permissions boundary** attached to every IAM role AWS Blocks
	 * creates for this stack/backend — the shared execution role every handler
	 * runs as, block-owned helper roles (migration, Bedrock, scheduler, …), the
	 * CDK custom-resource / `BucketDeployment` / log-retention roles a block
	 * causes, and `Hosting`'s roles (including Lambda@Edge roles in the
	 * `us-east-1` edge stack).
	 *
	 * A boundary is a **ceiling, never a grant**: a role's effective permissions
	 * are the intersection of its own policies and the boundary. Blocks still
	 * grants each role what it needs; anything the boundary doesn't allow is
	 * denied at runtime (`AccessDenied`), however it was granted.
	 *
	 * Use it when the deploy is governed centrally — e.g. a platform that lets
	 * many teams (or AI coding agents) ship apps through one pipeline can require,
	 * via an `iam:PermissionsBoundary` condition on its CloudFormation execution
	 * role, that every role an app creates carries the platform's boundary. That
	 * only works if **every** role carries it, which this option provides. Leave it
	 * unset otherwise: it is unset in both {@link BlocksPresets}, and unset leaves
	 * synthesized templates unchanged.
	 *
	 * Accepted forms:
	 * - a customer-managed policy **name** (`'app-boundary'`), resolved in the
	 *   deploying account and partition;
	 * - a full policy **ARN** (`'arn:aws:iam::123456789012:policy/platform/app-boundary'`),
	 *   required when the policy has a path;
	 * - an `iam.IManagedPolicy`.
	 * Anything else fails synth with an actionable error.
	 *
	 * **Scope.** On a `BlocksStack` it applies to every role in the stack. On an
	 * embedded `BlocksBackend` it applies to the backend's subtree plus the
	 * stack-level CDK singleton roles its blocks add; roles your own stack
	 * already had are not touched. Stacks Blocks doesn't create are out of scope
	 * — apply a boundary to those yourself with
	 * `iam.PermissionsBoundary.of(stack).apply(policy)`.
	 *
	 * **Interaction with CDK's `@aws-cdk/core:permissionsBoundary` context.**
	 * The context applies a boundary to every role in every stack of the app.
	 * When both are set, this option wins for the roles AWS Blocks creates (the
	 * context still applies everywhere else), and synth emits a warning. Either
	 * one alone bounds every Blocks role.
	 *
	 * It caps the blast radius of the shared role; it doesn't split it — every
	 * Blocks handler still runs as the same role, under the same boundary.
	 *
	 * @example Cap every Blocks role with a platform-owned boundary policy
	 * ```ts
	 * export const blocksStack = await BlocksStack.create(app, 'my-app', {
	 *   backendHandlerPath: join(__dirname, 'index.handler.ts'),
	 *   backendCDKPath: join(__dirname, 'index.ts'),
	 *   defaults: { ...BlocksPresets.production, permissionsBoundary: 'my-app-boundary' },
	 * });
	 * ```
	 */
	permissionsBoundary?: string | IManagedPolicy;
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
