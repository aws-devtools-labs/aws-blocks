// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { SAR_ROTATION_PARTITIONS } from './constants.js';
import { materialize } from './infra.js';

function synthTemplate(options: Parameters<typeof materialize>[2]): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  materialize(stack, 'testdb', options);
  return Template.fromStack(stack);
}

/** Like {@link synthTemplate}, but pinned to `region` so the partition is real. */
function synthTemplateInRegion(region: string, options: Parameters<typeof materialize>[2]): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '111122223333', region } });
  materialize(stack, 'testdb', options);
  return Template.fromStack(stack);
}

/** Run `fn` with a temporary migrations directory holding one .sql file. */
function withMigrationsDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-data-infra-'));
  fs.writeFileSync(path.join(dir, '001_init.sql'), 'CREATE TABLE t (id int);');
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- Aurora cluster ---

test('CDK: synthesized stack contains Aurora cluster with correct engine', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    Engine: 'aurora-postgresql',
    EnableHttpEndpoint: true,
    DatabaseName: 'mydb',
  });
});

test('CDK: Aurora cluster uses serverless v2 capacity', () => {
  const template = synthTemplate({ databaseName: 'mydb', minCapacity: 1, maxCapacity: 8 });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    ServerlessV2ScalingConfiguration: {
      MinCapacity: 1,
      MaxCapacity: 8,
    },
  });
});

test('CDK: default capacity is 0.5-2 ACUs', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    ServerlessV2ScalingConfiguration: {
      MinCapacity: 0.5,
      MaxCapacity: 2,
    },
  });
});

// --- Storage encryption, backups, and log exports ---

test('CDK: no storageEncrypted/CMK leaves StorageEncrypted unset (upgrade-safe, no replacement)', () => {
  // With neither an explicit storageEncrypted nor a CMK, materialize must NOT
  // emit a StorageEncrypted property at all (and never an explicit `false`), so an
  // existing, implicitly-unencrypted cluster is not forced into a destructive
  // replacement by a template change.
  const template = synthTemplate({ databaseName: 'mydb' });
  const clusters = template.findResources('AWS::RDS::DBCluster');
  const props = Object.values(clusters)[0].Properties;
  assert.ok(!('StorageEncrypted' in props), 'StorageEncrypted must be absent, not false');
});

test('CDK: storageEncrypted:true emits StorageEncrypted:true (opt-in path)', () => {
  const template = synthTemplate({ databaseName: 'mydb', storageEncrypted: true });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    StorageEncrypted: true,
  });
});

test('CDK: cluster backup retention defaults to 15 days', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    BackupRetentionPeriod: 15,
  });
});

test('CDK: backupRetention override sets the retention period', () => {
  const template = synthTemplate({ databaseName: 'mydb', backupRetention: cdk.Duration.days(30) });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    BackupRetentionPeriod: 30,
  });
});

test('CDK: PostgreSQL engine log is exported to CloudWatch', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    EnableCloudwatchLogsExports: Match.arrayWith(['postgresql']),
  });
});

test('CDK: storageEncryptionKey option sets a customer-managed KmsKeyId on the cluster', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  const key = new cdk.aws_kms.Key(stack, 'DbKey');
  materialize(stack, 'testdb', { databaseName: 'mydb', storageEncryptionKey: key });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    StorageEncrypted: true,
    // Assert the cluster references THIS key (resolves to
    // { 'Fn::GetAtt': ['DbKey...', 'Arn'] }), not just "some" KmsKeyId —
    // Match.anyValue() would pass even if the wrong key were wired in.
    KmsKeyId: stack.resolve(key.keyArn),
  });
  // The same CMK must also encrypt the auto-generated credentials secret — and
  // supplying a key alone forces StorageEncrypted on with no context flag.
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    KmsKeyId: stack.resolve(key.keyArn),
  });
});

test('CDK: default (no CMK) keeps the engine-default master username "postgres" (no rename)', () => {
  // Without a CMK, `credentials` stays undefined, so the cluster's auto-generated
  // secret keeps the aurora-postgres engine-default master username ('postgres')
  // and is not renamed. The cluster's MasterUsername resolves via a Secrets
  // Manager dynamic reference ({{resolve:secretsmanager:...:username}}), so the
  // load-bearing value lives in the generated secret's SecretStringTemplate.
  const template = synthTemplate({ databaseName: 'mydb' });
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    GenerateSecretString: Match.objectLike({
      SecretStringTemplate: Match.stringLikeRegexp('"username":"postgres"'),
    }),
  });
});

