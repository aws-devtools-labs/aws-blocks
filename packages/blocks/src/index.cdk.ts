// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// CDK build - re-export CDK versions
// Pipeline (and all other CDK constructs) are re-exported via the wildcard below.
// Note: BlocksStack / BlocksBackend from this wildcard are shadowed below by
// factory-injecting wrappers of the same name.
export * from '@aws-blocks/core/cdk';

import type { Construct } from 'constructs';
import {
	BlocksStack as CoreBlocksStack,
	BlocksBackend as CoreBlocksBackend,
	type BlocksStackProps,
	type BlocksBackendProps,
} from '@aws-blocks/core/cdk';
import type { Compute, DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';

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

// Override core's untyped getSdkIdentifiers with typed overloads
export { getSdkIdentifiers } from './sdk-identifiers.js';

// Building Blocks (CDK versions)
export { AuthBasic, AuthBasicErrors, type AuthBasicUser, type AuthBasicOptions, type PasswordPolicy } from '@aws-blocks/bb-auth-basic';
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
} from '@aws-blocks/bb-auth-cognito';
export { AuthOIDC, AuthOIDCErrors, google, github, customOidc, customOauth2, stubIdp, cognitoFederated, relayOrigin } from '@aws-blocks/bb-auth-oidc';
export type { AuthOIDCErrorName, OIDCUser, MappedClaims, RelayOrigin } from '@aws-blocks/bb-auth-oidc';
export type { BlocksAuth, AuthUser, AuthState, AuthAction, AuthField } from '@aws-blocks/auth-common';
export { KVStore, KVStoreErrors } from '@aws-blocks/bb-kv-store';
export type { ConditionalWriteOptions, ConditionalDeleteOptions, PutOptions as KVPutOptions, KVStoreOptions, ExternalTableRef } from '@aws-blocks/bb-kv-store';
export { DistributedTable, DistributedTableErrors } from '@aws-blocks/bb-distributed-table';
export type { DistributedTableOptions, ReadValidationMode, TableKeyConfig, TableKey, PutOptions as DTPutOptions, DeleteOptions as DTDeleteOptions, QueryOptions as DTQueryOptions, ScanOptions as DTScanOptions } from '@aws-blocks/bb-distributed-table';
export { Realtime } from '@aws-blocks/bb-realtime';
export { Database, DatabaseErrors, fromExisting } from '@aws-blocks/bb-data';
export { sql } from '@aws-blocks/bb-data';
export type { DatabaseOptions, ExternalDatabaseRef, SqlQuery, Transaction } from '@aws-blocks/bb-data';
export { DistributedDatabase, DistributedDatabaseErrors } from '@aws-blocks/bb-distributed-data';
export type { DistributedDatabaseOptions, TransactionOptions } from '@aws-blocks/bb-distributed-data';
export { AsyncJob, AsyncJobErrors } from '@aws-blocks/bb-async-job';
export type { AsyncJobOptions, AsyncJobContext, SubmitOptions, BatchSubmitResult, AsyncJobState, AsyncJobStatus, AsyncJobTransition, WaitUntilCompleteOptions } from '@aws-blocks/bb-async-job';
export { Agent, AgentErrors, BedrockModels, OllamaModels } from '@aws-blocks/bb-agent';
export type { AgentConfig, AgentResult, AgentStreamChunk, ToolDefinition, ToolCallRecord, ModelConfig, StreamOptions, TokenUsage } from '@aws-blocks/bb-agent';
export { CronJob, CronJobErrors } from '@aws-blocks/bb-cron-job';
export type { CronJobOptions, CronJobEvent } from '@aws-blocks/bb-cron-job';
export { FileBucket, FileBucketErrors } from '@aws-blocks/bb-file-bucket';
export type { FileBucketOptions, PutOptions as FBPutOptions, GetUrlOptions, PutUrlOptions, ScanOptions as FBScanOptions, FileContent, FileInfo, CorsRule, LifecycleRule, ExternalBucketRef as FBExternalBucketRef } from '@aws-blocks/bb-file-bucket';
export { AppSetting, AppSettingErrors } from '@aws-blocks/bb-app-setting';
export type { AppSettingOptions } from '@aws-blocks/bb-app-setting';
export { KnowledgeBase, KnowledgeBaseErrors } from '@aws-blocks/bb-knowledge-base';
export type { KnowledgeBaseOptions, RetrieveOptions, RetrieveResult, MetadataFilter, SourceConfig, ChunkingConfig, ChunkingStrategy, WaitUntilSyncedOptions } from '@aws-blocks/bb-knowledge-base';
export { Tracer } from '@aws-blocks/bb-tracer';
export type { TracerOptions, Segment, AnnotationValue } from '@aws-blocks/bb-tracer';
export { Logger, LoggingErrors } from '@aws-blocks/bb-logger';
export type { LogLevel, LoggingOptions, LogEntry, ChildLogger, RetentionDays } from '@aws-blocks/bb-logger';
export { EmailClient, EmailErrors } from '@aws-blocks/bb-email-client';
export type { EmailOptions, EmailMessage, SendResult, SendBatchResult } from '@aws-blocks/bb-email-client';
export { Metrics, MetricsErrors } from '@aws-blocks/bb-metrics';
export type { MetricsOptions, EmitOptions, MetricDatum, MetricUnit, MetricResolution, ExternalMetricsRef, MetricsEmitter } from '@aws-blocks/bb-metrics';
export { Dashboard, DashboardErrors } from '@aws-blocks/bb-dashboard';
export type { DashboardOptions, MetricConfig, MetricsBBRef, LoggerBBRef, TracerBBRef } from '@aws-blocks/bb-dashboard';

// Blocks generated by `@aws-blocks/create-block` (contributor mode) are re-exported here.
// <!-- BEGIN:generated-block-exports -->
// <!-- END:generated-block-exports -->

