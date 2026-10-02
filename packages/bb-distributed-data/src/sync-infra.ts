// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK infrastructure for `DistributedDatabase({ sync })`:
 *
 * - a provisioned Kinesis data stream (the CDC target; 10 MiB max record size,
 *   as Aurora DSQL requires),
 * - the IAM service role Aurora DSQL assumes to write to it (trust scoped to
 *   this account and this cluster's streams; write-only on this one stream),
 * - the CDC stream itself, through a custom resource (CloudFormation has no
 *   resource type for it),
 * - a Kinesis event source on the block's Lambda compute, which rings the
 *   shape bells (see `sync/cdc.ts`).
 *
 * The bell (a Realtime block), the token secret (an AppSetting), and the shape
 * route are created by the caller, with the same child ids as the runtime.
 */

import { DEFAULT_NODE_RUNTIME, blocksNodejsBundling } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { KinesisEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { join } from 'node:path';
import { cdcStreamName } from './constants.js';

/** Aurora DSQL CDC requires the target to accept 10 MiB records. */
const MAX_RECORD_SIZE_KIB = 10240;

export interface SyncInfraProps {
  fullId: string;
  /** The `AWS::DSQL::Cluster` resource. */
  cluster: cdk.CfnResource;
  /** Lambda that consumes the stream (the block's compute). */
  consumer: lambda.IFunction;
  shards: number;
  logRetention: cdk.aws_logs.RetentionDays;
}

export interface SyncInfra {
  stream: kinesis.Stream;
  cdcRole: iam.Role;
  cdcStream: cdk.CustomResource;
}

export function materializeSync(scope: Construct, props: SyncInfraProps): SyncInfra {
  const stack = cdk.Stack.of(scope);
  const clusterArn = `arn:${stack.partition}:dsql:${stack.region}:${stack.account}:cluster/${props.cluster.ref}`;

  const stream = new kinesis.Stream(scope, 'cdc', {
    streamName: cdcStreamName(props.fullId),
    streamMode: kinesis.StreamMode.PROVISIONED,
    shardCount: props.shards,
    // AWS-managed key (aws/kinesis): no key cost, and the DSQL role needs no KMS grant.
    encryption: kinesis.StreamEncryption.MANAGED,
    retentionPeriod: cdk.Duration.hours(24),
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  // An override, not the typed property: works with every supported aws-cdk-lib.
  (stream.node.defaultChild as kinesis.CfnStream).addPropertyOverride('MaxRecordSizeInKiB', MAX_RECORD_SIZE_KIB);

  // The role Aurora DSQL assumes to deliver CDC records. Confused-deputy
  // protection: only this account's DSQL streams on this cluster.
  const cdcRole = new iam.Role(scope, 'cdc-role', {
    assumedBy: new iam.ServicePrincipal('dsql.amazonaws.com', {
      conditions: {
        StringEquals: { 'aws:SourceAccount': stack.account },
        ArnLike: { 'aws:SourceArn': `${clusterArn}/stream/*` },
      },
    }),
    description: `Aurora DSQL CDC writer for ${props.fullId}`,
  });
  cdcRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ['kinesis:PutRecord', 'kinesis:PutRecords', 'kinesis:DescribeStreamSummary', 'kinesis:ListShards'],
      resources: [stream.streamArn],
    }),
  );

  const streamFn = new nodejs.NodejsFunction(scope, 'cdc-stream-fn', {
    // Compiled cdc-stream-lambda.js in dist/, next to this file.
    entry: join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'cdc-stream-lambda.js'),
    handler: 'onEvent',
    runtime: DEFAULT_NODE_RUNTIME,
    timeout: cdk.Duration.minutes(2),
    logGroup: new LogGroup(scope, 'cdc-stream-fn-logs', {
      retention: props.logRetention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
    // The Lambda runtime's bundled SDK may predate the DSQL stream APIs: bundle it.
    bundling: blocksNodejsBundling({ externalModules: [] }),
  });
  const completeFn = new nodejs.NodejsFunction(scope, 'cdc-stream-complete-fn', {
    entry: join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'cdc-stream-lambda.js'),
    handler: 'isComplete',
    runtime: DEFAULT_NODE_RUNTIME,
    timeout: cdk.Duration.seconds(30),
    logGroup: new LogGroup(scope, 'cdc-stream-complete-fn-logs', {
      retention: props.logRetention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
    bundling: blocksNodejsBundling({ externalModules: [] }),
  });
  const streamPolicy = new iam.PolicyStatement({
    actions: ['dsql:CreateStream', 'dsql:GetStream', 'dsql:DeleteStream'],
    resources: [clusterArn, `${clusterArn}/stream/*`],
  });
  for (const fn of [streamFn, completeFn]) fn.addToRolePolicy(streamPolicy);
  streamFn.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [cdcRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'dsql.amazonaws.com' } },
    }),
  );

  const provider = new cr.Provider(scope, 'cdc-stream-provider', {
    onEventHandler: streamFn,
    isCompleteHandler: completeFn,
    queryInterval: cdk.Duration.seconds(10),
    totalTimeout: cdk.Duration.minutes(15),
  });
  const cdcStream = new cdk.CustomResource(scope, 'cdc-stream', {
    serviceToken: provider.serviceToken,
    resourceType: 'Custom::DsqlCdcStream',
    properties: {
      ClusterIdentifier: props.cluster.ref,
      KinesisStreamArn: stream.streamArn,
      RoleArn: cdcRole.roleArn,
    },
  });
  cdcStream.node.addDependency(props.cluster);
  // The role's policy must exist before DSQL validates it.
  cdcStream.node.addDependency(cdcRole);

  // Consume from the tip: shapes reconcile against the current state, so
  // older records carry nothing a client needs. Retries are bounded so a
  // failing bell can't block the shard; a missed bell is caught by the
  // client's reconnect and safety reconciles.
  props.consumer.addEventSource(
    new KinesisEventSource(stream, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 1000,
      maxBatchingWindow: cdk.Duration.seconds(0),
      retryAttempts: 2,
      maxRecordAge: cdk.Duration.minutes(5),
      parallelizationFactor: 1,
    }),
  );

  return { stream, cdcRole, cdcStream };
}