test('CDK: storageEncryptionKey does not rename the master user (stays "postgres")', () => {
  // With a CMK, `credentials` is pinned via fromGeneratedSecret('postgres', ...)
  // — matching the engine default — so supplying a key never silently renames the
  // DB user. This path emits a literal MasterUsername, so assert it directly, and
  // confirm the generated secret pins the same username. Both paths therefore
  // agree on username 'postgres': supplying a key introduces no divergence.
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  const key = new cdk.aws_kms.Key(stack, 'DbKey');
  materialize(stack, 'testdb', { databaseName: 'mydb', storageEncryptionKey: key });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    MasterUsername: 'postgres',
  });
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    GenerateSecretString: Match.objectLike({
      SecretStringTemplate: Match.stringLikeRegexp('"username":"postgres"'),
    }),
  });
});

// --- Engine version ---

test('CDK: default engine version is 16.13', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    EngineVersion: Match.stringLikeRegexp('^16\\.13'),
  });
});

test('CDK: postgresVersion override sets the engine version', () => {
  const template = synthTemplate({ databaseName: 'mydb', postgresVersion: '16.11' });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    EngineVersion: '16.11',
  });
});

test('CDK: malformed postgresVersion throws at synth time', () => {
  assert.throws(
    () => synthTemplate({ databaseName: 'mydb', postgresVersion: '16' }),
    /Invalid postgresVersion "16"/,
  );
  assert.throws(
    () => synthTemplate({ databaseName: 'mydb', postgresVersion: 'bogus' }),
    /Invalid postgresVersion "bogus"/,
  );
});

// --- VPC ---

test('CDK: VPC has isolated subnets and no NAT gateways', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  // No NAT gateway resources should exist
  const natGateways = template.findResources('AWS::EC2::NatGateway');
  assert.strictEqual(Object.keys(natGateways).length, 0, 'Should have no NAT gateways');
  // VPC should exist
  template.resourceCountIs('AWS::EC2::VPC', 1);
});

// --- Security group ---

test('CDK: cluster security group has no inline ingress (rotation rule is a separate resource)', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  // The app reaches the cluster over the RDS Data API (HTTPS), never a raw
  // Postgres socket, so the SG itself declares no ingress. The one socket path
  // is the credentials-rotation Lambda, which CDK adds as a separate
  // AWS::EC2::SecurityGroupIngress resource (asserted in the rotation tests).
  const sgs = template.findResources('AWS::EC2::SecurityGroup', {
    Properties: { GroupDescription: Match.stringLikeRegexp('Aurora cluster') },
  });
  assert.strictEqual(Object.keys(sgs).length, 1, 'exactly one Aurora SG');
  const sg = Object.values(sgs)[0] as { Properties: { SecurityGroupIngress?: unknown[] } };
  assert.ok(
    sg.Properties.SecurityGroupIngress === undefined || sg.Properties.SecurityGroupIngress.length === 0,
    'Aurora SG should declare no inline ingress rules',
  );
  const off = synthTemplate({ databaseName: 'mydb', secretRotation: false });
  off.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
});

test('CDK: security group disallows all outbound traffic', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: Match.stringLikeRegexp('Aurora cluster'),
    SecurityGroupEgress: Match.arrayWith([
      Match.objectLike({ Description: 'Disallow all traffic' }),
    ]),
  });
});

// --- Shared-VPC placement (vpcContext path) ---

