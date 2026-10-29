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
	 *
	 * Because a durable deployment then has no request-level audit trail, a
	 * **synth-time warning** is emitted whenever the resolved `defaults` combine a
	 * durable removal policy (any {@link removalPolicy} other than
	 * `RemovalPolicy.DESTROY`) with access logging off, so the tradeoff is visible
	 * at `cdk synth`. It is a warning only — synth does not fail (unless you run
	 * `cdk synth`/`deploy --strict`, which treats warnings as errors — opt in or
	 * acknowledge it as below) — and clears once you opt in with the override
	 * above. If leaving it off is a deliberate choice (for example a multi-stack
	 * deployment where another stack owns access logging), acknowledge the warning
	 * by calling
	 * `Annotations.of(stack).acknowledgeWarning('blocks:apigateway:access-logging-disabled')`
	 * on the stack or backend returned by `create()`, after it resolves
	 * (acknowledging on the `App` before `create()` does not suppress it).
	 *
	 * This governs **API Gateway** access logging only. The shared framework config
	 * bucket (`BlocksConfigBucket`) always ships S3 server access logs to a dedicated
	 * log bucket on every stack (including sandbox), independent of this field — it
	 * has no account/region-level singleton like the API Gateway CloudWatch role, so
	 * always-on carries no multi-stack hazard there. See `ensureConfigBucket` in
	 * `config-registry.ts`.
	 *
	 * `FileBucket` also falls back to this field for its S3 server access logs
	 * when {@link storageAccessLogging} is unset; set that field to control the
	 * two independently.
	 */
	accessLogging: boolean;

	/**
	 * Whether every Blocks-provisioned `FileBucket` ships S3 server access logs to
	 * a dedicated, locked-down log bucket (expired after {@link logRetention}). A
	 * per-block `accessLogging` option always wins.
	 *
	 * Optional and **unset in both presets**: when omitted, `FileBucket` falls
	 * back to {@link accessLogging}, so existing stacks keep their behaviour. Set
	 * it to turn S3 access logging on (or off) stack-wide without touching API
	 * Gateway access logging — S3 server access logging has no
	 * account/region-level singleton, so enabling it carries none of the
	 * multi-stack hazard described on {@link accessLogging}:
	 *
	 * ```ts
	 * defaults: { ...BlocksPresets.production, storageAccessLogging: true }
	 * ```
	 *
	 * Each logged bucket adds one log bucket (S3 storage for the logs; no
	 * per-request logging charge).
	 */
	storageAccessLogging?: boolean;

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
	 * **One policy for many apps.** A platform can share a single boundary policy
	 * across every app in an account by writing it with policy variables, e.g.
	 * `arn:aws:ssm:*:*:parameter/${aws:PrincipalTag/app}-*`, and tagging each
	 * app's stack with its `app` name — {@link app} does the tagging, and the
	 * `blocks-iam-policies` CLI generates such a policy. The policy (by name, ARN or
	 * `IManagedPolicy`) is referenced as-is; Blocks never rewrites its document.
	 * The synth-time IAM report lists every Blocks role with its boundary and tags,
	 * so a pipeline can check both. See the core README section "Running many apps
	 * in one AWS account".
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

	/**
	 * The identity of this app on a **shared app platform**: one AWS account that
	 * hosts many independently written apps (often written by AI coding agents)
	 * and deploys them through one pipeline. Unset in both {@link BlocksPresets};
	 * unset leaves synthesized templates unchanged.
	 *
	 * When set, AWS Blocks:
	 * - tags every resource it creates, and every IAM role (including roles in
	 *   helper stacks such as the `us-east-1` edge stack), with
	 *   `app=<id>` ({@link BLOCKS_APP_TAG_KEY}), at a priority above the default
	 *   `Tags.of(...).add()` (an app can still raise its own priority or remove the
	 *   tag, so the platform's execution role rejects any role not tagged `<id>`);
	 * - checks that every name it derives starts with the app's id. Building Block
	 *   resource names (tables, queues, buckets, parameters, schedules, user
	 *   pools) come from each block's `fullId`, which starts with the stack's id,
	 *   and CloudFormation-generated names (functions, roles) start with the stack
	 *   name — so the stack must be named `<id>` or `<id>-…`;
	 * - adds an `app` section and a `violations` list to the synth-time IAM report
	 *   (`cdk.out/<stack>.blocks-iam.json`): a role without the permissions
	 *   boundary or the app tag, a grant on another app's resources, a wildcard
	 *   grant on a data service, an "everything except" grant, a resource the check
	 *   can't resolve, a resource policy that opens up another app's resource, a
	 *   role that trusts anything but an AWS service, a broad AWS managed policy, the
	 *   CDK asset bucket of another bootstrap, or a name outside the app's prefix;
	 * - with `strict: true`, fails synth on any violation.
	 *
	 * The report and `strict` are fast feedback, not the security boundary: the
	 * app's own code runs at synth. The boundary is IAM, enforced by AWS — a
	 * permissions boundary keyed on the `app` tag ({@link permissionsBoundary})
	 * a per-app CloudFormation execution role that only creates bounded roles
	 * tagged as this app, and a deploy guard that keeps the app's deploy role on
	 * its own stacks. Each app has its own CDK bootstrap, with the app id as its
	 * qualifier. `blocks-iam-policies` generates the three policies, and
	 * `blocks-iam-check` re-checks the synthesized templates in a pipeline. See the
	 * core README section "Running many apps in one AWS account".
	 *
	 * @example A platform's app template
	 * ```ts
	 * export const blocksStack = await BlocksStack.create(app, process.env.APP_ID!, {
	 *   backendHandlerPath: join(__dirname, 'index.handler.ts'),
	 *   backendCDKPath: join(__dirname, 'index.ts'),
	 *   defaults: {
	 *     ...BlocksPresets.production,
	 *     app: { id: process.env.APP_ID! },
	 *     permissionsBoundary: 'apps-boundary',
	 *   },
	 * });
	 * ```
	 */
	app?: BlocksAppIdentity;
}

