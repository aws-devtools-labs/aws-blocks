// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Top-level describe() name → Building Block, for the comprehensive app's e2e
 * suites. Another stack passes its own table to `parity-report --suites`.
 */
export const COMPREHENSIVE_SUITE_BLOCKS: ReadonlyArray<readonly [RegExp, string]> = [
	[/^Agent BB/, 'bb-agent'],
	[/^AppSetting/, 'bb-app-setting'],
	[/^AsyncJob/, 'bb-async-job'],
	[/^AuthCognito/, 'bb-auth-cognito'],
	[/^AuthBasic/, 'bb-auth-basic'],
	[/^AuthOIDC/, 'bb-auth-oidc'],
	[/^CronJob/, 'bb-cron-job'],
	[/^Database BB/, 'bb-data'],
	[/^DistributedTable/, 'bb-distributed-table'],
	[/^DSQL/, 'bb-distributed-data'],
	[/^EmailClient/, 'bb-email-client'],
	[/^FileBucket/, 'bb-file-bucket'],
	[/^KnowledgeBase/, 'bb-knowledge-base'],
	[/^KVStore/, 'bb-kv-store'],
	[/^Logger/, 'bb-logger'],
	[/^Metrics/, 'bb-metrics'],
	[/^Realtime/, 'bb-realtime'],
	[/^Secret BB/, 'bb-secret'],
	[/^Tracer/, 'bb-tracer'],
	[/^Multi-compute/, 'bb-compute'],
	[/^(RawRoute|CORS|API method response cookies|Console shortcuts|CLI Client|Context|Error handling|Data types)/, 'core'],
];