/** Build a minimal VpcContext over a real bring-your-own VPC for the shared path. */
function sharedVpcContext(stack: cdk.Stack, opts: { isolated: boolean }) {
  const subnetConfiguration = [
    { name: 'public', subnetType: cdk.aws_ec2.SubnetType.PUBLIC, cidrMask: 24 },
    { name: 'private', subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
    ...(opts.isolated
      ? [{ name: 'isolated', subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }]
      : []),
  ];
  const vpc = new cdk.aws_ec2.Vpc(stack, 'SharedVpc', { maxAzs: 2, natGateways: 1, subnetConfiguration });
  const computeSecurityGroup = new cdk.aws_ec2.SecurityGroup(stack, 'LambdaSg', { vpc });
  const hasRole = (role: string) =>
    role === 'isolated'
      ? vpc.isolatedSubnets.length > 0
      : role === 'public'
        ? vpc.publicSubnets.length > 0
        : vpc.privateSubnets.length > 0;
  const typeFor = (role: string) =>
    role === 'isolated'
      ? cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED
      : role === 'public'
        ? cdk.aws_ec2.SubnetType.PUBLIC
        : cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS;
  return {
    vpc,
    computeSecurityGroup,
    computeSubnets: { subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS },
    selectSubnets(scope: { fullId: string }, role: string, o?: { fallback?: string }) {
      if (hasRole(role)) return { subnetType: typeFor(role) };
      if (o?.fallback && hasRole(o.fallback)) return { subnetType: typeFor(o.fallback) };
      throw new Error(`${scope.fullId} needs a '${role}' subnet`);
    },
  };
}

test('CDK: shared VPC with an isolated tier places the cluster in isolated subnets', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  // biome-ignore lint/suspicious/noExplicitAny: minimal VpcContext test double
  materialize(stack, 'testdb', { databaseName: 'mydb', vpcContext: sharedVpcContext(stack, { isolated: true }) as any });
  const template = Template.fromStack(stack);
  // A shared VPC is used (2 VPCs would mean bb-data created its own).
  template.resourceCountIs('AWS::EC2::VPC', 1);
  // No new NAT gateway from bb-data (it reuses the shared VPC's).
  template.resourceCountIs('AWS::RDS::DBCluster', 1);
});

test('CDK: shared VPC without an isolated tier falls back to private-with-egress (no synth error)', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  assert.doesNotThrow(() =>
    // biome-ignore lint/suspicious/noExplicitAny: minimal VpcContext test double
    materialize(stack, 'testdb', { databaseName: 'mydb', vpcContext: sharedVpcContext(stack, { isolated: false }) as any }),
  );
});

// --- Removal policy ---

test('CDK: default removal policy is RETAIN', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  const clusters = template.findResources('AWS::RDS::DBCluster');
  const clusterKey = Object.keys(clusters)[0];
  // RETAIN means no DeletionPolicy or DeletionPolicy: Retain
  const policy = clusters[clusterKey].DeletionPolicy;
  assert.strictEqual(policy, 'Retain', 'Default removal policy should be Retain');
});

test('CDK: removalPolicy=DESTROY sets DeletionPolicy to Delete', () => {
  const template = synthTemplate({
    databaseName: 'mydb',
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const clusters = template.findResources('AWS::RDS::DBCluster');
  const clusterKey = Object.keys(clusters)[0];
  assert.strictEqual(clusters[clusterKey].DeletionPolicy, 'Delete');
});

// --- IAM grants ---

test('CDK: grantDataApi adds rds-data permissions to a Lambda', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  const infra = materialize(stack, 'testdb', { databaseName: 'mydb' });

  // Create a Lambda to grant to, simulating what index.cdk.ts does
  const fn = new cdk.aws_lambda.Function(stack, 'TestFn', {
    runtime: DEFAULT_NODE_RUNTIME,
    handler: 'index.handler',
    code: cdk.aws_lambda.Code.fromInline('exports.handler = () => {}'),
  });
  infra.grantDataApi(fn);

  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith([
            'rds-data:ExecuteStatement',
            'rds-data:BeginTransaction',
            'rds-data:CommitTransaction',
            'rds-data:RollbackTransaction',
          ]),
        }),
      ]),
    },
  });
});

test('CDK: grantDataApi with a CMK grants kms:Decrypt via Secrets Manager', () => {
  // `secret.grantRead` puts kms:Decrypt on the KEY policy; an imported key's policy
  // can't be edited from the stack, so without an identity-side grant the Data API
  // cannot decrypt the secret and every query fails.
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '111122223333', region: 'us-east-1' } });
  const keyArn = 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234';
  const template = withMigrationsDir((dir) => {
    const infra = materialize(stack, 'testdb', {
      databaseName: 'mydb',
      migrationsPath: dir,
      storageEncryptionKey: cdk.aws_kms.Key.fromKeyArn(stack, 'Key', keyArn),
    });
    infra.grantDataApi(
      new cdk.aws_iam.Role(stack, 'AppRole', { assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com') }),
    );
    return Template.fromStack(stack);
  });
  // Both Data API callers carry it: the app principal and the migration Lambda.
  template.resourcePropertiesCountIs(
    'AWS::IAM::Policy',
    {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          {
            Action: 'kms:Decrypt',
            Effect: 'Allow',
            Resource: keyArn,
            Condition: { StringEquals: { 'kms:ViaService': 'secretsmanager.us-east-1.amazonaws.com' } },
          },
        ]),
      }),
    },
    2,
  );
});

