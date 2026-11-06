// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VpcContext } from '@aws-blocks/core/cdk';
import { blocksNodejsBundling, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { deployTimeLambdaEntry } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  DEFAULT_MAX_CAPACITY,
  DEFAULT_MIN_CAPACITY,
  DEFAULT_SECRET_ROTATION_DAYS,
  ENV_NAME_SANITIZE_PATTERN,
  ENV_VAR_PREFIX,
  MAX_SECRET_ROTATION_DAYS,
  MIN_SECRET_ROTATION_DAYS,
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
   * secret, and it forces storage encryption on regardless of `storageEncrypted`.
   * When omitted, storage encryption follows `storageEncrypted` (which uses the
   * account's AWS-managed `aws/rds` key when enabled).
   */
  storageEncryptionKey?: kms.IKey;
  /**
   * Whether to encrypt the cluster storage at rest. Two states, by design:
   * - `true` → emit `storageEncrypted: true` (opt in).
   * - `undefined` → leave the property **unset** so an existing, implicitly
   *   unencrypted cluster is not forced into a destructive replacement by a
   *   template change.
   *
   * The type is `?: true` (not `boolean`) so an explicit `false` is
   * **unrepresentable** rather than merely discouraged: `StorageEncrypted: false`
   * would itself be a template change that replaces an existing cluster. The CDK
   * layer resolves this from the `@aws-blocks/bb-data:encryptStorageByDefault`
   * context flag; a supplied `storageEncryptionKey` forces encryption on.
   */
  storageEncrypted?: true;
  /**
   * Retention period for the cluster's automated backups (which also drives the
   * point-in-time-recovery window). @default `cdk.Duration.days(15)` — matches
   * the SecureCDK baseline.
   */
  backupRetention?: cdk.Duration;
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
   * CloudWatch retention applied to the log groups this stack owns. Populated
   * from the stack-wide `defaults.logRetention`; when omitted the groups use the
   * CDK/CloudWatch default retention. Two consumers read it:
   * - the migration Lambda's log group (created explicitly below), and
   * - the cluster's PostgreSQL **engine** log group, via the cluster's
   *   `cloudwatchLogsRetention` prop (see the note there about the LogRetention
   *   custom resource).
   */
  logRetention?: cdk.aws_logs.RetentionDays;
  /**
   * Automatic rotation of the cluster's credentials secret. On by default: AWS's
   * PostgreSQL single-user rotation function (a Serverless Application
   * Repository app) runs in the cluster VPC and rotates the `postgres` password
   * in place every `intervalDays` days. Pass `false` to turn rotation off.
   * @default `{ intervalDays: 30 }`
   */
  secretRotation?: false | { intervalDays: number };
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
  /**
   * Security group of the secret-rotation Lambda, when rotation is enabled. In a
   * shared VPC the CDK layer registers it with core, whose single endpoint SG
   * (shared by every Blocks-managed interface endpoint) otherwise admits only the
   * Blocks Lambda SG. Undefined when `secretRotation` is `false`.
   */
  rotationSecurityGroup?: ec2.ISecurityGroup;
}

/**
 * Provision Aurora Serverless v2 PostgreSQL with Data API enabled.
 *
 * Creates: VPC (2 AZs, isolated subnets, no NAT), Aurora cluster,
 * Secrets Manager credentials, the rotation Lambda and (standalone VPC) a
 * Secrets Manager endpoint, security groups, IAM grants, and CfnOutputs.
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
  // The app reaches Aurora over the RDS Data API (HTTPS via the interface endpoint),
  // never a raw socket, and the rotation Lambda lands in the cluster's own subnets, so
  // the placement tier doesn't affect reachability — it only has to be a tier the VPC
  // actually has. Prefer isolated when present (keeps the DB off any NAT path),
  // otherwise fall back to private-with-egress.
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

  // Security group for the cluster. No ingress rule here: the cluster runs with
  // `enableDataApi: true` and the app reaches it exclusively over the RDS Data
  // API (HTTPS via the Secrets Manager + RDS Data interface endpoints), never a
  // raw Postgres socket. The only socket path is the credentials-rotation Lambda:
  // `addRotationSingleUser` below admits its dedicated SG on the Postgres port.
  // Egress stays closed.
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
  // from. Default to 15 days to match the SecureCDK baseline; callers may
  // override via `backupRetention`.
  const backupRetention = options.backupRetention ?? cdk.Duration.days(DEFAULT_BACKUP_RETENTION_DAYS);

  // Resolve storage encryption to `true` or `undefined` — never an explicit
  // `false`. CloudFormation renders `StorageEncrypted: false` for an explicit
  // false, itself a template change that forces a cluster replacement on an
  // existing (implicitly-unencrypted) deployment; leaving the property unset
  // keeps those clusters untouched. A customer-managed key always forces
  // encryption on; otherwise honor the caller-resolved opt-in (the CDK layer
  // gates it behind the `@aws-blocks/bb-data:encryptStorageByDefault` flag).
  const storageEncrypted = options.storageEncryptionKey || options.storageEncrypted ? true : undefined;

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
    // Storage encryption at rest. Resolved to `true` or left unset (never an
    // explicit `false`): the CDK layer gates the opt-in behind the
    // `@aws-blocks/bb-data:encryptStorageByDefault` context flag so NEW projects
    // are encrypted by default while EXISTING, implicitly-unencrypted clusters
    // are not forced into a destructive replacement by a template change. A
    // customer-managed `storageEncryptionKey` always forces it on. When a key is
    // given the cluster uses it; otherwise `true` uses the account's AWS-managed
    // `aws/rds` key.
    storageEncrypted,
    storageEncryptionKey: options.storageEncryptionKey,
    // When a CMK is supplied, also encrypt the auto-generated credentials secret
    // with it. CDK cannot set an encryption key on the cluster's auto-generated
    // secret without providing an explicit generated-secret credential, so we pin
    // the exact master username the aurora-postgres engine defaults to
    // ('postgres'). Note this is not a no-op swap of only the secret's KMS key:
    // supplying (or changing) a CMK gives the generated secret a new logical id,
    // so CloudFormation mints a fresh secret with a NEW generated password, and
    // that generated secret carries DeletionPolicy:Delete even under production.
    // Without a CMK, credentials stay undefined so the default AWS-managed secret
    // encryption is unchanged.
    credentials: options.storageEncryptionKey
      ? rds.Credentials.fromGeneratedSecret('postgres', { encryptionKey: options.storageEncryptionKey })
      : undefined,
    // Retain automated backups (and the PITR window they provide).
    backup: { retention: backupRetention },
    // Export the PostgreSQL engine log to CloudWatch Logs. Retention follows the
    // stack-wide `defaults.logRetention` when provided (the same knob every other
    // Blocks-managed log group reads); when omitted, CloudWatch keeps the log
    // group at the account default retention.
    //
    // Setting `cloudwatchLogsRetention` makes CDK add a `LogRetention` custom
    // resource (a per-stack singleton Lambda + IAM role) to apply the retention,
    // because RDS owns the engine log group's name via a token id, so CDK can't
    // create the LogGroup directly. This extra Lambda is intended — see DESIGN.md.
    //
    // Known gap (deliberate, not implemented here): unlike the migration Lambda's
    // log group above (removalPolicy DESTROY), this engine log group is NOT
    // deleted when the cluster is destroyed — the LogRetention custom resource
    // only sets retention, it does not own the group's lifecycle — so it is left
    // orphaned on destroy. Acknowledged as a known gap; deleting it would mean
    // adopting the RDS-named group into a managed LogGroup, a larger change.
    cloudwatchLogsExports: ['postgresql'],
    cloudwatchLogsRetention: options.logRetention,
    // iamAuthentication is intentionally NOT enabled: the cluster is reached
    // exclusively over the RDS Data API (HTTPS + Secrets Manager credentials),
    // never a direct DB socket, so database-level IAM authentication does not
    // apply here. The credentials secret is rotated on a schedule by the
    // rotation Lambda wired up below, unless `secretRotation` is `false`.
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
   * Grant rds-data:* and secretsmanager:GetSecretValue (plus kms:Decrypt on the
   * customer-managed key, when one encrypts the secret) to a principal.
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
    // With a customer-managed key, `secret.grantRead` puts `kms:Decrypt` on the
    // KEY policy (via `ViaServicePrincipal`), and an imported key's policy can't
    // be edited from here, so that grant is silently dropped and the principal
    // can't decrypt the secret: every Data API call fails. Grant it identity-side
    // instead, scoped to use through Secrets Manager. The key policy must still
    // allow the account's IAM principals to use the key (the default key policy
    // does, via the account root).
    if (options.storageEncryptionKey) {
      grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [options.storageEncryptionKey.keyArn],
        conditions: {
          StringEquals: { 'kms:ViaService': `secretsmanager.${cdk.Stack.of(scope).region}.amazonaws.com` },
        },
      }));
    }
  };

  new cdk.CfnOutput(scope, `${name}ClusterArn`, { value: cluster.clusterArn });
  new cdk.CfnOutput(scope, `${name}SecretArn`, { value: secret.secretArn });

  // The writer instance's CfnResource. Anything that connects to the database
  // during the deploy (the migration Lambda, the first rotation) must wait for
  // it: CloudFormation considers the cluster "created" before any instance
  // exists, and a connection attempt then fails with "Cannot find DBInstance in
  // DBCluster". Located by CFN resource type (the writer is created inside the
  // cluster construct; this cluster has exactly one instance) and wired with a
  // CFN-level DependsOn. Throw if it isn't there: a CDK change that moved it
  // would otherwise silently drop the ordering.
  const cfnWriter = cluster.node.findAll().find((c) => (c as any).cfnResourceType === 'AWS::RDS::DBInstance') as
    | cdk.CfnResource
    | undefined;
  if (!cfnWriter) {
    throw new Error(
      `Aurora cluster '${name}' has no AWS::RDS::DBInstance child; aws-cdk-lib may have changed how the writer ` +
        `is created. Blocks needs it to order migrations and the first rotation after the instance.`,
    );
  }

  // Run migrations on deploy if migrationsPath is provided
  let migrationCR: cdk.CustomResource | undefined;
  if (options.migrationsPath) {
    const migrationsHash = hashMigrationsDir(options.migrationsPath);
    const migrationFn = new lambda.NodejsFunction(scope, `${name}MigrationFn`, {
      // Points at the compiled migration-lambda.js in dist/ (same directory as this file at runtime).
      // Must NOT use ../src/migration-lambda.ts — an installed package runs from dist/. A vendorized
      // copy (blocks-vendorize copies src/ only, no dist/) has just ./migration-lambda.ts next to this
      // file, which deployTimeLambdaEntry falls back to.
      entry: deployTimeLambdaEntry({ moduleUrl: import.meta.url, source: './migration-lambda' }),
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

    migrationCR = new cdk.CustomResource(scope, `${name}MigrationCR`, {
      serviceToken: provider.serviceToken,
      properties: { migrationsHash },
    });

    // Ensure the migration custom resource waits for the Aurora writer instance
    // (see `cfnWriter` above).
    (migrationCR.node.defaultChild as cdk.CfnResource).addResourceDependency(cfnWriter);
  }

  // Automatic rotation of the credentials secret: AWS's PostgreSQL single-user
  // rotation function (a Serverless Application Repository app; not CDK's
  // `HostedRotation`, which uses a different transform) runs in the cluster VPC,
  // generates a new password, sets it on the cluster as `postgres`, and makes it
  // the secret's AWSCURRENT version. The secret is rotated in place (same ARN);
  // the Data API callers never read the password themselves, so nothing else
  // changes. The RDS-managed master password (`manageMasterUserPassword`) was not
  // used: it would replace every existing no-CMK cluster and change the secret
  // ARN (see DESIGN.md).
  //
  // The rotation Lambda needs a path to the cluster's Postgres port (granted on
  // the cluster SG from the dedicated rotation SG only) and to the Secrets
  // Manager API: in the standalone VPC (isolated, no NAT) that is the interface
  // endpoint created below; in a shared VPC core already provisions it, and the
  // CDK layer registers `rotationSecurityGroup` so core's endpoint SG admits the
  // rotation Lambda. CDK also attaches a resource policy denying
  // `secretsmanager:DeleteSecret` to the account while rotation is on: `cdk
  // destroy` still deletes the secret, but an out-of-band `delete-secret` is
  // refused.
  let rotationSecurityGroup: ec2.ISecurityGroup | undefined;
  if (options.secretRotation !== false) {
    // `undefined` (option omitted) is the only way to get the default: the object
    // form requires `intervalDays`, so an empty object is a type error, not a
    // silent default.
    const intervalDays = options.secretRotation?.intervalDays ?? DEFAULT_SECRET_ROTATION_DAYS;
    if (
      !Number.isInteger(intervalDays) ||
      intervalDays < MIN_SECRET_ROTATION_DAYS ||
      intervalDays > MAX_SECRET_ROTATION_DAYS
    ) {
      throw new Error(
        `Invalid secretRotation.intervalDays ${String(intervalDays)}; expected an integer between ` +
          `${MIN_SECRET_ROTATION_DAYS} and ${MAX_SECRET_ROTATION_DAYS}.`,
      );
    }

    // Egress open, unlike the cluster and endpoint SGs: the rotation Lambda
    // must reach the cluster (port from the cluster's endpoint) and Secrets
    // Manager (443 via the endpoint), and in the isolated, no-NAT standalone
    // VPC there is nowhere else for traffic to go. In a shared VPC the same
    // posture as core's Blocks Lambda SG applies.
    const rotationSg = new ec2.SecurityGroup(scope, `${name}RotationSg`, {
      vpc,
      description: `Security group for ${name} credentials-rotation Lambda`,
      allowAllOutbound: true,
    });
    rotationSecurityGroup = rotationSg;

    if (!options.vpcContext) {
      // Standalone VPC: no other workloads live here, but mirror core's endpoint
      // ingress posture anyway — a dedicated SG admitting 443 from the rotation
      // Lambda only, and `open: false` so CDK doesn't add its default
      // allow-from-VPC-CIDR rule. Egress is closed, tighter than core's: an
      // endpoint ENI never initiates a connection.
      const endpointSg = new ec2.SecurityGroup(scope, `${name}SecretsEndpointSg`, {
        vpc,
        description: `Secrets Manager endpoint for ${name} - 443 from the rotation Lambda only`,
        allowAllOutbound: false,
      });
      endpointSg.addIngressRule(
        ec2.Peer.securityGroupId(rotationSg.securityGroupId),
        ec2.Port.tcp(443),
        'HTTPS from the credentials-rotation Lambda',
      );
      new ec2.InterfaceVpcEndpoint(scope, `${name}SecretsManagerEndpoint`, {
        vpc,
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        privateDnsEnabled: true,
        securityGroups: [endpointSg],
        open: false,
      });
    }

    // `endpoint` is deliberately not passed: the endpoint has private DNS, so the
    // standard regional hostname already resolves to it, and the hostname CDK
    // derives from an explicit endpoint does not match a private-DNS endpoint's
    // DNS entry. `vpcSubnets` is not passed either: CDK defaults it to the
    // cluster's own subnet selection, so the function lands in the same tier.
    const rotation = cluster.addRotationSingleUser({
      automaticallyAfter: cdk.Duration.days(intervalDays),
      securityGroup: rotationSg,
    });

    // The schedule rotates immediately once created. Make it wait for the
    // writer (so the first rotation can connect) and for the migrations (so a
    // mid-rotation password swap can't fail a migration statement). CDK puts
    // the RotationSchedule under the *secret*, not under `rotation`, and
    // `SecretRotation` exposes no handle to it, so find it by type rather than
    // by its (internal, renameable) child id. Throw if it isn't there: a CDK
    // upgrade that moved it would otherwise silently drop this ordering.
    const schedule = secret.node.children.find((c) => c instanceof secretsmanager.RotationSchedule);
    if (!schedule) {
      throw new Error(
        `Aurora cluster '${name}' has no RotationSchedule under its secret after addRotationSingleUser; ` +
          `aws-cdk-lib may have changed where it lives. Blocks needs it to order the first rotation.`,
      );
    }
    for (const dependent of [rotation, schedule]) {
      dependent.node.addDependency(cfnWriter);
      if (migrationCR) dependent.node.addDependency(migrationCR);
    }
  }

  return {
    cluster,
    clusterArn: cluster.clusterArn,
    secretArn: secret.secretArn,
    databaseName,
    envVars,
    grantDataApi,
    rotationSecurityGroup,
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
