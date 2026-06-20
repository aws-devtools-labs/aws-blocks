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

import type { KVStore } from '@aws-blocks/bb-kv-store';
import type { FileBucket } from '@aws-blocks/bb-file-bucket';
import type { DistributedTable } from '@aws-blocks/bb-distributed-table';
import type { AsyncJob } from '@aws-blocks/bb-async-job';
import type { EventBus } from '@aws-blocks/bb-event-bus';
import type { AppSetting } from '@aws-blocks/bb-app-setting';
import type { CronJob } from '@aws-blocks/bb-cron-job';
import type { AuthCognito } from '@aws-blocks/bb-auth-cognito';
import type { AuthOIDC } from '@aws-blocks/bb-auth-oidc';
import type { Database } from '@aws-blocks/bb-data';
import type { DistributedDatabase } from '@aws-blocks/bb-distributed-data';
import type { KnowledgeBase } from '@aws-blocks/bb-knowledge-base';
import type { Agent } from '@aws-blocks/bb-agent';
import type { Dashboard } from '@aws-blocks/bb-dashboard';
import type { Logger } from '@aws-blocks/bb-logger';
import type { Realtime } from '@aws-blocks/bb-realtime';
import { getSdkIdentifiers as _getSdkIdentifiers } from '@aws-blocks/core';

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
export function getSdkIdentifiers(bb: EventBus<any>): { eventBusName: string };
export function getSdkIdentifiers(bb: AppSetting<any>): { parameterName: string };
export function getSdkIdentifiers(bb: CronJob<any>): { scheduleName: string };
export function getSdkIdentifiers(bb: AuthCognito<any>): { userPoolId: string; clientId: string };
export function getSdkIdentifiers(bb: AuthOIDC<any>): { sessionTableName: string };
export function getSdkIdentifiers(bb: Database): { clusterArn: string; secretArn: string; databaseName: string };
export function getSdkIdentifiers(bb: DistributedDatabase): { clusterEndpoint: string };
export function getSdkIdentifiers(bb: KnowledgeBase): { kbId: string };
export function getSdkIdentifiers(bb: InstanceType<typeof Realtime>): { wsUrl: string; callbackUrl: string };
export function getSdkIdentifiers(bb: Agent): { conversationsTableName: string; messagesTableName: string; sessionBucketName: string; realtimeWsUrl: string; realtimeCallbackUrl: string; jobQueueUrl: string };
export function getSdkIdentifiers(bb: Dashboard): { dashboardName: string };
export function getSdkIdentifiers(bb: Logger): { logGroupName: string };
export function getSdkIdentifiers(bb: { fullId: string }): Record<string, string>;
export function getSdkIdentifiers(bb: { fullId: string }): Record<string, string> {
	return _getSdkIdentifiers(bb);
}
