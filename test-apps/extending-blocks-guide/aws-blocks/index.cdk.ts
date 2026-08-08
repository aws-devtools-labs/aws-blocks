// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { BlocksStack, SandboxDisableDeletionProtection, registerConfig } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSandboxId } from './scripts/sandbox-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = new cdk.App();

const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();
const id = getSandboxId(projectRoot);
const stackName = `bb-extending-guide-${id}`;

// Pattern 2 needs the legacy table names available BOTH at synth
// (so KVStore.fromExisting / DistributedTable.fromExisting can pass real
// strings into Table.fromTableName) AND at runtime (so the runtime ctor
// reads it from env). We pin the physical names and surface them below.
const legacyTableName = `${stackName}-legacy-sessions`;
const legacyUsersTableName = `${stackName}-legacy-users`;
process.env.BLOCKS_LEGACY_SESSIONS_TABLE = legacyTableName;
process.env.BLOCKS_LEGACY_USERS_TABLE = legacyUsersTableName;

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
});

// E2E test stacks must be fully deletable.
RemovalPolicies.of(blocksStack).destroy();
Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());

// Pattern 1 fixture: an SQS queue we'll send to via raw SDK.
const externalQueue = new sqs.Queue(blocksStack, 'external-queue');
externalQueue.grantSendMessages(blocksStack.handler);
registerConfig(blocksStack, 'EXTERNAL_QUEUE_URL', externalQueue.queueUrl);

// Pattern 2 fixtures: two DynamoDB tables that pretend to predate Blocks.
// We pre-pinned the physical names above so KVStore.fromExisting and
// DistributedTable.fromExisting could pass them through at synth time.
//
// NOTE: both BBs call `grantReadWriteData` on the bound table internally,
// so we DON'T grant here — doing so would emit a redundant IAM statement.
const legacyTable = new dynamodb.Table(blocksStack, 'legacy-sessions', {
  tableName: legacyTableName,
  partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
});

const legacyUsersTable = new dynamodb.Table(blocksStack, 'legacy-users', {
  tableName: legacyUsersTableName,
  partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'createdAt', type: dynamodb.AttributeType.NUMBER },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
});

// Outputs we need for testing.
new cdk.CfnOutput(blocksStack, 'ExternalQueueUrl', { value: externalQueue.queueUrl });
new cdk.CfnOutput(blocksStack, 'LegacySessionsTable', { value: legacyTable.tableName });
new cdk.CfnOutput(blocksStack, 'LegacyUsersTable', { value: legacyUsersTable.tableName });
new cdk.CfnOutput(blocksStack, 'StackNameOut', { value: stackName });

// Surface the table names to runtime — *.fromExisting on the runtime side
// reads them from process.env.
registerConfig(blocksStack, 'BLOCKS_LEGACY_SESSIONS_TABLE', legacyTableName);
registerConfig(blocksStack, 'BLOCKS_LEGACY_USERS_TABLE', legacyUsersTableName);

cdk.Tags.of(blocksStack).add('blocks:purpose', 'extending-guide-validation');
