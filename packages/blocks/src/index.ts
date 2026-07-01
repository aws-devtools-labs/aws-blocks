// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Re-export everything from core
export * from '@aws-blocks/core';

// Override core's untyped getSdkIdentifiers with typed overloads
export { getSdkIdentifiers } from './sdk-identifiers.js';

// ─── Building Block Re-exports ───────────────────────────────────────────────
//
// Each export below includes a brief summary of what the Building Block does
// and when to use it. For full documentation (API reference, examples, best
// practices, scaling characteristics), read the README in the corresponding
// node_modules package listed in each JSDoc block.
//
// To locate a package README, try these paths in order:
//   1. node_modules/@aws-blocks/<package>/README.md          (hoisted)
//   2. node_modules/@aws-blocks/blocks/node_modules/@aws-blocks/<package>/README.md  (nested)
//   3. Glob: **/node_modules/@aws-blocks/<package>/README.md (fallback)
//   4. node -e "console.log(require.resolve('@aws-blocks/<package>/package.json').replace('/package.json',''))"  (last resort)
//

/**
 * **Username/password authentication with JWT sessions.**
 *
 * Use when you need simple credential-based auth for prototypes, internal
 * tools, or MVPs. Includes password hashing (bcrypt), HTTP-only cookie
 * sessions, optional email-confirmed signup, and password reset flows.
 *
 * Package: `@aws-blocks/bb-auth-basic`
 * Full docs: `README.md` in the package directory above.
 *
 * @see {@link BlocksAuth} for the provider-agnostic auth interface all auth BBs implement.
 */
export { AuthBasic, AuthBasicErrors, type AuthBasicUser, type AuthBasicOptions, type PasswordPolicy } from '@aws-blocks/bb-auth-basic';

/**
 * **Cognito authentication — username/password + MFA + groups.**
 *
 * Use for Cognito auth with MFA (SMS / TOTP / Email OTP), user pool groups +
 * role-based access control, custom attributes, and device tracking. Sessions
 * are opaque HMAC-signed cookies — Cognito tokens never reach the browser.
 *
 * For simple username/password without Cognito, use `AuthBasic`. For direct
 * OIDC (no Cognito), use `AuthOIDC`.
 *
 * Package: `@aws-blocks/bb-auth-cognito`
 * Full docs: `README.md` in the package directory above.
 *
 * @see {@link BlocksAuth} for the provider-agnostic auth interface all auth BBs implement.
 */
export { AuthCognito, AuthCognitoErrors } from '@aws-blocks/bb-auth-cognito';
export type {
	AuthCognitoOptions,
	AuthFlowType,
	CognitoUser,
	SignInOptions,
	SignInResult,
	SignInNextStep,
	ConfirmSignInOptions,
	SignUpOptions,
	SignUpResult,
	ResetPasswordResult,
	CodeDeliveryDetails,
	UpdateAttributeOutcome,
	MFAPreference,
	DeviceRecord,
	UserAttribute,
	ExternalUserPoolRef,
	CodeDeliveryFn,
} from '@aws-blocks/bb-auth-cognito';

/**
 * **OIDC sign-in gate for Google, GitHub, Okta, Cognito User Pools, and any
 * OIDC-compliant IdP.**
 *
 * Use when you want users to sign in with an external identity provider
 * rather than managing credentials yourself. Sessions outlive the IdP's
 * ~1 hour ID token TTL with transparent background refresh, and sign-out
 * invalidates the session server-side. No session storage to configure.
 * Two lifecycle hooks (`onSignIn`, `onSignOut`) hand customers the seam
 * for profile-row upserts and audit logging.
 *
 * Package: `@aws-blocks/bb-auth-oidc`
 * Full docs: `README.md` in the package directory above.
 *
 * @see {@link BlocksAuth} for the provider-agnostic auth interface all auth BBs implement.
 */
export {
	AuthOIDC,
	AuthOIDCErrors,
	google,
	github,
	customOidc,
	customOauth2,
	stubIdp,
	cognitoFederated,
	relayOrigin,
} from '@aws-blocks/bb-auth-oidc';
export type {
	AuthOIDCErrorName,
	OIDCUser,
	MappedClaims,
	RelayOrigin,
} from '@aws-blocks/bb-auth-oidc';

