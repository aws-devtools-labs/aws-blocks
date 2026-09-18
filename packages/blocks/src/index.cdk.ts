// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// CDK build - re-export CDK versions
// Pipeline (and all other CDK constructs) are re-exported via the wildcard below.
// Note: BlocksStack / BlocksBackend from this wildcard are shadowed below by
// factory-injecting wrappers of the same name.
export * from '@aws-blocks/core/cdk';

import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';
import type { ScopeParent } from '@aws-blocks/core';
import {
	type BlocksBackendProps,
	type BlocksStackProps,
	type Compute,
	BlocksBackend as CoreBlocksBackend,
	BlocksStack as CoreBlocksStack,
} from '@aws-blocks/core/cdk';
import type { DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import type { Construct } from 'constructs';
import { type ComputeRequirements, provideCompute } from './compute-provider.js';

export type { ComputeRequirements } from './compute-provider.js';

// The umbrella is the one package that depends on both core and a concrete
// compute, so it supplies the default-compute factory here — a plain import,
// not a side-effect global. It spreads the factory onto the customer's props
// (turning the public BlocksStackProps into core's CoreBlocksStackProps), so
// core builds the default without importing the concrete class. The factory is
// deliberately absent from the customer-facing props types; the umbrella is its
// only supplier.
//
// The cast is plumbing: under the default TS condition `LambdaCompute` resolves
// to its mock-typed entry, but under `--conditions=cdk` (real synth) the value
// is the CDK `LambdaCompute` that extends `Compute`. The cast bridges that
// condition-vs-value gap; it is not a public-API cast.
const lambdaDefaultComputeFactory: DefaultComputeFactory = (root) =>
	new LambdaCompute(root as never, 'DefaultCompute') as unknown as Compute;

/**
 * `BlocksStack` with the Lambda default compute wired in. Same API and instance
 * type as core's `BlocksStack`; `create()` spreads the default-compute factory
 * onto the props.
 */
export const BlocksStack = {
	create: (scope: Construct, id: string, props: BlocksStackProps): Promise<CoreBlocksStack> =>
		CoreBlocksStack.create(scope, id, { ...props, defaultComputeFactory: lambdaDefaultComputeFactory }),
};
export type BlocksStack = CoreBlocksStack;

/**
 * `BlocksBackend` with the Lambda default compute wired in. Same API and
 * instance type as core's `BlocksBackend`; `create()` spreads the
 * default-compute factory onto the props.
 */
export const BlocksBackend = {
	create: (scope: Construct, id: string, props: BlocksBackendProps): Promise<CoreBlocksBackend> =>
		CoreBlocksBackend.create(scope, id, { ...props, defaultComputeFactory: lambdaDefaultComputeFactory }),
};
export type BlocksBackend = CoreBlocksBackend;

export type { AuthAction, AuthField, AuthState, AuthUser, BlocksAuth } from '@aws-blocks/auth-common';
export type {
	AgentConfig,
	AgentResult,
	AgentStreamChunk,
	ModelConfig,
	StreamOptions,
	TokenUsage,
	ToolCallRecord,
	ToolDefinition,
} from '@aws-blocks/bb-agent';
export { Agent, AgentErrors, BedrockModels, OllamaModels } from '@aws-blocks/bb-agent';
export type { AppSettingOptions } from '@aws-blocks/bb-app-setting';
export { AppSetting, AppSettingErrors } from '@aws-blocks/bb-app-setting';
export type {
	AsyncJobContext,
	AsyncJobOptions,
	AsyncJobState,
	AsyncJobStatus,
	AsyncJobTransition,
	BatchSubmitResult,
	SubmitOptions,
	WaitUntilCompleteOptions,
} from '@aws-blocks/bb-async-job';
export { AsyncJob, AsyncJobErrors } from '@aws-blocks/bb-async-job';
// Building Blocks (CDK versions)
export {
	AuthBasic,
	AuthBasicErrors,
	type AuthBasicOptions,
	type AuthBasicUser,
	type PasswordPolicy,
} from '@aws-blocks/bb-auth-basic';
export type {
	AuthCognitoOptions,
	AuthFlowType,
	CodeDeliveryDetails,
	CognitoUser,
	ConfirmSignInOptions,
	DeviceRecord,
	ExternalUserPoolRef,
	MFAPreference,
	ResetPasswordResult,
	SignInNextStep,
	SignInOptions,
	SignInResult,
	SignUpOptions,
	SignUpResult,
	UpdateAttributeOutcome,
	UserAttribute,
} from '@aws-blocks/bb-auth-cognito';
export { AuthCognito, AuthCognitoErrors } from '@aws-blocks/bb-auth-cognito';
export type { AuthOIDCErrorName, MappedClaims, OIDCUser, RelayOrigin } from '@aws-blocks/bb-auth-oidc';
export {
	AuthOIDC,
	AuthOIDCErrors,
	cognitoFederated,
	customOauth2,
	customOidc,
	github,
	google,
	relayOrigin,
	stubIdp,
} from '@aws-blocks/bb-auth-oidc';
export type { CronJobEvent, CronJobOptions } from '@aws-blocks/bb-cron-job';
export { CronJob, CronJobErrors } from '@aws-blocks/bb-cron-job';
export type {
	DashboardOptions,
	MetricConfig,
	MetricsBBRef,
	MetricsSource,
} from '@aws-blocks/bb-dashboard';
export { Dashboard, DashboardErrors } from '@aws-blocks/bb-dashboard';
export type { DatabaseOptions, ExternalDatabaseRef, SqlQuery, Transaction } from '@aws-blocks/bb-data';
export { Database, DatabaseErrors, fromExisting, sql } from '@aws-blocks/bb-data';
export type { DistributedDatabaseOptions, TransactionOptions } from '@aws-blocks/bb-distributed-data';
export { DistributedDatabase, DistributedDatabaseErrors } from '@aws-blocks/bb-distributed-data';
export type {
	DeleteOptions as DTDeleteOptions,
	DistributedTableOptions,
	PutOptions as DTPutOptions,
	QueryOptions as DTQueryOptions,
	ReadValidationMode,
	ScanOptions as DTScanOptions,
	TableKey,
	TableKeyConfig,
} from '@aws-blocks/bb-distributed-table';
export { DistributedTable, DistributedTableErrors } from '@aws-blocks/bb-distributed-table';
export type { EmailMessage, EmailOptions, SendBatchResult, SendResult } from '@aws-blocks/bb-email-client';
export { EmailClient, EmailErrors } from '@aws-blocks/bb-email-client';
export type {
	CorsRule,
	ExternalBucketRef as FBExternalBucketRef,
	FileBucketOptions,
	FileContent,
	FileInfo,
	GetUrlOptions,
	LifecycleRule,
	PutOptions as FBPutOptions,
	PutUrlOptions,
	ScanOptions as FBScanOptions,
} from '@aws-blocks/bb-file-bucket';
export { FileBucket, FileBucketErrors } from '@aws-blocks/bb-file-bucket';
export type {
	ChunkingConfig,
	ChunkingStrategy,
	KnowledgeBaseOptions,
	MetadataFilter,
	RetrieveOptions,
	RetrieveResult,
	SourceConfig,
	WaitUntilSyncedOptions,
} from '@aws-blocks/bb-knowledge-base';
export { KnowledgeBase, KnowledgeBaseErrors } from '@aws-blocks/bb-knowledge-base';
export type {
	ConditionalDeleteOptions,
	ConditionalWriteOptions,
	ExternalTableRef,
	KVStoreOptions,
	PutOptions as KVPutOptions,
} from '@aws-blocks/bb-kv-store';
export { KVStore, KVStoreErrors } from '@aws-blocks/bb-kv-store';
export type { ChildLogger, LogEntry, LoggingOptions, LogLevel } from '@aws-blocks/bb-logger';
export { Logger, LoggingErrors } from '@aws-blocks/bb-logger';
export type {
	EmitOptions,
	ExternalMetricsRef,
	MetricDatum,
	MetricResolution,
	MetricsEmitter,
	MetricsOptions,
	MetricUnit,
} from '@aws-blocks/bb-metrics';
export { Metrics, MetricsErrors } from '@aws-blocks/bb-metrics';
export { Realtime } from '@aws-blocks/bb-realtime';
export type { AnnotationValue, Segment, TracerOptions } from '@aws-blocks/bb-tracer';
export { Tracer } from '@aws-blocks/bb-tracer';
// Override core's untyped getSdkIdentifiers with typed overloads
export { getSdkIdentifiers } from './sdk-identifiers.js';

/**
 * Declares computes from what a workload needs.
 *
 * ```ts
 * const reports = ComputeProvider.provide('reports', {
 *   timeoutSeconds: 60 * 4,
 *   memoryMb: 1024,
 * });
 * ```
 *
 * Requirements in, a {@link Compute} out. The app never names the service that
 * fulfils them, which is the point: today every declaration resolves to a
 * serverless (Lambda) compute, and when another fulfillment exists this resolves
 * differently without a single call site changing.
 *
 * A returned compute is an ordinary `Compute`, so it goes anywhere one is
 * accepted — and constructing one directly (`new LambdaCompute(scope, id)`)
 * remains supported and equally valid.
 *
 * This lives in the umbrella because it is the one package that depends on both
 * core and a concrete compute; core must not import a compute package.
 */
export const ComputeProvider = {
	/**
	 * Provision a compute that satisfies `requirements`.
	 *
	 * @param id - Identifies the compute. Every resource it owns derives its name
	 *   from this, so treat it as stable — renaming it replaces the compute's
	 *   function, log group and gateway. Declared computes are siblings of the
	 *   app's default compute, so the id only has to be unique within the stack.
	 * @param requirements - What the workload needs (`timeoutSeconds`, `memoryMb`).
	 *   Validated against the limits of the compute it resolves to, so a workload
	 *   that cannot be hosted fails at synth rather than deploying and then timing
	 *   out. Omitted fields take the resolved compute's defaults.
	 * @param scope - Where to attach. Defaults to the ambient `BlocksStack`, which
	 *   is where the framework parents its own default compute — so resource names
	 *   never depend on where in the app tree the compute was declared. Pass this
	 *   explicitly when the ambient stack is ambiguous (two `BlocksBackend`s in one
	 *   parent stack).
	 */
	provide(id: string, requirements?: ComputeRequirements, scope?: ScopeParent): Compute {
		// Under CDK a compute must attach to a real construct tree. Resolve the parent
		// the way provideCompute will — explicit scope, else the ambient BlocksStack the
		// stack's constructor sets before importing the backend module — and fail with an
		// actionable message when neither exists, before the CDK Construct ctor throws
		// something opaque. This guard is CDK-only: the runtime/mock entry has no stack
		// and needs no parent (its `Scope` falls back to a stub), so it must not throw.
		const parent = scope ?? (globalThis as { CURRENT_BLOCKS_STACK?: ScopeParent }).CURRENT_BLOCKS_STACK;
		if (!parent) {
			throw new Error(
				`Compute "${id}" was declared before the Blocks stack existed. Declare computes inside the ` +
					'backend module (the one BlocksStack.create loads), or pass an explicit scope.',
			);
		}
		// One implementation, in ./compute-provider.ts. Pass the parent we already
		// resolved, so the ambient-stack lookup happens once and the guard above can
		// never diverge from the scope the compute actually attaches to. The cast is
		// the same plumbing as the default-compute factory above: under the default TS
		// condition `LambdaCompute` resolves to the mock handle, while under `cdk` it is
		// the CDK `LambdaCompute` that extends `Compute`.
		return provideCompute(id, requirements, parent) as Compute;
	},
};

// Blocks generated by `@aws-blocks/create-block` (contributor mode) are re-exported here.
// <!-- BEGIN:generated-block-exports -->
// <!-- END:generated-block-exports -->
