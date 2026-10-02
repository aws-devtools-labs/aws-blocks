// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { materialize } from './infra.js';
import { ELECTRIC_VPC_CIDR, materializeSync } from './sync-infra.js';
import { buildSetupStatements } from './sync-setup-lambda.js';

function synthSync(): Template {
  const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-data-sync-infra-'));
  fs.writeFileSync(path.join(migrationsDir, '001_init.sql'), 'CREATE TABLE todos (id TEXT PRIMARY KEY);');
  try {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'SyncStack', { env: { account: '123456789012', region: 'us-east-1' } });
    const aurora = materialize(stack, 'testdb', {
      databaseName: 'mydb',
      migrationsPath: migrationsDir,
      logicalReplication: true,
    });
    materializeSync(stack, { name: 'testdb', databaseName: 'mydb', tables: ['todos'], aurora });
    return Template.fromStack(stack);
  } finally {
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  }
}

const template = synthSync();

test('sync: the cluster gets a parameter group with logical replication on', () => {
  template.hasResourceProperties('AWS::RDS::DBClusterParameterGroup', {
    Parameters: { 'rds.logical_replication': '1' },
  });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    DBClusterParameterGroupName: Match.objectLike({ Ref: Match.anyValue() }),
  });
});

test('sync: without sync the cluster keeps the default parameter group', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'PlainStack');
  materialize(stack, 'testdb', { databaseName: 'mydb' });
  Template.fromStack(stack).resourceCountIs('AWS::RDS::DBClusterParameterGroup', 0);
});

test('sync: Electric runs in a peered VPC and the cluster accepts 5432 only from it', () => {
  template.resourceCountIs('AWS::EC2::VPCPeeringConnection', 1);
  template.hasResourceProperties('AWS::EC2::VPC', { CidrBlock: ELECTRIC_VPC_CIDR });
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'Security group for testdb Aurora cluster',
    SecurityGroupIngress: [Match.objectLike({ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, CidrIp: ELECTRIC_VPC_CIDR })],
  });
  template.hasResourceProperties('AWS::EC2::Route', { DestinationCidrBlock: ELECTRIC_VPC_CIDR });
});

test('sync: Electric task reads its secrets from Secrets Manager and publishes manually', () => {
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: [
      Match.objectLike({
        Image: Match.objectLike({ 'Fn::Join': Match.anyValue() }),
        Environment: Match.arrayWith([{ Name: 'ELECTRIC_MANUAL_TABLE_PUBLISHING', Value: 'true' }]),
        Secrets: Match.arrayWith([
          Match.objectLike({ Name: 'ELECTRIC_DB_PASSWORD' }),
          Match.objectLike({ Name: 'ELECTRIC_SECRET' }),
        ]),
      }),
    ],
  });
  template.hasResourceProperties('AWS::ECS::Service', {
    DesiredCount: 1,
    DeploymentConfiguration: Match.objectLike({ MinimumHealthyPercent: 0, MaximumPercent: 100 }),
  });
});

test('sync: the Electric HTTP API requires IAM auth', () => {
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: 'GET /v1/shape',
    AuthorizationType: 'AWS_IAM',
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
    ConnectionType: 'VPC_LINK',
    IntegrationType: 'HTTP_PROXY',
  });
});

test('sync: database setup runs after migrations, and Electric after setup', () => {
  const resources = template.toJSON().Resources as Record<string, { Type: string; DependsOn?: string[] }>;
  const setup = Object.entries(resources).find(
    ([id, r]) => r.Type === 'AWS::CloudFormation::CustomResource' && id.includes('SyncSetup'),
  );
  const service = Object.values(resources).find((r) => r.Type === 'AWS::ECS::Service');
  assert.ok(setup && service, 'setup custom resource and Electric service exist');
  assert.ok(setup[1].DependsOn?.some((dep) => dep.includes('MigrationCR')), 'setup depends on migrations');
  assert.ok(service.DependsOn?.includes(setup[0]), 'Electric service depends on setup');
});

test('sync setup: grants least privilege and publishes exactly the synced tables', () => {
  const statements = buildSetupStatements({
    tables: ['todos', 'app.projects'],
    database: 'mydb',
    password: 'abcDEF1234567890abcd',
    roleExists: false,
    publicationExists: false,
  });
  assert.deepStrictEqual(statements, [
    "CREATE ROLE electric WITH LOGIN PASSWORD 'abcDEF1234567890abcd'",
    'GRANT rds_replication TO electric',
    'GRANT CONNECT ON DATABASE "mydb" TO electric',
    'GRANT USAGE ON SCHEMA "public" TO electric',
    'GRANT USAGE ON SCHEMA "app" TO electric',
    'GRANT SELECT ON "todos" TO electric',
    'ALTER TABLE "todos" REPLICA IDENTITY FULL',
    'GRANT SELECT ON "app"."projects" TO electric',
    'ALTER TABLE "app"."projects" REPLICA IDENTITY FULL',
    'CREATE PUBLICATION electric_publication_default FOR TABLE "todos", "app"."projects"',
  ]);
  const again = buildSetupStatements({
    tables: ['todos'],
    database: 'mydb',
    password: 'abcDEF1234567890abcd',
    roleExists: true,
    publicationExists: true,
  });
  assert.strictEqual(again[0], "ALTER ROLE electric WITH LOGIN PASSWORD 'abcDEF1234567890abcd'");
  assert.strictEqual(again.at(-1), 'ALTER PUBLICATION electric_publication_default SET TABLE "todos"');
});

test('sync setup: refuses unsafe identifiers and passwords', () => {
  const base = { database: 'mydb', password: 'abcDEF1234567890abcd', roleExists: false, publicationExists: false };
  assert.throws(() => buildSetupStatements({ ...base, tables: ['todos; DROP TABLE x'] }), /Invalid table/);
  assert.throws(() => buildSetupStatements({ ...base, tables: ['todos'], password: "x'; --aaaaaaaaaaaa" }), /password/);
  assert.throws(() => buildSetupStatements({ ...base, tables: ['todos'], database: 'my"db' }), /database/);
});
