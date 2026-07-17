// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENV_NAME_SANITIZE_PATTERN,
  ENV_VAR_PREFIX,
  DEFAULT_POSTGRES_PORT,
  DEFAULT_MIN_CAPACITY,
  DEFAULT_MAX_CAPACITY,
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
  /** Aurora PostgreSQL engine version, e.g. `'16.13'`. @default '16.13' */
  postgresVersion?: string;
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
export function materialize(
  scope: Construct,
  name: string,
  options: AuroraInfraConfig,
): AuroraInfraOutputs {
  const { minCapacity = DEFAULT_MIN_CAPACITY, maxCapacity = DEFAULT_MAX_CAPACITY, databaseName } = options;
  const envName = name.replace(ENV_NAME_SANITIZE_PATTERN, '_');

  // VPC with isolated subnets only — no NAT gateways needed for Data API path
  const vpc = new ec2.Vpc(scope, `${name}Vpc`, {
    maxAzs: VPC_MAX_AZS,
    natGateways: 0,
    subnetConfiguration: [
      { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    ],
  });

  // Security group allowing inbound PostgreSQL from within the VPC
  const securityGroup = new ec2.SecurityGroup(scope, `${name}Sg`, {
    vpc,
    description: `Security group for ${name} Aurora cluster`,
    allowAllOutbound: false,
  });
  securityGroup.addIngressRule(
    ec2.Peer.ipv4(vpc.vpcCidrBlock),
    ec2.Port.tcp(DEFAULT_POSTGRES_PORT),
    'Allow PostgreSQL from VPC',
  );

  // Aurora Serverless v2 cluster with Data API enabled
  const removalPolicy = options.removalPolicy ?? cdk.RemovalPolicy.RETAIN;

  // Aurora PostgreSQL engine version. Kept configurable because AWS periodically
  // retires older minor versions — 16.4 was retired in us-east-1, after which
  // CreateDBCluster failed with "Cannot find version 16.4 for aurora-postgresql".
  // Default to the latest available 16.x (16.13) for the longest deprecation
  // runway; callers can override via `postgresVersion` when AWS retires it too.
  const engineVersion = options.postgresVersion
    ? rds.AuroraPostgresEngineVersion.of(
        options.postgresVersion,
        options.postgresVersion.split('.')[0] ?? options.postgresVersion,
      )
    : rds.AuroraPostgresEngineVersion.VER_16_13;

  const cluster = new rds.DatabaseCluster(scope, `${name}Cluster`, {
    engine: rds.DatabaseClusterEngine.auroraPostgres({
      version: engineVersion,
    }),
    serverlessV2MinCapacity: minCapacity,
    serverlessV2MaxCapacity: maxCapacity,
    writer: rds.ClusterInstance.serverlessV2(`${name}Writer`),
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    securityGroups: [securityGroup],
    defaultDatabaseName: databaseName,
    enableDataApi: true,
    deletionProtection: removalPolicy !== cdk.RemovalPolicy.DESTROY,
    removalPolicy,
  });

  const secret = cluster.secret;
  if (!secret) {
    throw new Error(
      `Aurora cluster '${name}' did not generate a Secrets Manager secret. ` +
      `Ensure defaultDatabaseName is set.`
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
      environment: {
        CLUSTER_ARN: cluster.clusterArn,
        SECRET_ARN: secret.secretArn,
        DATABASE_NAME: databaseName,
        MIGRATIONS_DIR: '/var/task/migrations',
      },
      bundling: {
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp -r ${options.migrationsPath} ${outputDir}/migrations`,
          ],
        },
        externalModules: ['@aws-sdk/*'],
      },
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
    const cfnWriter = cluster.node.findAll().find(
      c => (c as any).cfnResourceType === 'AWS::RDS::DBInstance'
    ) as cdk.CfnResource | undefined;
    if (cfnMigrationCR && cfnWriter) {
      cfnMigrationCR.addDependency(cfnWriter);
    }
  }

  return { cluster, clusterArn: cluster.clusterArn, secretArn: secret.secretArn, databaseName, envVars, grantDataApi };
}

/** Hash all .sql files in a directory to detect changes. */
const hashMigrationsDir = (dir: string): string => {
  const hash = createHash('sha256');
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
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