/**
 * **Shared auth interfaces and UI components for all Blocks auth Building Blocks.**
 *
 * Provides the `BlocksAuth` interface (implemented by every auth BB), auth state
 * types, and framework-agnostic UI components (`Authenticator`, `AuthenticatedContent`,
 * `onAuthChange`). Import these when writing provider-agnostic auth code.
 *
 * Package: `@aws-blocks/auth-common`
 * Full docs: `README.md` in the package directory above.
 */
export type { BlocksAuth, AuthUser, AuthState, AuthAction, AuthField, AuthActionInput } from '@aws-blocks/auth-common';

/**
 * **Simple key-value storage backed by DynamoDB.**
 *
 * Use for fast single-key get/put/delete: user preferences, feature flags,
 * session data, caches. Supports conditional writes and schema validation.
 * If you need queries, indexes, or structured data, use `DistributedTable`.
 *
 * Package: `@aws-blocks/bb-kv-store`
 * Full docs: `README.md` in the package directory above.
 */
export { KVStore, KVStoreErrors } from '@aws-blocks/bb-kv-store';
export type { ConditionalWriteOptions, ConditionalDeleteOptions, KVStoreOptions, ExternalTableRef } from '@aws-blocks/bb-kv-store';

/**
 * **Structured data storage with secondary indexes backed by DynamoDB.**
 *
 * Default choice for most application data. Use for entities with composite
 * keys, range queries, secondary access patterns, and batch operations.
 * Supports Zod/Valibot schemas for type-safe validation. Zero cost at rest,
 * scales automatically. Use `KVStore` for simpler key-only access, or
 * `Database` when you need SQL JOINs/transactions.
 *
 * Package: `@aws-blocks/bb-distributed-table`
 * Full docs: `README.md` in the package directory above.
 */
export { DistributedTable, DistributedTableErrors } from '@aws-blocks/bb-distributed-table';
export type { DistributedTableOptions, TableKeyConfig, TableKey, PutOptions as DTPutOptions, DeleteOptions as DTDeleteOptions, QueryOptions as DTQueryOptions, ScanOptions as DTScanOptions } from '@aws-blocks/bb-distributed-table';

/**
 * **Real-time pub/sub messaging backed by AppSync Events.**
 *
 * Use for pushing data to connected browser clients: chat, notifications,
 * live dashboards, collaborative editing. Typed namespaces with schema
 * validation on publish. Local dev uses WebSocket bridge; production uses
 * AppSync Events API.
 *
 * Package: `@aws-blocks/bb-realtime`
 * Full docs: `README.md` in the package directory above.
 */
export { Realtime } from '@aws-blocks/bb-realtime';
export type { RealtimeChannel, RealtimeSubscription, SubscribeOptions, DisconnectReason } from '@aws-blocks/bb-realtime';

/**
 * **SQL database with Kysely query builder backed by Aurora Serverless v2.**
 *
 * Use only when you specifically need complex multi-table JOINs, SQL
 * transactions, foreign key constraints, or complex aggregations. For most
 * application data, prefer `DistributedTable` (lower cost, simpler ops).
 * Requires a `migrations/` folder with `.sql` files.
 *
 * Package: `@aws-blocks/bb-data`
 * Full docs: `README.md` in the package directory above.
 */
export { Database, DatabaseErrors, fromExisting, sql } from '@aws-blocks/bb-data';
export type { DatabaseOptions, ExternalDatabaseRef, Transaction, SqlQuery } from '@aws-blocks/bb-data';

/**
 * **Serverless SQL database backed by Aurora DSQL.**
 *
 * Use for zero-ops SQL with instant provisioning, scale-to-zero, and
 * optionally multi-region active-active writes. DSQL is a strict PostgreSQL
 * subset — no foreign keys, RLS, triggers, or views. Transactions use
 * optimistic concurrency control (OCC) and may conflict at commit.
 * For full PostgreSQL with FK/RLS/triggers, use `Database`.
 *
 * Package: `@aws-blocks/bb-distributed-data`
 * Full docs: `README.md` in the package directory above.
 */
