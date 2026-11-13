// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { Template, Match, Annotations } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { Scope, BlocksPresets, DEFAULT_NODE_RUNTIME, type BlocksDefaults } from '@aws-blocks/core/cdk';
import { getOrCreateVpc, initializeVpc } from '@aws-blocks/core/cdk/internal';
import { materialize } from './infra.js';
import { Database } from './index.cdk.js';

function synthWithRemovalPolicy(removalPolicy?: cdk.RemovalPolicy): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  materialize(stack, 'testdb', { databaseName: 'mydb', removalPolicy });
  return Template.fromStack(stack);
}

// These tests verify the contract that index.cdk.ts relies on:
// - removalPolicy=DESTROY → cluster is deletable (DeletionProtection=false)
// - removalPolicy=RETAIN  → cluster is retained and protected
//
// index.cdk.ts resolves the policy as `options.removalPolicy ?? this.defaults.removalPolicy`
// (the stack-wide sandbox/production posture) and passes it to materialize();
// that resolution is verified via cdk synth (see canary-publish-plan.md) because
// Database requires BlocksStack which can't be unit-tested without a full backend.

test('CDK: removalPolicy=DESTROY sets DeletionPolicy=Delete and DeletionProtection=false', () => {
  const template = synthWithRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  template.hasResource('AWS::RDS::DBCluster', {
    DeletionPolicy: 'Delete',
    Properties: { DeletionProtection: false },
  });
  template.hasResource('AWS::RDS::DBInstance', {
    DeletionPolicy: 'Delete',
  });
});

test('CDK: removalPolicy=undefined sets DeletionPolicy=Retain and DeletionProtection=true', () => {
  const template = synthWithRemovalPolicy(undefined);
  template.hasResource('AWS::RDS::DBCluster', {
    DeletionPolicy: 'Retain',
    Properties: { DeletionProtection: true },
  });
  template.hasResource('AWS::RDS::DBInstance', {
    DeletionPolicy: 'Retain',
  });
});

test('CDK: removalPolicy=SNAPSHOT sets DeletionPolicy=Snapshot and DeletionProtection=true', () => {
  const template = synthWithRemovalPolicy(cdk.RemovalPolicy.SNAPSHOT);
  template.hasResource('AWS::RDS::DBCluster', {
    DeletionPolicy: 'Snapshot',
    Properties: { DeletionProtection: true },
  });
});

