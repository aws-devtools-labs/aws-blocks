// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Re-export everything from core
export * from '@aws-cdk-blocks/core';

// Override core's untyped getSdkIdentifiers with typed overloads
export { getSdkIdentifiers } from './sdk-identifiers.js';

import { BB_NAME, BB_VERSION } from '@aws-cdk-blocks/bb-lambda-compute/version';
import { Scope } from '@aws-cdk-blocks/core';

Scope._setDefaultBlockForTelemetry(BB_NAME, BB_VERSION);

// ─── Building Block Re-exports ───────────────────────────────────────────────
//
// Each export below includes a brief summary of what the Building Block does
// and when to use it. For full documentation (API reference, examples, best
// practices, scaling characteristics), print the block's docs bundled in this
// package with `npm run docs <package>`, where `<package>` is the
// name in each JSDoc block without the `@aws-cdk-blocks/` scope (e.g.
// `npm run docs bb-kv-store`). `npm run docs` lists them all.
//

/**
 * **Shared auth interfaces and UI components for all CDK Blocks auth Building Blocks.**
 *
 * Provides the `BlocksAuth` interface (implemented by every auth BB), auth state
 * types, and framework-agnostic UI components (`Authenticator`, `AuthenticatedContent`,
 * `onAuthChange`). Import these when writing provider-agnostic auth code.
 *
 * Package: `@aws-cdk-blocks/auth-common`
 * Full docs: `npm run docs auth-common`.
 */
export type {
	AuthAction,
	AuthActionInput,
	AuthField,
	AuthState,
	AuthUser,
	AuthUserOf,
	BlocksAuth,
} from '@aws-cdk-blocks/auth-common';
export type {
	AgentConfig,
	AgentResult,
	AgentStreamChunk,
	AgentTool,
	DefaultToolContext,
	ModelConfig,
	StreamOptions,
	TokenUsage,
	ToolCallRecord,
	ToolDefinition,
	ToolFactory,
	ToolHandlerArgs,
	ToolsConfig,
} from '@aws-cdk-blocks/bb-agent';
/**
 * **AI agent with streaming, tool calling, and conversation persistence.**
 *
 * Use for building conversational AI experiences: chatbots, copilots, data
 * extraction, or any LLM-powered feature. Supports Bedrock, OpenAI-compatible,
 * and CannedProvider (local dev). Tools defined with Zod schemas. Conversation
 * history persisted to DynamoDB. Streaming via AsyncJob + Realtime.
 * Set `inferenceOnly: true` for simple prompt→response without persistence.
 *
 * Package: `@aws-cdk-blocks/bb-agent`
 * Full docs: `npm run docs bb-agent`.
 */
export { Agent, AgentErrors, BedrockModels, OllamaModels } from '@aws-cdk-blocks/bb-agent';
export type { AppSettingOptions } from '@aws-cdk-blocks/bb-app-setting';
/**
 * **Single application configuration value backed by SSM Parameter Store.**
 *
 * Use for non-sensitive config — feature flags, API URLs, thresholds, or
 * structured config objects. `secret: true` stores the value encrypted at rest,
 * a free fallback for a low-value secret; for a production secret (API keys,
 * OAuth secrets, connection strings) prefer `Secret`, the recommended home for
 * credentials. Each instance maps to exactly one SSM parameter. Supports schema
 * validation for typed objects.
 *
 * Package: `@aws-cdk-blocks/bb-app-setting`
 * Full docs: `npm run docs bb-app-setting`.
 */
export { AppSetting, AppSettingErrors } from '@aws-cdk-blocks/bb-app-setting';
export type {
	AsyncJobBaseOptions,
	AsyncJobContext,
	AsyncJobOptions,
	AsyncJobState,
	AsyncJobStatus,
	AsyncJobTransition,
	BatchSubmitResult,
	SubmitOptions,
	WaitUntilCompleteOptions,
} from '@aws-cdk-blocks/bb-async-job';
/**
 * **Background job processing backed by SQS, run on Lambda or a container.**
 *
 * Use for fire-and-forget async work: sending emails, processing uploads,
 * generating reports, or any task that shouldn't block an API response. Runs on
 * the app's default serverless compute, or assign a container `Compute` (Fargate)
 * for long-running or high-memory jobs. Supports single and batch submission (up
 * to 10,000 per call), optional delay, schema validation, and automatic retries
 * with dead-letter queue.
 *
 * Package: `@aws-cdk-blocks/bb-async-job`
 * Full docs: `npm run docs bb-async-job`.
 */
