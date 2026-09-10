// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// CDK build - re-export CDK versions
// Pipeline (and all other CDK constructs) are re-exported via the wildcard below.
// Note: BlocksStack / BlocksBackend from this wildcard are shadowed below by
// factory-injecting wrappers of the same name.
export * from '@aws-blocks/core/cdk';

import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';
import {
	type BlocksBackendProps,
	type BlocksStackProps,
	BlocksBackend as CoreBlocksBackend,
	BlocksStack as CoreBlocksStack,
} from '@aws-blocks/core/cdk';
import type { Compute, DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import type { Construct } from 'constructs';

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