/** The tag key AWS Blocks stamps with {@link BlocksAppIdentity.id} on every resource and role. */
export const BLOCKS_APP_TAG_KEY = 'app';

/**
 * An app's identity on a shared app platform. See {@link BlocksDefaults.app}.
 */
export interface BlocksAppIdentity {
	/**
	 * The app's id: 1–10 characters, lowercase letters and digits, starting with
	 * a letter (`/^[a-z][a-z0-9]{0,9}$/`). No hyphen, so one app's name prefix
	 * (`<id>-`) can never match another app's resources (`appa-*` doesn't match
	 * `appab-…`). Lowercase so it is valid in S3 bucket names. At most 10
	 * characters, CDK's limit for a bootstrap qualifier, so the id is also the
	 * app's qualifier: one bootstrap per app, and no two apps share one.
	 *
	 * Some ids are reserved, because the app's `<id>-…` / `<id>/…` names would
	 * include names other apps, AWS Blocks, CDK or AWS share: `cdk` (every app's
	 * CDK bootstrap, `cdk-<qualifier>-…`, and CDK's `/cdk/…` parameters), `blocks`,
	 * `secrets` and `config` (Hosting's `secret()` / `config()` values under
	 * `blocks/…`), `amplify`, `cf`, `sagemaker` (those services' own buckets and
	 * stacks), the region prefixes `af`, `ap`, `ca`, `cn`, `eu`, `eusc`, `il`,
	 * `me`, `mx`, `sa`, `us` (CDK names CloudFront Functions `<region>…`), and any
	 * id starting with `aws` or `ssm` (names AWS reserves). Synth,
	 * `blocks-iam-policies` and `blocks-iam-check` reject them, saying why.
	 *
	 * Set it from the platform's pipeline (e.g. `process.env.APP_ID`), not from a
	 * value the app's code chooses, and have the pipeline confirm it with
	 * `blocks-iam-check --app <id>`.
	 */
	id: string;

	/**
	 * Fail synth when the IAM report lists any violation, instead of only writing
	 * them to the report and printing a summary.
	 * @default false
	 */
	strict?: boolean;
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