export { AsyncJob, AsyncJobErrors } from '@aws-cdk-blocks/bb-async-job';
export type * from '@aws-cdk-blocks/bb-auth';
/**
 * **Authentication — email + password, social sign-in, OIDC and SAML in one block.**
 *
 * Use for any sign-in: email + password backed by a Cognito user pool (MFA,
 * passkeys, groups + `requireRole`, the opt-in `auth.admin` surface), social
 * and SAML providers federated through Cognito, and OIDC / OAuth 2.0 providers
 * federated directly by your backend (no user pool needed). One options object
 * configures every mechanism, and methods your configuration doesn't support
 * don't compile. Runs locally with no AWS account; `stubIdp()` is an offline
 * identity provider for development. Replaces `AuthBasic`, `AuthCognito` and
 * `AuthOIDC`.
 *
 * Package: `@aws-cdk-blocks/bb-auth`
 * Full docs: `npm run docs bb-auth`.
 *
 * @see {@link BlocksAuth} for the provider-agnostic auth interface all auth BBs implement.
 */
export { Auth, AuthErrors, customOauth2, github, isAuthError, relayOrigin, stubIdp } from '@aws-cdk-blocks/bb-auth';
/**
 * **`Compute` — choose where a workload runs by stating its type.**
 *
 * Construct a `Compute` with an explicit `type` (`'serverless'` | `'container'`)
 * and that type's options; CDK Blocks maps the type to the AWS service that backs it
 * (`serverless` → Lambda, `container` → Fargate) — the service name never appears
 * in your code. Options are a discriminated union on `type`, so an attribute that
 * doesn't apply to the chosen type is a compile error. Hand the result to a
 * handler-bearing block via its `compute` option (e.g. `AsyncJob`); omit it and
 * the workload uses the app default (serverless).
 *
 * Package: `@aws-cdk-blocks/bb-compute`
 * Full docs: `npm run docs bb-compute`.
 */
export { Compute, type ComputeProps } from '@aws-cdk-blocks/bb-compute';
export type { CronJobEvent, CronJobOptions } from '@aws-cdk-blocks/bb-cron-job';
/**
 * **Scheduled task execution backed by EventBridge Scheduler and Lambda.**
 *
 * Use for recurring jobs: cleanup, report generation, data syncs, cache
 * warming, periodic health checks. Supports cron and rate expressions,
 * IANA timezones, and typed static input. No runtime methods — the
 * constructor defines the schedule and handler.
 *
 * Package: `@aws-cdk-blocks/bb-cron-job`
 * Full docs: `npm run docs bb-cron-job`.
 */
export { CronJob, CronJobErrors } from '@aws-cdk-blocks/bb-cron-job';
export type {
	DashboardOptions,
	MetricConfig,
	MetricsBBRef,
	MetricsSource,
} from '@aws-cdk-blocks/bb-dashboard';
/**
 * **Auto-generated CloudWatch Dashboard for application observability.**
 *
 * Use when you want a single URL to view application health after deployment.
 * The dashboard is organized by compute: each renders a health section plus
 * logs (always captured) and traces (when the app contains a Tracer). Pass
 * `metrics` for app-wide custom-metric widgets, and toggle sections with the
 * `logs` / `traces` options.
 *
 * Package: `@aws-cdk-blocks/bb-dashboard`
 * Full docs: `npm run docs bb-dashboard`.
 */