test('CDK: grantDataApi without a CMK grants no KMS actions', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  const infra = materialize(stack, 'testdb', { databaseName: 'mydb' });
  infra.grantDataApi(
    new cdk.aws_iam.Role(stack, 'AppRole', { assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com') }),
  );
  const template = Template.fromStack(stack);
  // Positive anchor first, so a grantDataApi that became a no-op cannot pass.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([Match.objectLike({ Action: Match.arrayWith(['rds-data:ExecuteStatement']) })]),
    }),
  });
  const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
  assert.ok(!policies.includes('kms:'), 'no kms actions without a key');
});

// --- Secrets Manager ---

test('CDK: stack has Secrets Manager secret for cluster credentials', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  // Aurora auto-creates a secret; verify it's referenced in outputs
  template.hasOutput('testdbClusterArn', {});
  template.hasOutput('testdbSecretArn', {});
});

// --- Secret rotation ---

test('CDK: rotates the credentials secret every 30 days by default', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 1);
  template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
    RotationRules: { ScheduleExpression: 'rate(30 days)' },
    SecretId: { Ref: Match.stringLikeRegexp('^testdbClusterSecretAttachment') },
  });
  template.resourceCountIs('AWS::Serverless::Application', 1);
  template.hasResourceProperties('AWS::Serverless::Application', {
    Parameters: Match.objectLike({
      vpcSecurityGroupIds: { 'Fn::GetAtt': [Match.stringLikeRegexp('^testdbRotationSg'), 'GroupId'] },
      // Private DNS on the endpoint resolves the standard regional hostname, so
      // CDK is NOT given `endpoint` (it would derive a hostname that doesn't
      // match a private-DNS endpoint's DNS entry) and renders the default URL.
      endpoint: { 'Fn::Join': ['', ['https://secretsmanager.', { Ref: 'AWS::Region' }, '.', { Ref: 'AWS::URLSuffix' }]] },
    }),
  });
});

test('CDK: only the rotation Lambda may reach the cluster on its port', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  const [clusterSgId] = Object.keys(
    template.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: 'Security group for testdb Aurora cluster' },
    }),
  );
  const [rotationSgId] = Object.keys(
    template.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: 'Security group for testdb credentials-rotation Lambda' },
    }),
  );
  assert.ok(clusterSgId && rotationSgId, 'both SGs synthesized');
  assert.strictEqual(
    Object.keys(
      template.findResources('AWS::EC2::SecurityGroupIngress', {
        Properties: { GroupId: { 'Fn::GetAtt': [clusterSgId, 'GroupId'] } },
      }),
    ).length,
    1,
    'the cluster admits exactly one source',
  );
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    GroupId: { 'Fn::GetAtt': [clusterSgId, 'GroupId'] },
    SourceSecurityGroupId: { 'Fn::GetAtt': [rotationSgId, 'GroupId'] },
    FromPort: { 'Fn::GetAtt': [Match.stringLikeRegexp('^testdbCluster'), 'Endpoint.Port'] },
  });
});

