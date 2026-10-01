// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { BuildingBlockScope, getVpcContext, registerConfig, synthGuard } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { materialize, grantExternalDataApi } from './infra.js';
import { ENV_NAME_SANITIZE_PATTERN, ENV_VAR_PREFIX } from './constants.js';
import type { DatabaseOptions, ExternalDatabaseRef, SubnetSelection } from './types.js';

/**
 * CDK layer for the Database Building Block.
 * Provisions Aurora Serverless v2 with Data API and grants permissions
 * to the parent scope's Lambda handler.
 *
 * Resources created:
 * - VPC with 2 AZs, isolated subnets, no NAT gateways
 * - Aurora Serverless v2 cluster (PostgreSQL-compatible, Data API enabled)
 * - Secrets Manager secret with auto-generated credentials
 * - Security group allowing inbound PostgreSQL (5432) from VPC
 * - IAM grants for rds-data:* and secretsmanager:GetSecretValue
 * - Environment variables (BLOCKS_{id}_CLUSTER_ARN, BLOCKS_{id}_SECRET_ARN, BLOCKS_{id}_DATABASE)
 *
 * @example
 * // In aws-blocks/index.ts:
 * const db = new Database(scope, 'main');
 *
 * // With custom capacity:
 * const db = new Database(scope, 'analytics', { minCapacity: 1, maxCapacity: 8 });
 */

/** Map the CDK-free `subnetType` string to the CDK enum. */
const SUBNET_TYPE_MAP: Record<NonNullable<SubnetSelection['subnetType']>, ec2.SubnetType> = {
  isolated: ec2.SubnetType.PRIVATE_ISOLATED,
  'private-with-egress': ec2.SubnetType.PRIVATE_WITH_EGRESS,
  public: ec2.SubnetType.PUBLIC,
};

/**
 * Resolve the customer's CDK-free {@link SubnetSelection} (from `Database({ subnets })`)
 * into a real `ec2.SubnetSelection`. Returns `undefined` when no override was
 * given, so the default isolated-preferred placement applies. Enforces CDK's
 * mutual exclusion (at most one of subnetType / subnetGroupName / subnetIds)
 * with a BB-named error instead of a cryptic CDK one.
 */
function resolveClusterSubnets(scope: BuildingBlockScope, sel?: SubnetSelection): ec2.SubnetSelection | undefined {
  if (!sel) return undefined;
  const primaries = [sel.subnetType, sel.subnetGroupName, sel.subnetIds].filter((v) => v !== undefined);
  if (primaries.length > 1) {
    throw new Error(
      `Database "${scope.fullId}": at most one of 'subnetType', 'subnetGroupName', or 'subnetIds' ` +
        `may be set in 'subnets'.`,
    );
  }
  return {
    ...(sel.subnetType ? { subnetType: SUBNET_TYPE_MAP[sel.subnetType] } : {}),
    ...(sel.subnetGroupName ? { subnetGroupName: sel.subnetGroupName } : {}),
    ...(sel.subnetIds
      ? { subnets: sel.subnetIds.map((sid, i) => ec2.Subnet.fromSubnetId(scope, `${scope.node.id}Subnet${i}`, sid)) }
      : {}),
    ...(sel.availabilityZones ? { availabilityZones: sel.availabilityZones } : {}),
    ...(sel.onePerAz !== undefined ? { onePerAz: sel.onePerAz } : {}),
  };
}