export { Dashboard, DashboardErrors } from '@aws-cdk-blocks/bb-dashboard';
export type {
	ClusterKind,
	ClusterType,
	ConnectionStringSource,
	DataApiOptions,
	DatabaseClusterOptions,
	DatabaseOptions,
	ExistingClusterOptions,
	ExistingClusterRef,
	LegacyDatabaseClusterOptions,
	ScopedDatabase,
	SqlQuery,
	Transaction,
	TransactionOptions,
} from '@aws-cdk-blocks/bb-database';
/**
 * **SQL database on PostgreSQL.**
 *
 * Use when you need multi-table JOINs, SQL transactions or aggregations. For
 * most application data, prefer `KVStore` (lower cost, simpler ops).
 * `new Database(scope, id)` owns an Aurora DSQL cluster. To use Aurora
 * PostgreSQL Serverless v2 (express configuration), or to put several
 * databases on one cluster, pass a `DatabaseCluster` as `cluster`. For a
 * PostgreSQL database that already exists, pass `DatabaseCluster.fromExisting()`.
 * Migrations are ordered `.sql` files in `cdk-blocks/migrations/<id>/`.
 *
 * Package: `@aws-cdk-blocks/bb-database`
 * Full docs: `npm run docs bb-database`.
 */
export { Database, DatabaseCluster, DatabaseErrors, sql } from '@aws-cdk-blocks/bb-database';
/**
 * **The Aurora cluster of `Database` in `@aws-blocks/bb-data`, kept in the stack.**
 *
 * Use it only to move an app that deployed `Database` of `@aws-blocks/bb-data`
 * to `Database` of this package without a change to its cluster: give it the
 * id and the options of that `Database`, and pass it as the `cluster` of a
 * `Database` with a new id. For a new cluster, use `DatabaseCluster`.
 *
 * Package: `@aws-cdk-blocks/bb-database`
 * Full docs: `npm run docs bb-database`.
 *
 * @deprecated Only for an app that deployed `Database` of `@aws-blocks/bb-data`. The class is frozen and
 *   gets no new features. The steps are in the README section "Upgrade from `@aws-blocks/bb-data`".
 */
export { LegacyDatabaseCluster } from '@aws-cdk-blocks/bb-database';
export type { EmailMessage, EmailOptions, SendBatchResult, SendResult } from '@aws-cdk-blocks/bb-email-client';
/**
 * **Transactional email with AWS SES integration.**
 *
 * Use for sending transactional emails, password resets, confirmations,
 * notifications, and other one-to-one or bulk email. Supports single and
 * batch sending with partial failure handling.
 *
 * Package: `@aws-cdk-blocks/bb-email-client`
 * Full docs: `npm run docs bb-email-client`.
 */
export { EmailClient, EmailErrors } from '@aws-cdk-blocks/bb-email-client';
export type {
	CorsRule,
	ExternalBucketRef as FBExternalBucketRef,
	ExternalKmsKeyRef as FBExternalKmsKeyRef,
	FileBucketOptions,
	FileContent,
	FileInfo,
	GetUrlOptions,
	LifecycleRule,
	ObjectLockOptions,
	PutOptions as FBPutOptions,
	PutUrlOptions,
	ScanOptions as FBScanOptions,
} from '@aws-cdk-blocks/bb-file-bucket';
/**
 * **File storage backed by Amazon S3.**
 *
 * Use for storing, retrieving, and serving binary files — user uploads,
 * generated reports, images, videos, or static assets. Supports presigned
 * URLs for direct browser upload/download, batch deletion, and prefix-scoped
 * listing. For key-value data and queryable records with indexes, use
 * `KVStore`.
 *
 * Package: `@aws-cdk-blocks/bb-file-bucket`
 * Full docs: `npm run docs bb-file-bucket`.
 */