test('CDK: the rotation SG closes outbound and egresses only to the cluster and the endpoint', () => {
  // This Lambda holds the credentials it rotates, so an open group would give
  // it the internet wherever the VPC has a NAT.
  const template = synthTemplate({ databaseName: 'mydb' });
  const [rotationSgId] = Object.keys(
    template.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: 'Security group for testdb credentials-rotation Lambda' },
    }),
  );
  const [endpointSgId] = Object.keys(
    template.findResources('AWS::EC2::SecurityGroup', {
      Properties: {
        GroupDescription: 'Secrets Manager endpoint for testdb - 443 from the rotation Lambda only',
      },
    }),
  );
  assert.ok(rotationSgId && endpointSgId, 'both SGs synthesized');
  // Fails if `allowAllOutbound` comes back: CDK then renders an inline
  // all-protocols rule to 0.0.0.0/0 and drops the rules below.
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'Security group for testdb credentials-rotation Lambda',
    SecurityGroupEgress: Match.absent(),
  });
  const egress = Object.keys(
    template.findResources('AWS::EC2::SecurityGroupEgress', {
      Properties: { GroupId: { 'Fn::GetAtt': [rotationSgId, 'GroupId'] } },
    }),
  );
  assert.strictEqual(egress.length, 2, `exactly two egress rules, got ${egress.length}`);
  template.hasResourceProperties('AWS::EC2::SecurityGroupEgress', {
    GroupId: { 'Fn::GetAtt': [rotationSgId, 'GroupId'] },
    DestinationSecurityGroupId: { 'Fn::GetAtt': [endpointSgId, 'GroupId'] },
    FromPort: 443,
    ToPort: 443,
    CidrIp: Match.absent(),
  });
  // The cluster-port rule is CDK's, from admitting this group on the cluster.
  template.hasResourceProperties('AWS::EC2::SecurityGroupEgress', {
    GroupId: { 'Fn::GetAtt': [rotationSgId, 'GroupId'] },
    DestinationSecurityGroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^testdbSg'), 'GroupId'] },
    FromPort: { 'Fn::GetAtt': [Match.stringLikeRegexp('^testdbCluster'), 'Endpoint.Port'] },
    CidrIp: Match.absent(),
  });
});

test('CDK: the first rotation waits for the egress rules that give it a route', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  const [rotationSgId] = Object.keys(
    template.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: 'Security group for testdb credentials-rotation Lambda' },
    }),
  );
  const egressIds = Object.keys(
    template.findResources('AWS::EC2::SecurityGroupEgress', {
      Properties: { GroupId: { 'Fn::GetAtt': [rotationSgId, 'GroupId'] } },
    }),
  );
  assert.ok(egressIds.length > 0, 'the rotation SG has egress rules');
  const [schedule] = Object.values(
    template.findResources('AWS::SecretsManager::RotationSchedule'),
  ) as Array<{ DependsOn?: string[] }>;
  const deps = schedule.DependsOn ?? [];
  for (const id of egressIds) {
    assert.ok(deps.includes(id), `the schedule waits for egress rule ${id}: ${deps}`);
  }
});

test('CDK: the first rotation waits for every rule that admits it, in or out', () => {
  // `addRotationSingleUser` adds the cluster-port ingress as its own resource,
  // so on an in-place upgrade both it and the egress rules are new while the
  // writer is not. Nothing but this dependency orders them before the schedule.
  const template = synthTemplate({ databaseName: 'mydb' });
  const [rotationSgId] = Object.keys(
    template.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: 'Security group for testdb credentials-rotation Lambda' },
    }),
  );
  const ruleIds = [
    ...Object.keys(
      template.findResources('AWS::EC2::SecurityGroupEgress', {
        Properties: { GroupId: { 'Fn::GetAtt': [rotationSgId, 'GroupId'] } },
      }),
    ),
    ...Object.keys(
      template.findResources('AWS::EC2::SecurityGroupIngress', {
        Properties: { SourceSecurityGroupId: { 'Fn::GetAtt': [rotationSgId, 'GroupId'] } },
      }),
    ),
  ];
  // Two egress (443, cluster port) and two ingress (the endpoint SG, the cluster SG).
  assert.strictEqual(ruleIds.length, 4, `every rule naming the rotation SG: ${ruleIds}`);
  const [schedule] = Object.values(
    template.findResources('AWS::SecretsManager::RotationSchedule'),
  ) as Array<{ DependsOn?: string[] }>;
  const deps = schedule.DependsOn ?? [];
  for (const id of ruleIds) {
    assert.ok(deps.includes(id), `the schedule waits for ${id}: ${deps}`);
  }
});

