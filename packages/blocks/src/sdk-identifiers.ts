// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed overloads for {@link getSdkIdentifiers}.
 *
 * These overloads provide compile-time return-type narrowing so that
 * `getSdkIdentifiers(myKvStore)` returns `{ tableName: string }` instead of
 * a generic `Record<string, string>`. The runtime implementation simply
 * delegates to the base function in `@aws-blocks/core`.
 *
 * @module
 */

import type { Agent } from '@aws-blocks/bb-agent';
import type { AppSetting } from '@aws-blocks/bb-app-setting';
import type { AsyncJob } from '@aws-blocks/bb-async-job';
import type { AuthCognito } from '@aws-blocks/bb-auth-cognito';
import type { AuthOIDC } from '@aws-blocks/bb-auth-oidc';
import type { CronJob } from '@aws-blocks/bb-cron-job';
import type { Dashboard } from '@aws-blocks/bb-dashboard';
import type { Database } from '@aws-blocks/bb-data';
import type { DatabaseCluster, Database as SqlDatabase } from '@aws-blocks/bb-database';
import type { DistributedDatabase } from '@aws-blocks/bb-distributed-data';
import type { DistributedTable } from '@aws-blocks/bb-distributed-table';
import type { FileBucket } from '@aws-blocks/bb-file-bucket';
import type { KnowledgeBase } from '@aws-blocks/bb-knowledge-base';
import type { KVStore } from '@aws-blocks/bb-kv-store';
import type { Logger } from '@aws-blocks/bb-logger';
import type { Realtime } from '@aws-blocks/bb-realtime';
import { getSdkIdentifiers as _getSdkIdentifiers } from '@aws-blocks/core';

/**
 * Identifiers a `@aws-blocks/bb-database` `Database` registers: the cluster it
 * runs on and its schema, plus the cluster's connection identifiers (DSQL
 * endpoint + region, or Aurora cluster ARN + secret ARN + database name; none
 * for `fromExisting()`).
 */
export type DatabaseSdkIdentifiers = {
	clusterId: string;
	schemaName: string;
	clusterEndpoint?: string;
	region?: string;
	clusterArn?: string;
	secretArn?: string;
	databaseName?: string;
};

/** Identifiers a `@aws-blocks/bb-database` `DatabaseCluster` registers, by cluster type. */
export type DatabaseClusterSdkIdentifiers = {
	clusterEndpoint?: string;
	region?: string;
	clusterArn?: string;
	secretArn?: string;
	databaseName?: string;
};

/**
 * Retrieve the typed SDK identifiers for a Building Block instance.
 *
 * Each overload narrows the return type based on the BB passed in, giving you
 * full autocomplete on the available resource identifiers (table names, bucket
 * names, ARNs, URLs, etc.).
 *
 * @param bb - A Building Block instance.
 * @returns A typed object containing the BB's registered resource identifiers.
 *
 * @example
 * ```typescript
 * import { getSdkIdentifiers } from '@aws-blocks/blocks';
 * import { KVStore } from '@aws-blocks/bb-kv-store';
 *
 * const store = new KVStore(scope, 'users', {});
 * const { tableName } = getSdkIdentifiers(store); // ← typed as { tableName: string }
 * ```
 */
export function getSdkIdentifiers(bb: KVStore<any>): { tableName: string };
export function getSdkIdentifiers(bb: DistributedTable<any, any, any>): { tableName: string };
export function getSdkIdentifiers(bb: FileBucket<any>): { bucketName: string };
export function getSdkIdentifiers(bb: AsyncJob<any>): { queueUrl: string };
export function getSdkIdentifiers(bb: AppSetting<any>): { parameterName: string };
export function getSdkIdentifiers(bb: CronJob<any>): { scheduleName: string };
export function getSdkIdentifiers(bb: AuthCognito<any>): { userPoolId: string; clientId: string };
export function getSdkIdentifiers(bb: AuthOIDC<any>): { sessionTableName: string };
export function getSdkIdentifiers(bb: SqlDatabase<any>): DatabaseSdkIdentifiers;
export function getSdkIdentifiers(bb: DatabaseCluster<any>): DatabaseClusterSdkIdentifiers;
export function getSdkIdentifiers(bb: Database): { clusterArn: string; secretArn: string; databaseName: string };
export function getSdkIdentifiers(bb: DistributedDatabase): { clusterEndpoint: string };
export function getSdkIdentifiers(bb: KnowledgeBase): { kbId: string };
export function getSdkIdentifiers(bb: InstanceType<typeof Realtime>): { wsUrl: string; callbackUrl: string };
export function getSdkIdentifiers(bb: Agent): {
	conversationsTableName: string;
	messagesTableName: string;
	sessionBucketName: string;
	realtimeWsUrl: string;
	realtimeCallbackUrl: string;
};
export function getSdkIdentifiers(bb: Dashboard): { dashboardName: string };
export function getSdkIdentifiers(bb: Logger): { logGroupName: string };
export function getSdkIdentifiers(bb: { fullId: string }): Record<string, string>;
// The implementation signature admits `undefined` values so overloads with
// optional identifiers (a `Database` registers different keys per cluster kind)
// stay compatible; callers only ever see the overloads above.
export function getSdkIdentifiers(bb: { fullId: string }): Record<string, string | undefined> {
	return _getSdkIdentifiers(bb);
}
