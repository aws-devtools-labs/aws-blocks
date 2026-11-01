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
import { RegionInfo } from 'aws-cdk-lib/region-info';
import type { Construct, IConstruct } from 'constructs';
import {
  DEFAULT_BACKUP_RETENTION_DAYS,
  DEFAULT_MAX_CAPACITY,
  DEFAULT_MIN_CAPACITY,
  DEFAULT_SECRET_ROTATION_DAYS,
  ENV_NAME_SANITIZE_PATTERN,
  ENV_VAR_PREFIX,
  MAX_SECRET_ROTATION_DAYS,
  MIN_SECRET_ROTATION_DAYS,
  ROTATION_WAIT_MARGIN_MS,
  ROTATION_WAIT_MAX_MS,
  SAR_ROTATION_PARTITIONS,
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
   * Automatic rotation of the cluster's credentials secret: AWS's PostgreSQL
   * single-user rotation function (a Serverless Application Repository app) runs
   * in the cluster VPC and rotates the `postgres` password in place every
   * `intervalDays` days. Omitted rotates on the default interval, `false` turns
   * rotation off. The CDK layer resolves the block option and the stack-wide
   * default into those two, so `true` arrives here as omitted.
   * @default rotate every `DEFAULT_SECRET_ROTATION_DAYS` days
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
   * Security group of the rotation Lambda, when rotation is enabled. In a
   * shared VPC the CDK layer registers it with core, whose single endpoint SG
   * (shared by every Blocks-managed interface endpoint) otherwise admits only the
   * Blocks Lambda SG. Undefined when `secretRotation` is `false`.
   */
  rotationSecurityGroup?: ec2.ISecurityGroup;
  /**
   * The rotation schedule, when rotation is enabled. In a shared VPC the CDK
   * layer registers it so core orders it after the endpoint and the rule
   * admitting `rotationSecurityGroup`; in the Database's own VPC this function
   * has already ordered it.
   */
  rotationSchedule?: IConstruct;
}