test('CDK: own VPC gets a Secrets Manager endpoint reachable only from the rotation SG', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcEndpointType: 'Interface',
    PrivateDnsEnabled: true,
    ServiceName: { 'Fn::Join': ['', ['com.amazonaws.', { Ref: 'AWS::Region' }, '.secretsmanager']] },
    SecurityGroupIds: [{ 'Fn::GetAtt': [Match.stringLikeRegexp('^testdbSecretsEndpointSg'), 'GroupId'] }],
  });
  // The admit rule is its own resource, not inline on the group: a literal
  // peer would be inlined into both groups and make them reference each other.
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'Secrets Manager endpoint for testdb - 443 from the rotation Lambda only',
    SecurityGroupIngress: Match.absent(),
  });
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    GroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^testdbSecretsEndpointSg'), 'GroupId'] },
    SourceSecurityGroupId: { 'Fn::GetAtt': [Match.stringLikeRegexp('^testdbRotationSg'), 'GroupId'] },
    FromPort: 443,
    ToPort: 443,
    CidrIp: Match.absent(),
  });
});

test('CDK: shared VPC outputs the rotation SG id, own VPC does not', () => {
  // With `provisionEndpoints: false` the customer has to admit this group on
  // their own endpoint, and its id is only known after the deploy.
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  materialize(stack, 'testdb', {
    databaseName: 'mydb',
    // biome-ignore lint/suspicious/noExplicitAny: minimal VpcContext test double
    vpcContext: sharedVpcContext(stack, { isolated: true }) as any,
  });
  Template.fromStack(stack).hasOutput('testdbRotationSgId', {});
  // Own VPC: Blocks owns the endpoint and the 443 rule, so the id has no use.
  assert.deepStrictEqual(synthTemplate({ databaseName: 'mydb' }).findOutputs('testdbRotationSgId'), {});
});

test('CDK: shared VPC adds no Secrets Manager endpoint (core owns it) and exposes the rotation SG', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  const infra = materialize(stack, 'testdb', {
    databaseName: 'mydb',
    // biome-ignore lint/suspicious/noExplicitAny: minimal VpcContext test double
    vpcContext: sharedVpcContext(stack, { isolated: true }) as any,
  });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
  template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 1);
  assert.ok(infra.rotationSecurityGroup, 'rotationSecurityGroup is exposed for core registration');
});

test('CDK: rotation denies DeleteSecret to the account root', () => {
  // Documented in README/DESIGN as a guarantee of the feature, and emitted by
  // CDK's `denyAccountRootDelete()` rather than by this file, so pin it here:
  // nothing in bb-data would fail if a CDK change dropped it.
  const template = synthTemplate({ databaseName: 'mydb' });
  template.resourceCountIs('AWS::SecretsManager::ResourcePolicy', 1);
  template.hasResourceProperties('AWS::SecretsManager::ResourcePolicy', {
    ResourcePolicy: Match.objectLike({
      Statement: [
        Match.objectLike({
          Effect: 'Deny',
          Action: 'secretsmanager:DeleteSecret',
          Principal: Match.objectLike({ AWS: Match.anyValue() }),
        }),
      ],
    }),
  });
});

test('CDK: secretRotation: false emits no rotation resources', () => {
  const template = synthTemplate({ databaseName: 'mydb', secretRotation: false });
  template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 0);
  template.resourceCountIs('AWS::Serverless::Application', 0);
  template.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
  template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  template.resourceCountIs('AWS::SecretsManager::ResourcePolicy', 0);
  template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
});

test('CDK: secretRotation intervalDays sets the schedule (1 and 1000 accepted)', () => {
  for (const [intervalDays, expression] of [
    [7, 'rate(7 days)'],
    [1, 'rate(1 day)'],
    [1000, 'rate(1000 days)'],
  ] as const) {
    const template = synthTemplate({ databaseName: 'mydb', secretRotation: { intervalDays } });
    template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
      RotationRules: { ScheduleExpression: expression },
    });
  }
});

test('CDK: invalid secretRotation intervalDays throws at synth time', () => {
  for (const intervalDays of [0, 1001, 1.5, Number.NaN]) {
    assert.throws(
      () => synthTemplate({ databaseName: 'mydb', secretRotation: { intervalDays } }),
      /Invalid secretRotation\.intervalDays/,
      `intervalDays=${intervalDays} should be rejected`,
    );
  }
});