export { DistributedDatabase, DistributedDatabaseErrors } from '@aws-blocks/bb-distributed-data';
export type { DistributedDatabaseOptions, TransactionOptions } from '@aws-blocks/bb-distributed-data';

/**
 * **Background job processing backed by SQS and Lambda.**
 *
 * Use for fire-and-forget async work: sending emails, processing uploads,
 * generating reports, or any task that shouldn't block an API response.
 * Supports single and batch submission (up to 10), optional delay, schema
 * validation, and automatic retries with dead-letter queue.
 *
 * Package: `@aws-blocks/bb-async-job`
 * Full docs: `README.md` in the package directory above.
 */
export { AsyncJob, AsyncJobErrors } from '@aws-blocks/bb-async-job';
export type { AsyncJobOptions, AsyncJobContext, SubmitOptions, BatchSubmitResult } from '@aws-blocks/bb-async-job';

/**
 * **AI agent with streaming, tool calling, and conversation persistence.**
 *
 * Use for building conversational AI experiences: chatbots, copilots, data
 * extraction, or any LLM-powered feature. Supports Bedrock, OpenAI-compatible,
 * and CannedProvider (local dev). Tools defined with Zod schemas. Conversation
 * history persisted to DynamoDB. Streaming via AsyncJob + Realtime.
 * Set `inferenceOnly: true` for simple prompt→response without persistence.
 *
 * Package: `@aws-blocks/bb-agent`
 * Full docs: `README.md` in the package directory above.
 */
export { Agent, AgentErrors, BedrockModels, OllamaModels } from '@aws-blocks/bb-agent';
export type { AgentConfig, AgentResult, AgentStreamChunk, ToolDefinition, AgentTool, ToolFactory, ToolsConfig, ToolHandlerArgs, DefaultToolContext, ToolCallRecord, ModelConfig, StreamOptions, TokenUsage } from '@aws-blocks/bb-agent';

/**
 * **Scheduled task execution backed by EventBridge Scheduler and Lambda.**
 *
 * Use for recurring jobs: cleanup, report generation, data syncs, cache
 * warming, periodic health checks. Supports cron and rate expressions,
 * IANA timezones, and typed static input. No runtime methods — the
 * constructor defines the schedule and handler.
 *
 * Package: `@aws-blocks/bb-cron-job`
 * Full docs: `README.md` in the package directory above.
 */
export { CronJob, CronJobErrors } from '@aws-blocks/bb-cron-job';
export type { CronJobOptions, CronJobEvent } from '@aws-blocks/bb-cron-job';

/**
 * **Transactional email with AWS SES integration.**
 *
 * Use for sending transactional emails, password resets, confirmations,
 * notifications, and other one-to-one or bulk email. Supports single and
 * batch sending with partial failure handling.
 *
 * Package: `@aws-blocks/bb-email-client`
 * Full docs: `README.md` in the package directory above.
 */
export { EmailClient, EmailErrors } from '@aws-blocks/bb-email-client';
export type { EmailOptions, EmailMessage, SendResult, SendBatchResult } from '@aws-blocks/bb-email-client';

/**
 * **File storage backed by Amazon S3.**
 *
 * Use for storing, retrieving, and serving binary files — user uploads,
 * generated reports, images, videos, or static assets. Supports presigned
 * URLs for direct browser upload/download, batch deletion, and prefix-scoped
 * listing. For structured key-value data, use `KVStore`. For queryable
 * records with indexes, use `DistributedTable`.
 *
 * Package: `@aws-blocks/bb-file-bucket`
 * Full docs: `README.md` in the package directory above.
 */
export { FileBucket, FileBucketErrors } from '@aws-blocks/bb-file-bucket';
export type { FileBucketOptions, PutOptions as FBPutOptions, GetUrlOptions, PutUrlOptions, ScanOptions as FBScanOptions, FileContent, FileInfo, CorsRule, LifecycleRule, ExternalBucketRef as FBExternalBucketRef } from '@aws-blocks/bb-file-bucket';