/**
 * Provision Aurora Serverless v2 PostgreSQL with Data API enabled.
 *
 * Creates: VPC (2 AZs, isolated subnets, no NAT), Aurora cluster, Secrets Manager credentials,
 * the rotation Lambda and its endpoint, security groups, IAM grants, and CfnOutputs.
 *
 * @param scope - CDK construct scope
 * @param name - Logical name used for resource naming and env var prefix
 * @param options - Capacity and database name configuration
 * @returns Infrastructure outputs including env vars and grant function
 *
 * @example
 * const infra = materialize(stack, 'main', { databaseName: 'main' });
 * Object.entries(infra.envVars).forEach(([k, v]) => registerConfig(stack, k, v));
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
    // iamAuthentication is intentionally NOT enabled: the app reaches the cluster
    // exclusively over the RDS Data API (HTTPS + Secrets Manager credentials),
    // never a direct DB socket, so database-level IAM authentication does not
    // apply here; the one socket client, the rotation Lambda, signs in with the
    // master password it rotates.
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
  // CFN-level DependsOn.
  const cfnWriter = cluster.node
    .findAll()
    .find((c) => (c as { cfnResourceType?: string }).cfnResourceType === 'AWS::RDS::DBInstance') as
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
          // Quoted: the hook runs in a shell, and a project path may contain a space.
          afterBundling: (_inputDir: string, outputDir: string) => [
            `cp -r "${options.migrationsPath}" "${outputDir}/migrations"`,
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

    (migrationCR.node.defaultChild as cdk.CfnResource).addResourceDependency(cfnWriter);
  }

  // The password is rotated in place, so the secret keeps its ARN and the Data
  // API callers never read the password themselves. The RDS-managed master
  // password was rejected for the alternative it replaces; see DESIGN.md.
  //
  // Adding the schedule also attaches a resource policy denying
  // `secretsmanager:DeleteSecret` to the account: CDK's own
  // `denyAccountRootDelete()`, called from its rotation constructs, not written
  // here. `cdk destroy` still deletes the secret, but an out-of-band
  // `delete-secret` is refused.
  let rotationSecurityGroup: ec2.ISecurityGroup | undefined;
  let rotationSchedule: IConstruct | undefined;
  if (options.secretRotation !== false) {
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

    // Rotation is only deployable where CDK publishes the rotation application. The
    // `AWS::Serverless::Application` resolves it through `Fn::FindInMap` on `AWS::Partition`
    // against a mapping holding `SAR_ROTATION_PARTITIONS` alone, so in any other partition
    // CloudFormation fails while expanding the transform — at deploy time, with a mapping
    // error, once it has already started creating the cluster. Fail at synth instead, where
    // the message can name the escape hatch. The partition is only knowable from a concrete
    // region: an environment-agnostic stack leaves `region` a token that resolves per target
    // account, which no synth-time check can see, so that case is documented in the README
    // rather than guessed at here.
    const stackRegion = cdk.Stack.of(scope).region;
    if (!cdk.Token.isUnresolved(stackRegion)) {
      const { partition } = RegionInfo.get(stackRegion);
      if (partition !== undefined && !SAR_ROTATION_PARTITIONS.includes(partition)) {
        throw new Error(
          `Credentials rotation is not available in partition '${partition}' (region '${stackRegion}'); ` +
            `the rotation application is published in ${SAR_ROTATION_PARTITIONS.join(', ')} only. ` +
            `Set 'secretRotation: false' to provision this database without rotation.`,
        );
      }
    }

    // Egress closed, like the cluster and endpoint SGs: this Lambda holds the
    // credentials it rotates, and in a shared VPC with a NAT an open group
    // would give it the internet. It needs two destinations, and gets only
    // those: the cluster's port, and 443 to a Secrets Manager endpoint. It
    // makes no KMS call of its own — Secrets Manager makes that one — so a
    // customer-managed key needs an IAM grant, not a route. The cluster-port
    // rule is not written here: `addRotationSingleUser` below admits this group
    // on the cluster, and the matching egress rule CDK drops while
    // `allowAllOutbound` is true appears once it is false. The 443 rule is
    // added where the endpoint's group is known — just below for the
    // Database's own VPC, and in core's `finalizeVpc` for a shared one.
    const rotationSg = new ec2.SecurityGroup(scope, `${name}RotationSg`, {
      vpc,
      description: `Security group for ${name} credentials-rotation Lambda`,
      allowAllOutbound: false,
    });
    rotationSecurityGroup = rotationSg;
    // In a shared VPC the customer may own the endpoints (`provisionEndpoints:
    // false`), and admitting this group on their Secrets Manager endpoint needs
    // its id — a deploy-time token, which is why the synth warning can only name
    // the construct path. Output it so the deploy that emits the warning also
    // prints the value the customer has to act on. Not emitted in the Database's
    // own VPC: there Blocks creates the endpoint and the ingress rule itself, so
    // the id has no use. Emitted for every shared VPC, not only the
    // `provisionEndpoints: false` one it serves: `VpcContext` carries no
    // `provisionEndpoints`, so gate it on that if it ever does.
    if (options.vpcContext) {
      new cdk.CfnOutput(scope, `${name}RotationSgId`, {
        value: rotationSg.securityGroupId,
        description:
          'Rotation Lambda security group; admit it on your Secrets Manager endpoint when you own the endpoints',
      });
    }

    // Kept so the rotation schedule can wait for them: the schedule rotates as
    // soon as it exists, and the rotation Lambda's only route to Secrets Manager
    // is this endpoint.
    let secretsEndpoint: ec2.InterfaceVpcEndpoint | undefined;
    let secretsEndpointSg: ec2.SecurityGroup | undefined;
    if (!options.vpcContext) {
      // The Database's own VPC: no other workloads live here, but mirror core's endpoint
      // ingress posture anyway — a dedicated SG admitting 443 from the rotation
      // Lambda only, and `open: false` so CDK doesn't add its default
      // allow-from-VPC-CIDR rule. Egress is closed, tighter than core's: an
      // endpoint ENI never initiates a connection.
      const endpointSg = new ec2.SecurityGroup(scope, `${name}SecretsEndpointSg`, {
        vpc,
        description: `Secrets Manager endpoint for ${name} - 443 from the rotation Lambda only`,
        allowAllOutbound: false,
      });
      // Pairs the endpoint's ingress rule with the rotation group's matching
      // egress rule in one call. `connections`, not `addIngressRule` with a
      // literal peer, because CDK inlines a literal peer into both groups and
      // they then reference each other, which CloudFormation rejects as a
      // circular dependency.
      endpointSg.connections.allowFrom(
        rotationSg,
        ec2.Port.tcp(443),
        'HTTPS from the credentials-rotation Lambda',
      );
      secretsEndpoint = new ec2.InterfaceVpcEndpoint(scope, `${name}SecretsManagerEndpoint`, {
        vpc,
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        privateDnsEnabled: true,
        securityGroups: [endpointSg],
        open: false,
      });
      secretsEndpointSg = endpointSg;
    }

    // `endpoint` is deliberately not passed: the endpoint has private DNS, so the
    // standard regional hostname already resolves to it, and the hostname CDK
    // derives from an explicit endpoint does not match a private-DNS endpoint's
    // DNS entry. `vpcSubnets` is not passed either: CDK defaults it to the
    // cluster's own subnet selection, so the function lands in the same tier.
    // The returned SecretRotation is not kept: only the schedule it creates is
    // ordered (see below), and the schedule is found on the secret.
    cluster.addRotationSingleUser({
      automaticallyAfter: cdk.Duration.days(intervalDays),
      securityGroup: rotationSg,
    });

    // The schedule rotates immediately once created. Make it wait for the
    // writer (so the first rotation can connect) and for the migrations (so a
    // mid-rotation password swap can't fail a migration statement). CDK puts
    // the RotationSchedule under the *secret*, not under `rotation`, and
    // `SecretRotation` exposes no handle to it, so find it by type rather than
    // by its (internal, renameable) child id.
    const schedule = secret.node.children.find((c) => c instanceof secretsmanager.RotationSchedule);
    if (!schedule) {
      throw new Error(
        `Aurora cluster '${name}' has no RotationSchedule under its secret after addRotationSingleUser; ` +
          `aws-cdk-lib may have changed where it lives. Blocks needs it to order the first rotation.`,
      );
    }
    // Only the schedule waits: it rotates as soon as it exists, so it needs the
    // writer (the rotation connects to it), the migrations (a mid-migration
    // password swap would fail a statement) and, in the Database's own VPC, the
    // Secrets Manager endpoint plus the rule admitting the rotation Lambda on it
    // — CloudFormation marks the schedule complete before the rotation runs, and
    // in isolated subnets with no NAT an endpoint that is not ready yet leaves
    // the rotation with no route. The SAR app is not gated on any of them: it
    // only has to exist before the schedule, and gating it would add its
    // creation time to every deploy.
    rotationSchedule = schedule;
    schedule.node.addDependency(cfnWriter);
    if (migrationCR) schedule.node.addDependency(migrationCR);
    if (secretsEndpoint) schedule.node.addDependency(secretsEndpoint);
    if (secretsEndpointSg) schedule.node.addDependency(secretsEndpointSg);
    // And both security groups, whose children are the rules the first rotation
    // needs: the rotation group's egress, and the cluster group's ingress on the
    // database port, which `addRotationSingleUser` adds as a separate resource.
    // A rule that does not exist yet leaves the rotation with no route, and on
    // an in-place upgrade the rules are new while the writer is not, so nothing
    // else orders them. Resolved lazily, so this also covers the 443 rule core
    // adds in a shared VPC.
    schedule.node.addDependency(rotationSg);
    schedule.node.addDependency(securityGroup);

    // Creating the schedule (and later changing its interval) starts a rotation
    // that runs after CloudFormation has already marked the schedule complete.
    // For a second or two, occasionally up to about 18, the cluster accepts the
    // new password while the secret still holds the old one, and the RDS Data
    // API can keep using a password it fetched in that window for minutes, so a
    // first query right after `cdk deploy` returns can fail. Hold the deploy
    // until that rotation has finished (see `rotation-wait-lambda.ts`; it gives
    // up after five minutes so a rotation that cannot reach Secrets Manager
    // does not fail the deploy).
    const rotationWaitFn = new lambda.NodejsFunction(scope, `${name}RotationWaitFn`, {
      entry: deployTimeLambdaEntry({ moduleUrl: import.meta.url, source: './rotation-wait-lambda' }),
      handler: 'handler',
      runtime: DEFAULT_NODE_RUNTIME,
      // Longer than the wait itself, or the function dies mid-poll and fails the
      // deploy the wait exists to protect.
      timeout: cdk.Duration.millis(ROTATION_WAIT_MAX_MS + ROTATION_WAIT_MARGIN_MS),
      logGroup: new LogGroup(scope, `${name}RotationWaitLogs`, {
        retention: options.logRetention,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: { SECRET_ARN: secret.secretArn },
      bundling: blocksNodejsBundling({ externalModules: ['@aws-sdk/*'] }),
    });
    rotationWaitFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['secretsmanager:DescribeSecret'], resources: [secret.secretArn] }),
    );
    const rotationWaitProvider = new cr.Provider(scope, `${name}RotationWaitProvider`, {
      onEventHandler: rotationWaitFn,
    });
    // One property per thing whose change starts a rotation, because
    // CloudFormation re-invokes a custom resource only when the resource's own
    // properties change while `RotateImmediatelyOnUpdate` defaults to true: the
    // interval, the function the schedule points at (an aws-cdk-lib rename
    // replaces it), and the secret (a `storageEncryptionKeyArn` gives it a new
    // logical id, so a fresh one is minted — see `credentials` above). The last
    // two are tokens, so a deploy that rotates nothing synthesizes the same
    // template; what differs is the value CloudFormation resolves and compares.
    const cfnSchedule = schedule.node.defaultChild as secretsmanager.CfnRotationSchedule;
    const rotationWaitCR = new cdk.CustomResource(scope, `${name}RotationWaitCR`, {
      serviceToken: rotationWaitProvider.serviceToken,
      properties: {
        intervalDays,
        rotationLambdaArn: cfnSchedule.rotationLambdaArn,
        secretArn: cfnSchedule.secretId,
      },
    });
    rotationWaitCR.node.addDependency(schedule);
    // Published so a test can assert a rotation actually finished: rotation
    // being enabled proves only that a schedule exists, and a wrong security
    // group, subnet or key grant would otherwise ship green. An output rather
    // than a Secrets Manager read because a CI role that can describe a stack
    // often cannot describe a secret. A deploy that changes nothing about
    // rotation does not re-invoke the wait, so the value then still describes
    // the last rotation this stack waited for.
    new cdk.CfnOutput(scope, `${name}RotationWaited`, {
      value: rotationWaitCR.getAttString('Rotated'),
      description: 'Whether the rotation this stack last started finished within the wait',
    });
  }

  return {
    cluster,
    clusterArn: cluster.clusterArn,
    secretArn: secret.secretArn,
    databaseName,
    envVars,
    grantDataApi,
    rotationSecurityGroup,
    rotationSchedule,
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
