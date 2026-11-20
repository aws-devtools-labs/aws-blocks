// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed overloads for {@link getSdkIdentifiers}.
 *
 * These overloads provide compile-time return-type narrowing so that
 * `getSdkIdentifiers(myKvStore)` returns `{ tableName: string }` instead of
 * a generic `Record<string, string>`. The runtime implementation simply
 * delegates to the base function in `@aws-cdk-blocks/core`.
 *
 * @module
 */

import type { Agent } from '@aws-cdk-blocks/bb-agent';
import type { AppSetting } from '@aws-cdk-blocks/bb-app-setting';
import type { AsyncJob } from '@aws-cdk-blocks/bb-async-job';
import type { Auth } from '@aws-cdk-blocks/bb-auth';
import type { CronJob } from '@aws-cdk-blocks/bb-cron-job';
import type { Dashboard } from '@aws-cdk-blocks/bb-dashboard';
import type { Database, DatabaseCluster } from '@aws-cdk-blocks/bb-database';
import type { FileBucket } from '@aws-cdk-blocks/bb-file-bucket';
import type { KnowledgeBase } from '@aws-cdk-blocks/bb-knowledge-base';
import type { KVStore } from '@aws-cdk-blocks/bb-kv-store';
import type { Logger } from '@aws-cdk-blocks/bb-logger';
import type { Realtime } from '@aws-cdk-blocks/bb-realtime';
import { getSdkIdentifiers as _getSdkIdentifiers } from '@aws-cdk-blocks/core';

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
 * import { getSdkIdentifiers } from 'aws-cdk-blocks';
 * import { KVStore } from '@aws-cdk-blocks/bb-kv-store';
 *
 * const store = new KVStore(scope, 'users', {});
 * const { tableName } = getSdkIdentifiers(store); // ← typed as { tableName: string }
 * ```
 */
export function getSdkIdentifiers(bb: KVStore<any, any, any, any>): { tableName: string };
export function getSdkIdentifiers(bb: FileBucket<any>): { bucketName: string };
export function getSdkIdentifiers(bb: AsyncJob<any>): { queueUrl: string };
export function getSdkIdentifiers(bb: AppSetting<any>): { parameterName: string };
export function getSdkIdentifiers(bb: CronJob<any>): { scheduleName: string };
// `Auth` registers its user pool's ids (and, in Lambda, the pool's region) whenever it has a user pool,
// and its managed-login domain and app client when a provider federates through Cognito. A configuration
// without a pool (directly federated OIDC / OAuth 2.0 providers only) creates no AWS resource and
// registers nothing, so every field is optional. Its sessions table is a separate KVStore, not listed here.
export function getSdkIdentifiers(bb: Auth<any>): {
	userPoolId?: string;
	clientId?: string;
	region?: string;
	hostedUiDomain?: string;
	hostedUiClientId?: string;
};
// `Database` always registers the cluster it runs on and its schema. The endpoint and region exist
// only in Lambda: the local build runs on PGlite and has neither. `roleName` is the PostgreSQL role the
// block connects as on a cluster it provisions (`blocks_app_{cluster}` on AWS, `blocks_app_local` locally);
// a block on `DatabaseCluster.fromExisting()` or a `LegacyDatabaseCluster` connects as the role of its
// connection and has none. A migration names that role with `${app_role}`.
export function getSdkIdentifiers(bb: Database): {
	clusterId: string;
	schemaName: string;
	clusterEndpoint?: string;
	region?: string;
	roleName?: string;
};
export function getSdkIdentifiers(bb: DatabaseCluster): { clusterEndpoint: string; region?: string };
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
export function getSdkIdentifiers(bb: { fullId: string }): Record<string, string> {
	return _getSdkIdentifiers(bb);
}