test('CDK: migration Lambda log group adopts the resolved logRetention', () => {
  // The migration Lambda is only created when migrationsPath is provided.
  const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-data-migrations-'));
  fs.writeFileSync(path.join(migrationsDir, '001_init.sql'), 'SELECT 1;');
  try {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'MigrationRetentionStack');
    // index.cdk.ts passes this.defaults.logRetention; here we pass the resolved value directly.
    materialize(stack, 'testdb', {
      databaseName: 'mydb',
      migrationsPath: migrationsDir,
      logRetention: RetentionDays.ONE_WEEK,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  } finally {
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  }
});

test('CDK: an explicit clusterSubnets override is honored (placement resolves without throwing)', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'SubnetOverrideStack', { env: { account: '123456789012', region: 'us-east-1' } });
  // No vpcContext → materialize builds its own standalone isolated VPC. Passing
  // clusterSubnets takes the override branch (instead of the default selection);
  // an isolated selection matches that standalone VPC's tier and synthesizes.
  materialize(stack, 'testdb', {
    databaseName: 'mydb',
    clusterSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
});


// ── Database construct level (public DatabaseOptions → cluster props) ────────
// The tests above drive materialize() with internal CDK types, so the public
// option conversions in index.cdk.ts (ARN → kms.IKey, pointInTimeRecovery →
// backup.retention Duration) go untested. These exercise them through the real
// `Database` construct, which also makes the stack-wide `defaults` available.
//
// Harness mirrors bb-distributed-table/src/index.cdk.test.ts: a stub stack that
// exposes `executionRole` + `defaults` and registers itself as the ambient
// CURRENT_BLOCKS_STACK, with a plain `Scope` as the block's parent. `Database`
// resolves `this.defaults` / `this.executionRole` from that ambient stack.

class StubBlocksStack extends cdk.Stack {
  public readonly executionRole: cdk.aws_iam.IRole;
  public readonly id: string;
  public defaults: BlocksDefaults = BlocksPresets.production;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.id = id;
    (globalThis as any).CURRENT_BLOCKS_STACK = this;
    this.executionRole = new cdk.aws_iam.Role(this, 'BlocksRole', {
      assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    new cdk.aws_lambda.Function(this, 'StubHandler', {
      runtime: DEFAULT_NODE_RUNTIME,
      handler: 'index.handler',
      code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
      role: this.executionRole,
    });
  }
}

const ENCRYPT_FLAG = '@aws-blocks/bb-data:encryptStorageByDefault';

/**
 * Build a stub Blocks stack for Database synth tests. `context` defaults to none
 * (no `encryptStorageByDefault` flag, so storage is encrypted by default); pass
 * an explicit context to set the flag.
 */
function setupDatabaseStack(
  defaults: BlocksDefaults = BlocksPresets.production,
  context: Record<string, unknown> = {},
): {
  stack: StubBlocksStack;
  parent: Scope;
} {
  const app = new cdk.App({ context });
  const stack = new StubBlocksStack(app, 'TestStack');
  stack.defaults = defaults;
  const parent = new Scope('app');
  return { stack, parent };
}

test('Database: storageEncryptionKeyArn sets the cluster KmsKeyId to that ARN', () => {
  // No encryptStorageByDefault flag: the cluster is encrypted with that key.
  const { stack, parent } = setupDatabaseStack(BlocksPresets.production, {});
  const keyArn = 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234-ef56';
  new Database(parent, 'main', { storageEncryptionKeyArn: keyArn });
  const template = Template.fromStack(stack);
  // The ARN is imported via kms.Key.fromKeyArn, so the cluster references the
  // literal ARN string (not a Fn::GetAtt to a newly-minted key).
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    StorageEncrypted: true,
    KmsKeyId: keyArn,
  });
  // The same imported key encrypts the credentials secret (literal ARN), and a
  // CMK forces StorageEncrypted on with no encryptStorageByDefault flag set.
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    KmsKeyId: keyArn,
  });
  // Importing by ARN must not provision a new KMS key.
  template.resourceCountIs('AWS::KMS::Key', 0);
});

test('Database: storageEncryptionKeyArn wins over an encryptStorageByDefault flag set to false', () => {
  const { stack, parent } = setupDatabaseStack(BlocksPresets.production, { [ENCRYPT_FLAG]: false });
  const keyArn = 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234-ef56';
  new Database(parent, 'main', { storageEncryptionKeyArn: keyArn });
  Template.fromStack(stack).hasResourceProperties('AWS::RDS::DBCluster', {
    StorageEncrypted: true,
    KmsKeyId: keyArn,
  });
  Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp('storage-at-rest encryption is not enabled'));
});