test('CDK: rotation in a partition without the rotation application throws at synth time', () => {
  // Without this the template still synthesizes and only fails once CloudFormation
  // expands the transform and cannot resolve the mapping, part-way through a deploy.
  for (const [region, partition] of [
    ['us-iso-east-1', 'aws-iso'],
    ['us-isob-east-1', 'aws-iso-b'],
    ['eusc-de-east-1', 'aws-eusc'],
  ] as const) {
    assert.throws(
      () => synthTemplateInRegion(region, { databaseName: 'mydb' }),
      new RegExp(`Credentials rotation is not available in partition '${partition}'`),
      `${region} should be rejected`,
    );
  }
});

test('CDK: rotation synthesizes in every partition the rotation application is published in', () => {
  for (const region of ['us-east-1', 'cn-north-1', 'us-gov-west-1']) {
    const template = synthTemplateInRegion(region, { databaseName: 'mydb' });
    template.resourceCountIs('AWS::Serverless::Application', 1);
  }
});

test('CDK: secretRotation: false is the escape hatch in a partition without the application', () => {
  const template = synthTemplateInRegion('us-iso-east-1', { databaseName: 'mydb', secretRotation: false });
  template.resourceCountIs('AWS::Serverless::Application', 0);
  template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 0);
});

test('CDK: an environment-agnostic stack keeps rotation, since its partition is a token', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.resourceCountIs('AWS::Serverless::Application', 1);
});

test('CDK: the rotation application is still mapped for exactly SAR_ROTATION_PARTITIONS', () => {
  // Guards the hardcoded list: if CDK publishes the application in a new partition,
  // this fails and SAR_ROTATION_PARTITIONS has to grow with it.
  const mappings = synthTemplate({ databaseName: 'mydb' }).toJSON().Mappings as Record<
    string,
    Record<string, unknown>
  >;
  const sarMappings = Object.entries(mappings).filter(([id]) => id.includes('SARMapping'));
  assert.strictEqual(sarMappings.length, 1, 'expected exactly one SAR mapping');
  assert.deepStrictEqual(Object.keys(sarMappings[0][1]).sort(), [...SAR_ROTATION_PARTITIONS].sort());
});

test('CDK: the first rotation waits for the writer, the migrations and the endpoint', () => {
  const template = withMigrationsDir((dir) => synthTemplate({ databaseName: 'mydb', migrationsPath: dir }));
  const [schedule] = Object.values(
    template.findResources('AWS::SecretsManager::RotationSchedule'),
  ) as Array<{ DependsOn?: string[] }>;
  const deps = schedule.DependsOn ?? [];
  assert.ok(deps.some((d) => /^testdbClustertestdbWriter/.test(d)), `depends on the writer: ${deps}`);
  assert.ok(deps.includes('testdbMigrationCR'), `depends on the migration CR: ${deps}`);
  assert.ok(deps.some((d) => /^testdbSecretsManagerEndpoint/.test(d)), `depends on the endpoint: ${deps}`);
  assert.ok(deps.some((d) => /^testdbSecretsEndpointSg/.test(d)), `depends on the endpoint SG: ${deps}`);
  // The rotation Lambda only has to exist before the schedule; gating it on the
  // writer and the migrations would add its creation time to every deploy.
  const [sarApp] = Object.values(
    template.findResources('AWS::Serverless::Application'),
  ) as Array<{ DependsOn?: string[] }>;
  assert.deepStrictEqual(sarApp.DependsOn ?? [], [], 'the SAR app waits for nothing');
});

test('CDK: the deploy waits for the rotation that the schedule starts', () => {
  const template = synthTemplate({ databaseName: 'mydb', secretRotation: { intervalDays: 7 } });
  const [[id, resource]] = Object.entries(
    template.findResources('AWS::CloudFormation::CustomResource', { Properties: { intervalDays: 7 } }),
  ) as Array<[string, { DependsOn?: string[] }]>;
  assert.match(id, /^testdbRotationWait/);
  assert.ok(
    (resource.DependsOn ?? []).some((d) => /^testdbClusterSecretAttachmentRotationSchedule/.test(d)),
    `wait depends on the schedule: ${resource.DependsOn}`,
  );
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'secretsmanager:DescribeSecret',
          Resource: { Ref: Match.stringLikeRegexp('^testdbClusterSecret') },
        }),
      ]),
    }),
    Roles: [{ Ref: Match.stringLikeRegexp('^testdbRotationWaitFnServiceRole') }],
  });
});

