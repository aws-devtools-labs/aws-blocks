// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VpcContext } from '@aws-blocks/core/cdk';
import { blocksNodejsBundling, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import {
  DEFAULT_MAX_CAPACITY,
  DEFAULT_MIN_CAPACITY,
  ENV_NAME_SANITIZE_PATTERN,
  ENV_VAR_PREFIX,
  VPC_MAX_AZS,
} from './constants.js';

/**
 * Configuration for Aurora Serverless v2 infrastructure.
 */
export interface AuroraInfraConfig {
  /** Minimum ACU capacity. @default 0.5 */
  minCapacity?: number;
  /** Maximum ACU capacity. @default 2 */
  maxCapacity?: number;
  /** PostgreSQL database name. */
  databaseName: string;
  /** Absolute path to migrations directory. If provided, migrations run on deploy. */
  migrationsPath?: string;
  /** CloudFormation removal policy for the Aurora cluster. @default RETAIN */
  removalPolicy?: cdk.RemovalPolicy;
  /**
   * Whether to enable RDS deletion protection. Resolved independently of
   * `removalPolicy` so the stack-wide `defaults.deletionProtection` is honored.
   * @default derived from removalPolicy (protected unless DESTROY)
   */
  deletionProtection?: boolean;
  /** Aurora PostgreSQL engine version, e.g. `'16.13'`. @default '16.13' */
  postgresVersion?: string;
  /**
   * Customer-managed KMS key for encrypting the cluster storage at rest. When
   * provided it is also used to encrypt the cluster's auto-generated credentials
   * secret. When omitted, storage encryption stays on but uses the account's
   * AWS-managed `aws/rds` key. Storage encryption itself is always enabled (see
   * `storageEncrypted: true` on the cluster).
   */
  storageEncryptionKey?: kms.IKey;
  /**
   * Retention period for the cluster's automated backups (which also drives the
   * point-in-time-recovery window). @default `cdk.Duration.days(15)` — matches
   * the SecureCDK baseline.
   */
  backupRetention?: cdk.Duration;
  /**
  /**
   * VPC context from the parent scope. When provided, Aurora is placed in the
   * shared VPC's isolated subnets instead of creating its own VPC.
   * @internal
   */
  vpcContext?: VpcContext;
  /**
   * Explicit subnet placement for the Aurora cluster, resolved from the
   * customer's `Database({ subnets })` option by the CDK layer. When provided,
   * it overrides the default isolated-preferred placement. Only meaningful with
   * a shared `vpcContext`.
   * @internal
   */
  clusterSubnets?: ec2.SubnetSelection;
  /**
   * CloudWatch retention for the migration Lambda's log group. Populated from
   * the stack-wide `defaults.logRetention`; when omitted the log group uses the
   * CDK `LogGroup` default retention.
   */
  logRetention?: cdk.aws_logs.RetentionDays;
}

/**
 * Output from Aurora infrastructure materialization.
 */
export interface AuroraInfraOutputs {
  /** The Aurora cluster construct. */
  cluster: rds.DatabaseCluster;
  /** Cluster ARN for Data API calls. */
  clusterArn: string;
  /** Secrets Manager secret ARN for credentials. */
  secretArn: string;
  /** Database name. */
  databaseName: string;
  /**
   * Environment variables to inject into the Lambda handler.
   * Keys follow the `BLOCKS_{name}_*` convention that DataApiEngine reads.
   */
  envVars: Record<string, string>;
  /**
   * Grant Data API permissions to a Lambda or other IAM principal.
   *
   * @example
   * const infra = materialize(stack, 'mydb', { databaseName: 'mydb' });
   * infra.grantDataApi(lambdaFunction);
   */
  grantDataApi: (grantee: iam.IGrantable) => void;
}

/**
 * Provision Aurora Serverless v2 PostgreSQL with Data API enabled.
 *
 * Creates: VPC (2 AZs, isolated subnets, no NAT), Aurora cluster,
 * Secrets Manager credentials, security group, IAM grants, and CfnOutputs.
 *
 * @param scope - CDK construct scope
 * @param name - Logical name used for resource naming and env var prefix
 * @param options - Capacity and database name configuration
 * @returns Infrastructure outputs including env vars and grant function
 *
 * @example
 * const infra = materialize(stack, 'main', { databaseName: 'main' });
 * Object.entries(infra.envVars).forEach(([k, v]) => handler.addEnvironment(k, v));
 * infra.grantDataApi(handler);
 */
export function materialize(scope: Construct, name: string, options: AuroraInfraConfig): AuroraInfraOutputs {
  const { minCapacity = DEFAULT_MIN_CAPACITY, maxCapacity = DEFAULT_MAX_CAPACITY, databaseName } = options;
  const envName = name.replace(ENV_NAME_SANITIZE_PATTERN, '_');

  // Determine VPC (shared or standalone)
  const vpc =
    options.vpcContext?.vpc ??
    new ec2.Vpc(scope, `${name}Vpc`, {
      maxAzs: VPC_MAX_AZS,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
    });

  // Pick where the cluster lands.
  //
  // Standalone: we build the VPC above with a dedicated isolated tier, so pin to it.
  //
  // Shared (bring-your-own) VPC: the isolated tier is not guaranteed. The VPC in
  // every docs example (`new ec2.Vpc(app, 'AppVpc', { maxAzs: 2, natGateways: 1 })`)
  // has only public + private-with-egress subnets, so hard-requiring PRIVATE_ISOLATED
  // makes the documented setup fail synth with "no isolated subnet groups in this VPC".
  // Aurora is reached over the RDS Data API (HTTPS via the interface endpoint), never a
  // raw socket, so the placement tier doesn't affect reachability — it only has to be a
  // tier the VPC actually has. Prefer isolated when present (keeps the DB off any NAT
  // path), otherwise fall back to private-with-egress.
  let clusterSubnets: ec2.SubnetSelection;
  if (options.clusterSubnets) {
    // Customer explicitly chose placement via Database({ subnets }); honor it.
    clusterSubnets = options.clusterSubnets;
  } else if (options.vpcContext) {
    // Prefer the isolated tier when the VPC has one (keeps the DB off any NAT
    // path); otherwise fall back to private-with-egress. selectSubnets throws an
    // instructive, BB-named error if neither exists. `name` is the BB's fullId
    // here (Database calls materialize(this, this.fullId, …)).
    clusterSubnets = options.vpcContext.selectSubnets({ fullId: name }, 'isolated', {
      fallback: 'private-with-egress',
    });
  } else {
    clusterSubnets = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };
  }

  // Security group for the cluster. No ingress rule: the cluster runs with
  // `enableDataApi: true` and is reached exclusively over the RDS Data API
  // (HTTPS via the Secrets Manager + RDS Data interface endpoints), never a raw
  // Postgres socket. A 5432 ingress rule would imply a direct DB connection path
  // that nothing in Blocks uses. Egress stays closed for the same reason.
  const securityGroup = new ec2.SecurityGroup(scope, `${name}Sg`, {
    vpc,
    description: `Security group for ${name} Aurora cluster`,
    allowAllOutbound: false,
  });

  // Aurora Serverless v2 cluster with Data API enabled
  const removalPolicy = options.removalPolicy ?? cdk.RemovalPolicy.RETAIN;

  // Aurora PostgreSQL engine version. Kept configurable because AWS periodically
  // retires older minor versions — 16.4 was retired in us-east-1, after which
  // CreateDBCluster failed with "Cannot find version 16.4 for aurora-postgresql".
  // Default to the latest available 16.x (16.13) for the longest deprecation
  // runway; callers can override via `postgresVersion` when AWS retires it too.
  // Validate the override up front so a malformed value fails fast at synth
  // time with a clear message, instead of as an opaque CreateDBCluster error.
  let engineVersion: rds.AuroraPostgresEngineVersion;
  if (options.postgresVersion === undefined) {
    engineVersion = rds.AuroraPostgresEngineVersion.VER_16_13;
  } else {
    if (!/^\d+\.\d+$/.test(options.postgresVersion)) {
      throw new Error(
        `Invalid postgresVersion "${options.postgresVersion}"; expected "MAJOR.MINOR" like "16.13".`,
      );
    }
    const majorVersion = options.postgresVersion.split('.')[0];
    engineVersion = rds.AuroraPostgresEngineVersion.of(options.postgresVersion, majorVersion);
  }

  // Backup retention for the cluster's automated backups. Aurora keeps continuous
  // backups within this window, which is also what point-in-time recovery restores
  // from. Default to 15 days to match the SecureCDK baseline cited in the AppSec
  // finding; callers may override via `backupRetention`.
  const backupRetention = options.backupRetention ?? cdk.Duration.days(15);

  const cluster = new rds.DatabaseCluster(scope, `${name}Cluster`, {
    engine: rds.DatabaseClusterEngine.auroraPostgres({
      version: engineVersion,
    }),
    serverlessV2MinCapacity: minCapacity,
    serverlessV2MaxCapacity: maxCapacity,
    writer: rds.ClusterInstance.serverlessV2(`${name}Writer`),
    vpc,
    vpcSubnets: clusterSubnets,
    securityGroups: [securityGroup],
    defaultDatabaseName: databaseName,
    enableDataApi: true,
    // Encrypt cluster storage at rest. Set explicitly rather than relying on the
    // implicit RDS default so the intent is visible in synth/CloudFormation output.
    // With a `storageEncryptionKey` the cluster uses that customer-managed key;
    // without one, `storageEncrypted: true` uses the account's AWS-managed
    // `aws/rds` key (an acceptable default).
    storageEncrypted: true,
    storageEncryptionKey: options.storageEncryptionKey,
    // When a CMK is supplied, also encrypt the auto-generated credentials secret
    // with it. CDK cannot set an encryption key on the cluster's auto-generated
    // secret without providing an explicit generated-secret credential, so we pin
    // the exact master username the aurora-postgres engine defaults to
    // ('postgres') — keeping the generated credentials identical apart from the
    // secret's KMS key. Without a CMK, credentials stay undefined so the default
    // AWS-managed secret encryption is unchanged.
    credentials: options.storageEncryptionKey
      ? rds.Credentials.fromGeneratedSecret('postgres', { encryptionKey: options.storageEncryptionKey })
      : undefined,
    // Retain automated backups (and the PITR window they provide).
    backup: { retention: backupRetention },
    // Export the PostgreSQL engine log to CloudWatch Logs. Retention follows the
    // stack-wide `defaults.logRetention` when provided (the same knob every other
    // Blocks-managed log group reads); when omitted, CloudWatch keeps the log
    // group at the account default retention.
    cloudwatchLogsExports: ['postgresql'],
    cloudwatchLogsRetention: options.logRetention,
    // iamAuthentication is intentionally NOT enabled: the cluster is reached
    // exclusively over the RDS Data API (HTTPS + Secrets Manager credentials),
    // never a direct DB socket, so database-level IAM authentication does not
    // apply here (explicit acknowledgement per the AppSec finding). Automatic
    // secret rotation is likewise a deliberate follow-up: it requires a rotation
    // Lambda wired into the cluster VPC, a larger change than this hardening pass.
    // Read independently from defaults (falling back to the removalPolicy-derived
    // value for direct materialize() callers that don't pass it).
    deletionProtection: options.deletionProtection ?? removalPolicy !== cdk.RemovalPolicy.DESTROY,
    removalPolicy,
  });

  const secret = cluster.secret;
  if (!secret) {
    throw new Error(
      `Aurora cluster '${name}' did not generate a Secrets Manager secret. ` +
        `Ensure defaultDatabaseName is set.`,
    );
  }

  // Environment variables matching what DataApiEngine reads at runtime
  const envVars: Record<string, string> = {
    [`${ENV_VAR_PREFIX}_${envName}_CLUSTER_ARN`]: cluster.clusterArn,
    [`${ENV_VAR_PREFIX}_${envName}_SECRET_ARN`]: secret.secretArn,
    [`${ENV_VAR_PREFIX}_${envName}_DATABASE`]: databaseName,
  };

  /**
   * Grant rds-data:* and secretsmanager:GetSecretValue to a principal.
   * Call this with the Lambda handler to allow Data API access.
   */
  const grantDataApi = (grantee: iam.IGrantable) => {
    grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'rds-data:ExecuteStatement',
        'rds-data:BatchExecuteStatement',
        'rds-data:BeginTransaction',
        'rds-data:CommitTransaction',
        'rds-data:RollbackTransaction',
      ],
      resources: [cluster.clusterArn],
    }));
    secret.grantRead(grantee);
  };

  new cdk.CfnOutput(scope, `${name}ClusterArn`, { value: cluster.clusterArn });
  new cdk.CfnOutput(scope, `${name}SecretArn`, { value: secret.secretArn });

  // Run migrations on deploy if migrationsPath is provided
  if (options.migrationsPath) {
    const migrationsHash = hashMigrationsDir(options.migrationsPath);
    const migrationFn = new lambda.NodejsFunction(scope, `${name}MigrationFn`, {
      // Points at the compiled migration-lambda.js in dist/ (same directory as this file at runtime).
      // Must NOT use ../src/migration-lambda.ts — src/ is excluded from the published package.
      entry: join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'migration-lambda.js'),
      handler: 'handler',
      runtime: DEFAULT_NODE_RUNTIME,
      timeout: cdk.Duration.minutes(5),
      logGroup: new LogGroup(scope, `${name}MigrationLogs`, {
        retention: options.logRetention,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        CLUSTER_ARN: cluster.clusterArn,
        SECRET_ARN: secret.secretArn,
        DATABASE_NAME: databaseName,
        MIGRATIONS_DIR: '/var/task/migrations',
      },
      bundling: blocksNodejsBundling({
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_inputDir: string, outputDir: string) => [
            `cp -r ${options.migrationsPath} ${outputDir}/migrations`,
          ],
        },
        externalModules: ['@aws-sdk/*'],
      }),
    });
    grantDataApi(migrationFn);

    const provider = new cr.Provider(scope, `${name}MigrationProvider`, {
      onEventHandler: migrationFn,
    });

    const migrationCR = new cdk.CustomResource(scope, `${name}MigrationCR`, {
      serviceToken: provider.serviceToken,
      properties: { migrationsHash },
    });

    // Ensure the migration custom resource waits for the Aurora writer instance.
    // Without this, CloudFormation may invoke the migration Lambda before the
    // writer is available, causing "Cannot find DBInstance in DBCluster".
    // Use node.defaultChild to get the underlying CfnResource, then
    // CfnResource.addDependency for a proper CFN-level DependsOn.
    const cfnMigrationCR = migrationCR.node.defaultChild as cdk.CfnResource;
    const cfnWriter = cluster.node.findAll().find((c) => (c as any).cfnResourceType === 'AWS::RDS::DBInstance') as
      | cdk.CfnResource
      | undefined;
    if (cfnMigrationCR && cfnWriter) {
      cfnMigrationCR.addDependency(cfnWriter);
    }
  }

  return {
    cluster,
    clusterArn: cluster.clusterArn,
    secretArn: secret.secretArn,
    databaseName,
    envVars,
    grantDataApi,
  };
}

/** Hash all .sql files in a directory to detect changes. */
const hashMigrationsDir = (dir: string): string => {
  const hash = createHash('sha256');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    hash.update(file);
    hash.update(readFileSync(join(dir, file), 'utf-8'));
  }
  return hash.digest('hex').slice(0, 16);
};

/**
 * Grant Data API permissions for an external database (not managed by this BB).
 * Used when `fromExisting()` provides connection details.
 */
export const grantExternalDataApi = (
  scope: Construct,
  name: string,
  conn: { host: string; secretArn: string },
  grantee: iam.IGrantable,
) => {
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: [
      'rds-data:ExecuteStatement',
      'rds-data:BatchExecuteStatement',
      'rds-data:BeginTransaction',
      'rds-data:CommitTransaction',
      'rds-data:RollbackTransaction',
    ],
    resources: [conn.host],
  }));
  const secret = cdk.aws_secretsmanager.Secret.fromSecretCompleteArn(scope, `${name}ExtSecret`, conn.secretArn);
  secret.grantRead(grantee);
};