export { FileBucket, FileBucketErrors } from '@aws-cdk-blocks/bb-file-bucket';
export type {
	ChunkingConfig,
	ChunkingStrategy,
	KnowledgeBaseAgentTool,
	KnowledgeBaseAgentToolOptions,
	KnowledgeBaseAgentToolResult,
	KnowledgeBaseOptions,
	MetadataFilter,
	RetrieveOptions,
	RetrieveResult,
	SourceConfig,
	WaitUntilSyncedOptions,
} from '@aws-cdk-blocks/bb-knowledge-base';
/**
 * **Semantic document retrieval backed by Bedrock Knowledge Bases.**
 *
 * Use for RAG (retrieval-augmented generation), FAQ search, documentation
 * search, and any scenario where users need to query a corpus of documents
 * in natural language. Point it at a local `./knowledge` folder — subfolders
 * auto-populate `folder` metadata. In production, documents are synced to S3
 * and indexed via Bedrock with configurable chunking and embedding models.
 *
 * Package: `@aws-cdk-blocks/bb-knowledge-base`
 * Full docs: `npm run docs bb-knowledge-base`.
 */
export { KnowledgeBase, KnowledgeBaseErrors } from '@aws-cdk-blocks/bb-knowledge-base';
// A type keeps its own name. It gets the block prefix only when another block
// in this file exports a type with the same name (`PutOptions` and
// `ScanOptions` are also names of `FileBucket`).
export type {
	ConditionalDeleteOptions,
	ConditionalWriteOptions,
	Entry,
	ExternalKmsKeyRef,
	ExternalTableRef,
	GetOptions,
	IndexConfig,
	KeyConfig,
	KeyOf,
	KVStoreOptions,
	LegacyKVStoreDeleteOptions,
	LegacyKVStoreOptions,
	LegacyKVStorePutOptions,
	PutBatchEntry,
	PutOptions as KVPutOptions,
	QueryOptions,
	ReadValidationMode,
	Results,
	ScanOptions as KVScanOptions,
	SortCondition,
	ValueOf,
	Where,
} from '@aws-cdk-blocks/bb-kv-store';
/**
 * **Key-value and document storage backed by DynamoDB, with optional secondary indexes.**
 *
 * Default choice for most application data. With no options it is a
 * string-keyed store for caches, flags, sessions and user preferences. With a
 * `schema` and a `key` it holds records you list or query as a collection
 * (todos, orders, messages) with composite keys, range queries and batch
 * operations. Add `indexes` to read the same records by other fields. Supports
 * Zod and Valibot schemas for type-safe validation and conditional writes. Zero
 * cost at rest, scales automatically. Use `Database` when you need SQL
 * JOINs or transactions.
 *
 * Package: `@aws-cdk-blocks/bb-kv-store`
 * Full docs: `npm run docs bb-kv-store`.
 */
/**
 * **The store of `KVStore` release 0.4.0 or earlier, for an upgrade.**
 *
 * It has the data methods of that store over its table: `get`, `put`,
 * `delete`, and `scan`. Use it only to migrate the data of an app that has a
 * `KVStore` from release 0.4.0 or earlier: change the class on the line of the old
 * store, keep its id and its options, add a `KVStore` with a new id, and
 * migrate the data in your own code, however is appropriate for your app. For
 * new data, use `KVStore`.
 *
 * Package: `@aws-cdk-blocks/bb-kv-store`
 * Full docs: `npm run docs bb-kv-store`.
 *
 * @deprecated Only for the upgrade of a store from release 0.4.0 or earlier. The class is frozen: it has
 *   the methods of release 0.4.0 and gets no new features. Use `KVStore` for new data, and remove the
 *   `LegacyKVStore` when the data is in the new store. The steps are in the README section "Upgrade from release
 *   0.4.0 or earlier":
 *   https://github.com/aws-devtools-labs/aws-blocks/blob/main/packages/bb-kv-store/README.md#upgrade-from-release-040-or-earlier
 */
export { KVStore, KVStoreErrors, LegacyKVStore } from '@aws-cdk-blocks/bb-kv-store';
export type { ChildLogger, LogEntry, LoggingOptions, LogLevel } from '@aws-cdk-blocks/bb-logger';
/**
 * **Structured logging with consistent JSON format, log levels, and contextual metadata.**
 *
 * Use when you need structured, queryable application logs with consistent
 * format across your backend. Good for request logging, audit trails,
 * debugging context, and operational visibility. All methods are synchronous
 * (no await needed). Supports child loggers for request-scoped context.
 *
 * For numeric measurements over time, use `Metrics`. For distributed
 * request tracing, use `Tracing`.
 *
 * Package: `@aws-cdk-blocks/bb-logger`
 * Full docs: `npm run docs bb-logger`.
 */