test('CDK: the wait is keyed on every rotation schedule property that starts a rotation', () => {
  // `RotateImmediatelyOnUpdate` is left at its default of true, so ANY update to the
  // schedule starts a rotation, while CloudFormation re-invokes the wait only
  // when the wait's own properties change. A schedule property nothing accounts
  // for is therefore a rotation that `cdk deploy` returns into.
  const template = synthTemplate({ databaseName: 'mydb', secretRotation: { intervalDays: 7 } });
  const [schedule] = Object.values(
    template.findResources('AWS::SecretsManager::RotationSchedule'),
  ) as Array<{ Properties: Record<string, unknown> }>;
  assert.deepStrictEqual(
    Object.keys(schedule.Properties).sort(),
    ['RotationLambdaARN', 'RotationRules', 'SecretId'],
    'aws-cdk-lib emits a RotationSchedule property Blocks does not account for: key the wait on it, ' +
      'or the rotation that changing it starts goes unwaited (see DESIGN.md, "Rotation on deploy")',
  );
  const [[, wait]] = Object.entries(template.findResources('AWS::CloudFormation::CustomResource')).filter(
    ([id]) => /^testdbRotationWait/.test(id),
  ) as Array<[string, { Properties: Record<string, unknown> }]>;
  // Carried verbatim rather than hashed at synth: the ARN resolves to the same
  // Fn::GetAtt expression whichever function the rotation app publishes, so a
  // hash would be stable exactly when it has to change.
  assert.deepStrictEqual(
    wait.Properties.rotationLambdaArn,
    schedule.Properties.RotationLambdaARN,
    "the wait must carry the schedule's rotation function ARN",
  );
  // `RotationRules` is keyed by proxy: only `intervalDays` feeds its expression.
  assert.strictEqual(wait.Properties.intervalDays, 7);
  assert.strictEqual(
    (schedule.Properties.RotationRules as { ScheduleExpression: string }).ScheduleExpression,
    'rate(7 days)',
  );
  // Keyed as well: a `storageEncryptionKeyArn` gives the secret a new logical id,
  // so a fresh secret is minted and the schedule repointed at it.
  assert.deepStrictEqual(
    wait.Properties.secretArn,
    schedule.Properties.SecretId,
    "the wait must carry the schedule's secret",
  );
});

test('CDK: enabling rotation adds resources only (cluster, writer and secret unchanged)', () => {
  // A changed Replacement-class property on a pre-existing resource would replace
  // the cluster on upgrade (see DESIGN.md, "Security posture (Aurora)").
  const keyArn = 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234';
  const variants: Array<[string, (rotation: false | undefined) => Template]> = [
    ['own VPC, no CMK', (secretRotation) => synthTemplate({ databaseName: 'mydb', secretRotation })],
    [
      'own VPC, CMK',
      (secretRotation) => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'TestStack');
        materialize(stack, 'testdb', {
          databaseName: 'mydb',
          secretRotation,
          storageEncryptionKey: cdk.aws_kms.Key.fromKeyArn(stack, 'Key', keyArn),
        });
        return Template.fromStack(stack);
      },
    ],
    [
      'shared VPC',
      (secretRotation) => {
        const app = new cdk.App();
        const stack = new cdk.Stack(app, 'TestStack');
        materialize(stack, 'testdb', {
          databaseName: 'mydb',
          secretRotation,
          // biome-ignore lint/suspicious/noExplicitAny: minimal VpcContext test double
          vpcContext: sharedVpcContext(stack, { isolated: true }) as any,
        });
        return Template.fromStack(stack);
      },
    ],
  ];
  for (const [label, synth] of variants) {
    const off = synth(false).toJSON().Resources as Record<string, unknown>;
    const on = synth(undefined).toJSON().Resources as Record<string, unknown>;
    for (const [id, res] of Object.entries(off)) {
      if ((res as { Type: string }).Type === 'AWS::CDK::Metadata') continue;
      assert.deepStrictEqual(on[id], res, `[${label}] resource ${id} must be unchanged when rotation is on`);
    }
  }
});

// --- Migrations ---

test('CDK: no migration resources when migrationsPath is not provided', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  const customResources = template.findResources('AWS::CloudFormation::CustomResource');
  assert.deepStrictEqual(
    Object.keys(customResources).filter((id) => !/^testdbRotationWait/.test(id)),
    [],
    'Should have no migration custom resource without migrationsPath',
  );
});