for (const preset of [
  { name: 'production', defaults: BlocksPresets.production },
  { name: 'sandbox', defaults: BlocksPresets.sandbox },
]) {
  test(`Database (${preset.name}): an absent encryptStorageByDefault flag encrypts storage by default`, () => {
    const { stack, parent } = setupDatabaseStack(preset.defaults, {});
    new Database(parent, 'main', {});
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      StorageEncrypted: true,
      KmsKeyId: Match.absent(),
    });
    // The cluster carries the marker the pre-deploy storage-encryption check uses.
    const clusters = template.findResources('AWS::RDS::DBCluster');
    const metadata = Object.values(clusters)[0].Metadata;
    // The value is the Database's full id (also used in the synth warnings).
    assert.equal(metadata?.['@aws-blocks/bb-data:database'], 'TestStack-app-main');
    Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp('storage-at-rest encryption is not enabled'));
  });

  for (const flag of [true, 'true', 'True', ' TRUE ', 1, '1']) {
    test(`Database (${preset.name}): encryptStorageByDefault=${JSON.stringify(flag)} emits StorageEncrypted:true`, () => {
      const { stack, parent } = setupDatabaseStack(preset.defaults, { [ENCRYPT_FLAG]: flag });
      new Database(parent, 'main', {});
      Template.fromStack(stack).hasResourceProperties('AWS::RDS::DBCluster', {
        StorageEncrypted: true,
        KmsKeyId: Match.absent(),
      });
      Annotations.fromStack(stack).hasNoWarning(
        '*',
        Match.stringLikeRegexp('storage-at-rest encryption is not enabled'),
      );
    });
  }

  for (const flag of [false, 'false', 'False', ' FALSE ', 0, '0']) {
    test(`Database (${preset.name}): encryptStorageByDefault=${JSON.stringify(flag)} leaves StorageEncrypted unset (+ warning)`, () => {
      const { stack, parent } = setupDatabaseStack(preset.defaults, { [ENCRYPT_FLAG]: flag });
      new Database(parent, 'main', {});
      const template = Template.fromStack(stack);
      // Explicit opt-out keeps an existing implicitly-unencrypted cluster's
      // template unchanged: no StorageEncrypted property at all (never `false`).
      const clusters = template.findResources('AWS::RDS::DBCluster');
      const props = Object.values(clusters)[0].Properties;
      assert.ok(!('StorageEncrypted' in props), 'StorageEncrypted must be absent, not false');
      // ...and no pre-deploy check marker, so the opted-out template is unchanged.
      const metadata = Object.values(clusters)[0].Metadata ?? {};
      assert.ok(!('@aws-blocks/bb-data:database' in metadata), 'no storage-encryption marker when opted out');
      Annotations.fromStack(stack).hasWarning(
        '*',
        Match.stringLikeRegexp('storage-at-rest encryption is not enabled.*#enabling-storage-encryption-on-an-existing-database'),
      );
    });
  }

  for (const flag of ['yes', 'on', '', 2, { enabled: true }]) {
    test(`Database (${preset.name}): unrecognized encryptStorageByDefault=${JSON.stringify(flag)} fails synth`, () => {
      const { parent } = setupDatabaseStack(preset.defaults, { [ENCRYPT_FLAG]: flag });
      assert.throws(
        () => new Database(parent, 'main', {}),
        /unrecognized value .* Accepted values: true \/ false \(boolean\), 1 \/ 0/,
      );
    });
  }
}

test('Database: fromExisting() provisions no cluster without the encryptStorageByDefault flag', () => {
  const { stack, parent } = setupDatabaseStack(BlocksPresets.production, {});
  new Database(parent, 'ext', {
    connection: {
      host: 'arn:aws:rds:us-east-1:111122223333:cluster:restored',
      database: 'app',
      secretArn: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:owned-abc123',
    },
  });
  Template.fromStack(stack).resourceCountIs('AWS::RDS::DBCluster', 0);
});

test('Database: fromExisting() with provisioning-only options warns they are ignored', () => {
  const { stack, parent } = setupDatabaseStack();
  new Database(parent, 'ext', {
    connection: {
      host: 'arn:aws:rds:us-east-1:111122223333:cluster:ext-cluster',
      database: 'extdb',
      secretArn: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:ext-secret-aB1cD2',
    },
    storageEncryptionKeyArn: 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234-ef56',
    pointInTimeRecovery: { retentionDays: 7 },
  });
  Annotations.fromStack(stack).hasWarning(
    '*',
    Match.stringLikeRegexp('fromExisting\\(\\)'),
  );
});

test('Database: pointInTimeRecovery { retentionDays: 30 } sets BackupRetentionPeriod to 30', () => {
  const { stack, parent } = setupDatabaseStack();
  new Database(parent, 'main', { pointInTimeRecovery: { retentionDays: 30 } });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    BackupRetentionPeriod: 30,
  });
});

test('Database: pointInTimeRecovery: true keeps the 15-day enabled window', () => {
  const { stack, parent } = setupDatabaseStack();
  new Database(parent, 'main', { pointInTimeRecovery: true });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    BackupRetentionPeriod: 15,
  });
});

test('Database: pointInTimeRecovery: false clamps to the 1-day Aurora minimum (backups cannot be disabled)', () => {
  const { stack, parent } = setupDatabaseStack();
  new Database(parent, 'main', { pointInTimeRecovery: false });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    BackupRetentionPeriod: 1,
  });
});

test('Database: backup window follows the sandbox default (PITR off → clamped to 1 day)', () => {
  const { stack, parent } = setupDatabaseStack(BlocksPresets.sandbox);
  new Database(parent, 'main', {});
  const template = Template.fromStack(stack);
  // defaults.pointInTimeRecovery is false under sandbox, which clamps to 1 day.
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    BackupRetentionPeriod: 1,
  });
});

