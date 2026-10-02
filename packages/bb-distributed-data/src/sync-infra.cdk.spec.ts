// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK tests for `DistributedDatabase({ sync })`: the CDC target stream, the
 * least-privilege role Aurora DSQL assumes, the CDC stream custom resource,
 * and the Kinesis event source on the block's Lambda compute.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { BlocksPresets, BlocksStack } from '@aws-blocks/core/cdk';
import type { DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DistributedDatabase } from './index.cdk.js';

const lambdaFactory: DefaultComputeFactory = (root) => new LambdaCompute(root as never, 'DefaultCompute');
const __dirname = dirname(fileURLToPath(import.meta.url));
let tmpDir: string;
let handlerPath: string;
let backendPath: string;

before(() => {
  // Satisfies `assertCdkConditionActive()` in `BlocksStack.create()`.
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
  tmpDir = mkdtempSync(join(__dirname, 'tmp-ddata-sync-cdk-'));
  handlerPath = join(tmpDir, 'handler.mjs');
  writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
  backendPath = join(tmpDir, 'backend.mjs');
  writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function synth(id: string, build: (stack: BlocksStack) => void): Promise<{ stack: BlocksStack; template: Template }> {
  const stack = await BlocksStack.create(new cdk.App(), id, {
    backendHandlerPath: handlerPath,
    backendCDKPath: backendPath,
    defaults: BlocksPresets.sandbox,
    defaultComputeFactory: lambdaFactory,
  });
  build(stack);
  return { stack, template: Template.fromStack(stack) };
}

describe('DistributedDatabase sync infrastructure', () => {
  test('no sync, no CDC resources', async () => {
    const { template } = await synth('NoSync', (stack) => {
      new DistributedDatabase(stack, `db${stack.stackName}`);
    });
    template.resourceCountIs('AWS::Kinesis::Stream', 0);
    template.resourceCountIs('Custom::DsqlCdcStream', 0);
  });

  test('a provisioned 1-shard stream with 10 MiB records and an AWS-managed key', async () => {
    const { template } = await synth('SyncStream', (stack) => {
      new DistributedDatabase(stack, `db${stack.stackName}`, { sync: { tables: ['todos'] } });
    });
    template.resourceCountIs('AWS::Kinesis::Stream', 1);
    template.hasResourceProperties('AWS::Kinesis::Stream', {
      ShardCount: 1,
      StreamModeDetails: { StreamMode: 'PROVISIONED' },
      MaxRecordSizeInKiB: 10240,
      RetentionPeriodHours: 24,
      StreamEncryption: { EncryptionType: 'KMS', KeyId: 'alias/aws/kinesis' },
    });
  });

  test('the CDC role trusts only DSQL streams of this cluster in this account, and only writes', async () => {
    const { template } = await synth('SyncRole', (stack) => {
      new DistributedDatabase(stack, `db${stack.stackName}`, { sync: { tables: ['todos'] } });
    });
    const roles = template.findResources('AWS::IAM::Role', {
      Properties: {
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([Match.objectLike({ Principal: { Service: 'dsql.amazonaws.com' } })]),
        },
      },
    });
    const [roleId, role] = Object.entries(roles)[0] ?? [];
    assert.ok(roleId, 'a role trusted by dsql.amazonaws.com');
    const trust = JSON.stringify((role as { Properties: unknown }).Properties);
    assert.match(trust, /aws:SourceAccount/);
    assert.match(trust, /aws:SourceArn/);
    assert.match(trust, /\/stream\/\*/);

    const policies = template.findResources('AWS::IAM::Policy', {
      Properties: { Roles: [{ Ref: roleId }] },
    });
    const statements = Object.values(policies).flatMap(
      (policy) => (policy as { Properties: { PolicyDocument: { Statement: { Action: string[] }[] } } }).Properties.PolicyDocument.Statement,
    );
    assert.deepStrictEqual(statements.flatMap((s) => s.Action).sort(), [
      'kinesis:DescribeStreamSummary',
      'kinesis:ListShards',
      'kinesis:PutRecord',
      'kinesis:PutRecords',
    ]);
  });

  test('a CDC stream custom resource; the creator may pass only the CDC role, only to DSQL', async () => {
    const { template } = await synth('SyncStreamCr', (stack) => {
      new DistributedDatabase(stack, `db${stack.stackName}`, { sync: { tables: ['todos'] } });
    });
    template.resourceCountIs('Custom::DsqlCdcStream', 1);
    template.hasResourceProperties('Custom::DsqlCdcStream', {
      ClusterIdentifier: { Ref: Match.anyValue() },
      KinesisStreamArn: Match.anyValue(),
      RoleArn: Match.anyValue(),
    });
    for (const statement of [
      { Action: 'iam:PassRole', Condition: { StringEquals: { 'iam:PassedToService': 'dsql.amazonaws.com' } } },
      { Action: ['dsql:CreateStream', 'dsql:GetStream', 'dsql:DeleteStream'] },
    ]) {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: { Statement: Match.arrayWith([Match.objectLike(statement)]) },
      });
    }
  });

  test('the block Lambda consumes the stream from the tip with bounded retries', async () => {
    const { stack, template } = await synth('SyncConsumer', (stack) => {
      new DistributedDatabase(stack, `db${stack.stackName}`, { sync: { tables: ['todos'], shards: 2 } });
    });
    template.hasResourceProperties('AWS::Kinesis::Stream', { ShardCount: 2 });
    const fn = (stack._defaultCompute as LambdaCompute).fn;
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionName: { Ref: stack.getLogicalId(fn.node.defaultChild as cdk.CfnElement) },
      StartingPosition: 'LATEST',
      MaximumRetryAttempts: 2,
      MaximumRecordAgeInSeconds: 300,
    });
  });

  test('registers the bell, the token secret, and the shape route', async () => {
    const { template } = await synth('SyncRoute', (stack) => {
      new DistributedDatabase(stack, `db${stack.stackName}`, { sync: { tables: ['todos'] } });
    });
    // Realtime → a WebSocket API; AppSetting secret → its custom resource; the route index → a table.
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    const routeTables = Object.entries(template.findResources('AWS::DynamoDB::Table')).filter(([id]) =>
      id.toLowerCase().includes('syncroutestable'),
    );
    assert.strictEqual(routeTables.length, 1, `a route index table: ${routeTables.map(([id]) => id).join(', ')}`);
    // Both keys are strings (keys and value hashes are text).
    const definitions = (routeTables[0][1] as { Properties: { AttributeDefinitions: { AttributeName: string; AttributeType: string }[] } })
      .Properties.AttributeDefinitions;
    assert.deepStrictEqual(
      definitions.map((d) => `${d.AttributeName}:${d.AttributeType}`).sort(),
      ['pk:S', 'sk:S'],
    );
    assert.match(JSON.stringify(template.toJSON()), /sync-token-secret/);
  });

  test('rejects invalid sync options at synth', async () => {
    await assert.rejects(
      synth('SyncBadTable', (stack) => {
        new DistributedDatabase(stack, `db${stack.stackName}`, { sync: { tables: ['Todos'] } });
      }),
      /not a valid unquoted identifier/,
    );
    await assert.rejects(
      synth('SyncBadShards', (stack) => {
        new DistributedDatabase(stack, `db${stack.stackName}`, { sync: { tables: ['todos'], shards: 0 } });
      }),
      /sync.shards must be a positive integer/,
    );
  });
});