export class Database extends BuildingBlockScope {
  constructor(scope: ScopeParent, id: string, options?: DatabaseOptions) {
    // Aurora is reached over the RDS Data API, so it needs Secrets Manager + RDS
    // Data interface endpoints. It does NOT declare `requiresEgress`: the Data
    // API is called from the shared runtime over HTTPS (via those endpoints), so
    // the runtime's own placement is unconstrained. The cluster's placement is
    // resolved by the Database construct itself via `selectSubnets`, not here.
    super(id, {
      parent: scope,
      vpc: {
        interfaceEndpoints: [
          ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
          ec2.InterfaceVpcEndpointAwsService.RDS_DATA,
        ],
      },
    });

    if (options?.connection) {
      // External database — skip provisioning, just grant permissions and inject env vars
      const conn = options.connection;
      const envName = this.fullId.replace(ENV_NAME_SANITIZE_PATTERN, '_');

      if ('host' in conn) {
        // Data API mode (Aurora)
        registerConfig(this, `${ENV_VAR_PREFIX}_${envName}_CLUSTER_ARN`, conn.host);
        registerConfig(this, `${ENV_VAR_PREFIX}_${envName}_SECRET_ARN`, conn.secretArn);
        registerConfig(this, `${ENV_VAR_PREFIX}_${envName}_DATABASE`, conn.database);
        grantExternalDataApi(this, this.fullId, conn, this.executionRole);
      }
      // connectionString variant: AppSetting handles parameter creation, IAM grants, and env var injection.

      if (options.migrationsPath) {
        throw new Error(
          'migrationsPath cannot be used with fromExisting(). External database ' +
          'migrations are applied from ./migrations during `npm run sandbox` / `npm run deploy` ' +
          '(see MIGRATION_GUIDE.md). Remove migrationsPath from this Database.'
        );
      }
      return;
    }

    const databaseName = options?.databaseName || this.fullId.replace(ENV_NAME_SANITIZE_PATTERN, '_');

    const REMOVAL_POLICY_MAP = {
      destroy: cdk.RemovalPolicy.DESTROY,
      retain: cdk.RemovalPolicy.RETAIN,
      snapshot: cdk.RemovalPolicy.SNAPSHOT,
    } as const;

    // Removal policy: the per-block option wins, otherwise the stack-wide
    // `defaults` (sandbox → DESTROY so sandbox:destroy can clean up; production
    // → RETAIN). Deletion protection is derived from the resolved policy in
    // materialize() (protected unless DESTROY).
    const defaultRemovalPolicy = this.defaults.removalPolicy;

    // Aurora backup retention IS the point-in-time-recovery window, so resolve it
    // from the per-block `pointInTimeRecovery` option, else the stack-wide
    // `defaults.pointInTimeRecovery` (production on, sandbox off) — the same knob
    // every other Blocks block reads (see core/src/cdk/blocks-defaults.ts). Map
    // the resolved setting to the cluster's `backup.retention` (a day count the
    // materialize() layer wraps in a cdk.Duration):
    //   false            → 1 day  (clamp — see below)
    //   true             → the enabled default window
    //   { retentionDays } → that window, after range validation (1–35)
    const AURORA_ENABLED_BACKUP_DAYS = 15;
    const pitrSetting = options?.pointInTimeRecovery ?? this.defaults.pointInTimeRecovery;
    let backupRetentionDays: number;
    if (typeof pitrSetting === 'object' && pitrSetting !== null) {
      // `{ retentionDays: n }` — enable backups and pin the window. Aurora
      // requires an integer 1–35; warn and fall back to the enabled default on an
      // out-of-range value rather than failing the deploy (mirrors DT's
      // bb-distributed-table:InvalidPitrDays handling).
      const days = pitrSetting.retentionDays;
      if (!Number.isInteger(days) || days < 1 || days > 35) {
        cdk.Annotations.of(this).addWarningV2(
          '@aws-blocks/bb-data:InvalidPitrDays',
          `pointInTimeRecovery.retentionDays must be an integer between 1 and 35 (got ${String(days)}) — ` +
            `falling back to the ${AURORA_ENABLED_BACKUP_DAYS}-day default.`,
        );
        backupRetentionDays = AURORA_ENABLED_BACKUP_DAYS;
      } else {
        backupRetentionDays = days;
      }
    } else if (pitrSetting === false) {
      // Aurora CANNOT disable automated backups — the cluster minimum retention
      // is 1 day (`BackupRetentionPeriod: 0` is rejected at CreateDBCluster). So a
      // `false` setting clamps to the 1-day minimum rather than turning backups
      // off. This "clamp to the service's supported range" is explicitly allowed
      // by the `defaults.pointInTimeRecovery` contract (see blocks-defaults.ts),
      // which notes DynamoDB's own 1–35 clamp for the same reason.
      backupRetentionDays = 1;
    } else {
      // `true` (or the production default) — enable with the standard 15-day window.
      backupRetentionDays = AURORA_ENABLED_BACKUP_DAYS;
    }

    const infra = materialize(this, this.fullId, {
      minCapacity: options?.minCapacity,
      maxCapacity: options?.maxCapacity,
      databaseName,
      migrationsPath: options?.migrationsPath ? resolve(options.migrationsPath) : undefined,
      removalPolicy: options?.removalPolicy ? REMOVAL_POLICY_MAP[options.removalPolicy] : defaultRemovalPolicy,
      // Read independently from defaults (not derived from removalPolicy), so
      // an override like `{ ...production, deletionProtection: false }` is honored.
      deletionProtection: this.defaults.deletionProtection,
      postgresVersion: options?.postgresVersion,
      // Resolve the CDK-free public options into the CDK types AuroraInfraConfig
      // expects: a key ARN becomes a kms.IKey, the PITR setting becomes a
      // cdk.Duration backup window.
      // A single Database provisions exactly one cluster, so the fixed
      // 'db-storage-key' construct id for the imported key is unique in this scope.
      storageEncryptionKey: options?.storageEncryptionKeyArn
        ? kms.Key.fromKeyArn(this, 'db-storage-key', options.storageEncryptionKeyArn)
        : undefined,
      backupRetention: cdk.Duration.days(backupRetentionDays),
      vpcContext: getVpcContext(this),
      clusterSubnets: resolveClusterSubnets(this, options?.subnets),
      // Migration Lambda log retention follows the stack-wide default.
      logRetention: this.defaults.logRetention,
    });

    // Inject config so DataApiEngine can read them at runtime
    Object.entries(infra.envVars).forEach(([key, value]) => {
      registerConfig(this, key, value);
    });

    // Grant Data API permissions to the shared execution role
    infra.grantDataApi(this.executionRole);
  }

  /**
   * Runtime-only. This is the CDK (synth) build: it defines infrastructure and
   * has no engine — queries run in the app Lambda against the deployed database.
   * `createKyselyAdapter()` no longer calls this eagerly, so reaching it means a
   * query ran at synth time (e.g. at module scope).
   */
  getEngine(): never {
    return synthGuard('Database', 'getEngine');
  }

  /**
   * @deprecated Use the standalone `fromExisting()` export instead.
   */
  static fromExisting(config: ExternalDatabaseRef): ExternalDatabaseRef {
    return config;
  }
}

export { fromExisting } from './from-existing.js';
export { DatabaseErrors } from './errors.js';
export { sql, createKyselyAdapter } from '@aws-blocks/data-common';
export type { SqlQuery, Transaction } from '@aws-blocks/data-common';
export type { DatabaseOptions, ExternalDatabaseRef, ExternalSslOptions } from './types.js';