test('Database: an out-of-range retentionDays warns at synth and falls back to the 15-day default', () => {
  const { stack, parent } = setupDatabaseStack();
  new Database(parent, 'main', { pointInTimeRecovery: { retentionDays: 60 } });
  const template = Template.fromStack(stack);
  // Fallback value is applied...
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    BackupRetentionPeriod: 15,
  });
  // ...and the warning actually fires (warn-rather-than-throw).
  Annotations.fromStack(stack).hasWarning(
    '*',
    Match.stringLikeRegexp('retentionDays must be an integer between 1 and 35'),
  );
});

test('Database: retentionDays below the minimum (0) warns and falls back to 15', () => {
  // Pins the lower bound: 0 is < 1, so it must warn + fall back. This fails if the
  // guard is loosened from `days < 1` to `days < 0`.
  const { stack, parent } = setupDatabaseStack();
  new Database(parent, 'main', { pointInTimeRecovery: { retentionDays: 0 } });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    BackupRetentionPeriod: 15,
  });
  Annotations.fromStack(stack).hasWarning(
    '*',
    Match.stringLikeRegexp('retentionDays must be an integer between 1 and 35'),
  );
});

test('Database: a non-integer retentionDays (1.5) warns and falls back to 15', () => {
  // Pins the integer check: 1.5 is in [1, 35] but not an integer, so it must warn
  // + fall back rather than emit a fractional BackupRetentionPeriod.
  const { stack, parent } = setupDatabaseStack();
  new Database(parent, 'main', { pointInTimeRecovery: { retentionDays: 1.5 } });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    BackupRetentionPeriod: 15,
  });
  Annotations.fromStack(stack).hasWarning(
    '*',
    Match.stringLikeRegexp('retentionDays must be an integer between 1 and 35'),
  );
});

test('Database: engine log retention follows defaults.logRetention', () => {
  const { stack, parent } = setupDatabaseStack(BlocksPresets.production);
  new Database(parent, 'main', {});
  const template = Template.fromStack(stack);
  // cloudwatchLogsRetention is driven by defaults.logRetention (production →
  // ONE_YEAR = 365), applied via the CDK LogRetention custom resource.
  template.hasResourceProperties('Custom::LogRetention', {
    RetentionInDays: 365,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VPC source gating — the data-loss guard.
//
// A Database must join a CUSTOMER-provided shared VPC (as it always has), but
// must NEVER auto-join a Blocks-DERIVED shared VPC (e.g. one a container compute
// created). Auto-joining a derived VPC would move the cluster into a different
// VPC on a routine change — adding a container, or bumping the dependency to a
// version that derives one — which CloudFormation applies as a REPLACEMENT,
// destroying the database. These tests pin that invariant.
// ─────────────────────────────────────────────────────────────────────────────

test('Database: joins a customer-PROVIDED shared VPC (does not build its own)', () => {
  const { stack, parent } = setupDatabaseStack();
  const customerVpc = new ec2.Vpc(stack, 'CustomerVpc', { maxAzs: 2 });
  // Customer path: default source is 'provided'.
  initializeVpc(stack, { network: customerVpc });
  new Database(parent, 'main', {});
  const template = Template.fromStack(stack);
  // Only the customer VPC exists — the Database did NOT stand up its own.
  template.resourceCountIs('AWS::EC2::VPC', 1);
  // The cluster's subnet group is built from the customer VPC's subnets.
  template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
});

test('Database: IGNORES a Blocks-DERIVED shared VPC and builds its own (data-loss guard)', () => {
  const { stack, parent } = setupDatabaseStack();
  // Simulate what a container compute does: derive the shared root VPC and
  // publish it tagged source='derived'.
  const derivedVpc = getOrCreateVpc(stack);
  initializeVpc(stack, { network: derivedVpc }, 'derived');
  new Database(parent, 'main', {});
  const template = Template.fromStack(stack);
  // TWO VPCs: the derived shared one AND the Database's own `${name}Vpc`. The
  // Database refused to join the derived VPC, so its cluster stays in a VPC it
  // owns — adding a container never moves (and never replaces) the cluster.
  template.resourceCountIs('AWS::EC2::VPC', 2);
});

test('Database: with no shared VPC at all, builds its own (unchanged baseline)', () => {
  const { stack, parent } = setupDatabaseStack();
  new Database(parent, 'main', {});
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::EC2::VPC', 1);
});
