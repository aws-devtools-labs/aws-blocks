// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { DEFAULT_NODE_RUNTIME, blocksNodejsBundling } from '@aws-blocks/core/cdk';
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

import type { VpcContext } from '@aws-blocks/core/cdk';

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
   * VPC context from the parent scope. When provided, Aurora is placed in the
   * shared VPC's isolated subnets instead of creating its own VPC.
   * @internal
   */
  vpcContext?: VpcContext;
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

  // Determine VPC (shared or standalone)
  const vpc = options.vpcContext?.vpc ?? new ec2.Vpc(scope, `${name}Vpc`, {
    maxAzs: VPC_MAX_AZS,
    natGateways: 0,
    subnetConfiguration: [
      { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    ],
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
  if (options.vpcContext) {
    clusterSubnets = vpc.isolatedSubnets.length > 0
      ? options.vpcContext.selectSubnets('isolated')
      : options.vpcContext.selectSubnets('private-with-egress');
  } else {
    clusterSubnets = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };
  }

  // Single SG instantiation
  const securityGroup = new ec2.SecurityGroup(scope, `${name}Sg`, {
    vpc,
    description: `Security group for ${name} Aurora cluster`,
    allowAllOutbound: false,
  });

  // Ingress rule differs based on context
  securityGroup.addIngressRule(
    options.vpcContext
      ? options.vpcContext.lambdaSecurityGroup
      : ec2.Peer.ipv4((vpc as ec2.Vpc).vpcCidrBlock),
    ec2.Port.tcp(DEFAULT_POSTGRES_PORT),
    options.vpcContext ? 'Lambda to Aurora' : 'Allow PostgreSQL from VPC',
  );

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
    // Read independently from defaults (falling back to the removalPolicy-derived
    // value for direct materialize() callers that don't pass it).
    deletionProtection: options.deletionProtection ?? removalPolicy !== cdk.RemovalPolicy.DESTROY,
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