/**
 * **Single application configuration value backed by SSM Parameter Store.**
 *
 * Use for feature flags, API URLs, thresholds, or structured config objects.
 * Set `secret: true` for sensitive values (API keys, tokens) — stored as SSM
 * SecureString encrypted with the `aws/ssm` KMS key. Each instance maps to
 * exactly one SSM parameter. Supports schema validation for typed objects.
 *
 * Package: `@aws-blocks/bb-app-setting`
 * Full docs: `README.md` in the package directory above.
 */
export { AppSetting, AppSettingErrors } from '@aws-blocks/bb-app-setting';
export type { AppSettingOptions } from '@aws-blocks/bb-app-setting';

/**
 * **Semantic document retrieval backed by Bedrock Knowledge Bases.**
 *
 * Use for RAG (retrieval-augmented generation), FAQ search, documentation
 * search, and any scenario where users need to query a corpus of documents
 * in natural language. Point it at a local `./knowledge` folder — subfolders
 * auto-populate `folder` metadata. In production, documents are synced to S3
 * and indexed via Bedrock with configurable chunking and embedding models.
 *
 * Package: `@aws-blocks/bb-knowledge-base`
 * Full docs: `README.md` in the package directory above.
 */
export { KnowledgeBase, KnowledgeBaseErrors } from '@aws-blocks/bb-knowledge-base';
export type { KnowledgeBaseOptions, RetrieveOptions, RetrieveResult, MetadataFilter, SourceConfig, ChunkingConfig, ChunkingStrategy, WaitUntilSyncedOptions } from '@aws-blocks/bb-knowledge-base';

/**
 * **Distributed tracing backed by AWS X-Ray.**
 *
 * Use when you need to trace request flow across services, debug latency
 * issues, or visualize service dependencies. Wrap discrete units of work
 * (DB calls, HTTP requests, business logic) with `startSegment`. Use
 * annotations for searchable values and metadata for debugging data.
 *
 * Package: `@aws-blocks/bb-tracer`
 * Full docs: `README.md` in the package directory above.
 */
export { Tracer } from '@aws-blocks/bb-tracer';
export type { TracerOptions, Segment, AnnotationValue } from '@aws-blocks/bb-tracer';

/**
 * **Custom application metrics backed by Amazon CloudWatch (via EMF).**
 *
 * Use for tracking numeric measurements over time: request counts, error
 * rates, latency, queue depths, business KPIs. Metrics are emitted via
 * CloudWatch Embedded Metric Format — synchronous stdout writes with zero
 * latency impact. Supports dimensions, high-resolution (1s) metrics,
 * batch emission, and child emitters for scoped dimension inheritance.
 *
 * Package: `@aws-blocks/bb-metrics`
 * Full docs: `README.md` in the package directory above.
 */
export { Metrics, MetricsErrors } from '@aws-blocks/bb-metrics';
export type { MetricsOptions, EmitOptions, MetricDatum, MetricUnit, MetricResolution, ExternalMetricsRef, MetricsEmitter } from '@aws-blocks/bb-metrics';

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
 * Package: `@aws-blocks/bb-logger`
 * Full docs: `README.md` in the package directory above.
 */
export { Logger, LoggingErrors } from '@aws-blocks/bb-logger';
export type { LogLevel, LoggingOptions, LogEntry, ChildLogger, RetentionDays } from '@aws-blocks/bb-logger';

/**
 * **Auto-generated CloudWatch Dashboard for application observability.**
 *
 * Use when you want a single URL to view application health after deployment.
 * Creates pre-configured widgets for Lambda health, custom metrics, log
 * queries, and X-Ray traces without manually creating CloudWatch dashboards.
 * Pass real observability BB instances (Logger, Metrics, Tracer) for
 * automatic type-safe integration.
 *
 * Package: `@aws-blocks/bb-dashboard`
 * Full docs: `README.md` in the package directory above.
 */
export { Dashboard, DashboardErrors } from '@aws-blocks/bb-dashboard';
export type { DashboardOptions, MetricConfig, MetricsBBRef, LoggerBBRef, TracerBBRef } from '@aws-blocks/bb-dashboard';