export { Logger, LoggingErrors } from '@aws-cdk-blocks/bb-logger';
export type {
	EmitOptions,
	ExternalMetricsRef,
	MetricDatum,
	MetricResolution,
	MetricsEmitter,
	MetricsOptions,
	MetricUnit,
} from '@aws-cdk-blocks/bb-metrics';
/**
 * **Custom application metrics backed by Amazon CloudWatch (via EMF).**
 *
 * Use for tracking numeric measurements over time: request counts, error
 * rates, latency, queue depths, business KPIs. Metrics are emitted via
 * CloudWatch Embedded Metric Format — synchronous stdout writes with zero
 * latency impact. Supports dimensions, high-resolution (1s) metrics,
 * batch emission, and child emitters for scoped dimension inheritance.
 *
 * Package: `@aws-cdk-blocks/bb-metrics`
 * Full docs: `npm run docs bb-metrics`.
 */
export { Metrics, MetricsErrors } from '@aws-cdk-blocks/bb-metrics';
export type {
	DisconnectReason,
	GetChannelOptions,
	RealtimeChannel,
	RealtimeSubscription,
	SubscribeOptions,
} from '@aws-cdk-blocks/bb-realtime';
/**
 * **Real-time pub/sub messaging backed by AppSync Events.**
 *
 * Use for pushing data to connected browser clients: chat, notifications,
 * live dashboards, collaborative editing. Typed namespaces with schema
 * validation on publish. Local dev uses WebSocket bridge; production uses
 * AppSync Events API.
 *
 * Package: `@aws-cdk-blocks/bb-realtime`
 * Full docs: `npm run docs bb-realtime`.
 */
export { Realtime, RealtimeErrors } from '@aws-cdk-blocks/bb-realtime';
export type { SecretOptions, SecretReadOptions, SecretVersion, SecretVersionInfo } from '@aws-cdk-blocks/bb-secret';
/**
 * **Single application secret backed by AWS Secrets Manager.**
 *
 * Use for high-value credentials — third-party API keys, OAuth client secrets,
 * database connection strings, webhook signing keys, encryption keys. Each
 * instance maps to exactly one Secrets Manager secret with scoped read/write
 * IAM grants. `get()` returns `null` when unset; `put()` sets the value at
 * runtime. Supports an optional schema for typed JSON secrets, and
 * `Secret.fromExisting(arn)` to wrap a secret owned outside the stack.
 *
 * This is the recommended home for production secrets — any credential that
 * protects a production app. For non-sensitive configuration, use `AppSetting`
 * instead; `AppSetting` with `secret: true` is only a free, encrypted fallback
 * for a low-value secret (e.g. a prototype).
 *
 * Package: `@aws-cdk-blocks/bb-secret`
 * Full docs: `npm run docs bb-secret`.
 */
export { Secret, SecretErrors } from '@aws-cdk-blocks/bb-secret';
export type { AnnotationValue, Segment, TracerOptions } from '@aws-cdk-blocks/bb-tracer';
/**
 * **Distributed tracing backed by AWS X-Ray.**
 *
 * Use when you need to trace request flow across services, debug latency
 * issues, or visualize service dependencies. Wrap discrete units of work
 * (DB calls, HTTP requests, business logic) with `startSegment`. Use
 * annotations for searchable values and metadata for debugging data.
 *
 * Package: `@aws-cdk-blocks/bb-tracer`
 * Full docs: `npm run docs bb-tracer`.
 */
export { Tracer } from '@aws-cdk-blocks/bb-tracer';
export type {
	ComputeOptions,
	ComputeType,
	ContainerComputeOptions,
	ContainerScaling,
	ContainerSize,
	ScalingSignal,
	ServerlessComputeOptions,
} from '@aws-cdk-blocks/core';

// Blocks generated by `@aws-cdk-blocks/create-block` (contributor mode) are re-exported here.
// <!-- BEGIN:generated-block-exports -->
// <!-- END:generated-block-exports -->
