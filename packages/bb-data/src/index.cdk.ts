// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { BuildingBlockScope, getVpcContext, registerConfig, synthGuard } from '@aws-blocks/core/cdk';
import { registerVpcRequirements } from '@aws-blocks/core/cdk/internal';
import type { VpcContext } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { materialize, grantExternalDataApi } from './infra.js';
import { ENV_NAME_SANITIZE_PATTERN, ENV_VAR_PREFIX, DEFAULT_BACKUP_RETENTION_DAYS } from './constants.js';
import type { DatabaseOptions, ExternalDatabaseRef, SubnetSelection } from './types.js';
import { BB_NAME } from './version.js';

/**
 * CDK layer for the Database Building Block.
 * Provisions Aurora Serverless v2 with Data API and grants permissions
 * to the parent scope's Lambda handler.
 *
 * Resources created:
 * - VPC with 2 AZs, isolated subnets, no NAT, and a Secrets Manager endpoint (no shared VPC)
 * - Aurora Serverless v2 cluster (PostgreSQL-compatible, Data API enabled)
 * - Secrets Manager secret with auto-generated credentials, rotated on a schedule
 * - Rotation Lambda for that secret, and security groups for it, the endpoint and the cluster
 * - IAM grants for rds-data:* and secretsmanager:GetSecretValue (and kms:Decrypt with a CMK)
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
 * The shared VPC context only when the **customer provided** it (`source:
 * 'provided'`), else `undefined`. A Database must never auto-join a Blocks-
 * **derived** shared VPC — see the call site for why (data-loss via cluster
 * replacement). Returning `undefined` makes `materialize()` build the Database's
 * own VPC, exactly as it did before derived shared VPCs existed.
 */
function providedVpcContext(scope: BuildingBlockScope): VpcContext | undefined {
  const ctx = getVpcContext(scope);
  return ctx?.source === 'provided' ? ctx : undefined;
}

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

/** CDK context key carrying the project's Aurora storage-encryption choice. */
const ENCRYPT_STORAGE_CONTEXT_KEY = '@aws-blocks/bb-data:encryptStorageByDefault';

/**
 * README section with the steps to move an existing unencrypted cluster onto an
 * encrypted one (or keep it as-is). Referenced from the synth error and warning.
 */
const ENCRYPTION_MIGRATION_DOC =
  'https://github.com/aws-devtools-labs/aws-blocks/blob/main/packages/bb-data/README.md#enabling-storage-encryption-on-an-existing-database';

/**
 * Normalize the raw `@aws-blocks/bb-data:encryptStorageByDefault` context value
 * into `true` / `false` / `undefined` (absent).
 *
 * The value can arrive as a JSON boolean or number (cdk.json / `setContext`) or as
 * a string (a `--context key=value` CLI override always arrives as a string), so
 * booleans pass through, `1`/`0` map to `true`/`false`, and strings are matched
 * case-insensitively after trimming (`'true'`/`'1'`, `'false'`/`'0'`). Anything
 * else is rejected with an error listing the accepted values, so a typo such as
 * `'yes'` can never be read as a decision either way.
 */
function resolveEncryptStorageFlag(raw: unknown, databaseId: string): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'boolean') return raw;
  if (raw === 1) return true;
  if (raw === 0) return false;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  throw new Error(
    `Database "${databaseId}": unrecognized value ${JSON.stringify(raw)} for the context flag ` +
      `"${ENCRYPT_STORAGE_CONTEXT_KEY}". Accepted values: true / false (boolean), 1 / 0, or the strings ` +
      `"true" / "false" / "1" / "0" (case-insensitive).`,
  );
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
      bbName: BB_NAME,
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

      // Provisioning-only options don't apply to an external database — we never
      // emit an Aurora cluster to attach them to. Surface that at synth so a
      // `storageEncryptionKeyArn`, `pointInTimeRecovery` or `secretRotation` on
      // what looks like a managed database isn't a silent no-op (mirrors DT's
      // bb-distributed-table:IgnoredOptionsForExistingTable).
      const ignoredForExisting = (['pointInTimeRecovery', 'storageEncryptionKeyArn', 'secretRotation'] as const).filter(
        (key) => options[key] !== undefined,
      );
      if (ignoredForExisting.length > 0) {
        cdk.Annotations.of(this).addWarningV2(
          '@aws-blocks/bb-data:IgnoredOptionsForExistingDatabase',
          `Ignoring ${ignoredForExisting.join(', ')} because this database is wrapped via fromExisting() — ` +
            `the existing database owns its own durability/encryption/credentials configuration.`,
        );
      }

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
    const AURORA_ENABLED_BACKUP_DAYS = DEFAULT_BACKUP_RETENTION_DAYS;
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

    // Resolved like `pointInTimeRecovery` above, with one addition: an absent
    // stack-wide default means off, as it does for every other optional field on
    // `BlocksDefaults`, so a hand-written literal never turns a cost-bearing
    // feature on by omission. `true` carries no interval, so it reaches
    // `materialize` as `undefined`, which rotates on the default interval.
    const rotationSetting = options?.secretRotation ?? this.defaults.secretRotation ?? false;
    const secretRotation = rotationSetting === true ? undefined : rotationSetting;

    // Storage encryption requires an explicit project decision, so a dependency
    // bump can never change `StorageEncrypted` on an existing cluster (a change
    // CloudFormation applies as a REPLACEMENT — a new, empty cluster). The
    // decision comes from the `@aws-blocks/bb-data:encryptStorageByDefault`
    // context flag (normalized by resolveEncryptStorageFlag):
    //   - `true`   → `storageEncrypted: true` (the create-blocks-app templates set
    //                this, so new projects are encrypted with the `aws/rds` key).
    //   - `false`  → explicit opt-out: leave the property unset, exactly as an
    //                existing unencrypted cluster was synthesized before, and warn.
    //   - absent   → fail synth: the project has not made the choice yet.
    // A customer-managed `storageEncryptionKeyArn` is itself that decision, so it
    // turns encryption on regardless of the flag (and makes an absent flag fine).
    // An explicit `false` is never emitted as `StorageEncrypted: false`, since that
    // would itself be a template change on an existing cluster.
    const encryptFlag = resolveEncryptStorageFlag(this.node.tryGetContext(ENCRYPT_STORAGE_CONTEXT_KEY), this.fullId);
    const hasCmk = options?.storageEncryptionKeyArn !== undefined;
    if (!hasCmk && encryptFlag === undefined) {
      throw new Error(
        `Database "${this.fullId}": Aurora storage encryption must be acknowledged. ` +
          `For a NEW database, set "${ENCRYPT_STORAGE_CONTEXT_KEY}": true in the "context" section of cdk.json ` +
          `(projects created with create-blocks-app already set it), or pass storageEncryptionKeyArn. ` +
          `For an EXISTING unencrypted cluster, enabling encryption replaces the cluster with a new, empty one — ` +
          `follow the README "Enabling storage encryption on an existing database" steps, ` +
          `or set the flag to false to keep the current cluster as-is. See ${ENCRYPTION_MIGRATION_DOC}`,
      );
    }
    const storageEncrypted = hasCmk || encryptFlag === true ? true : undefined;
    if (storageEncrypted === undefined) {
      cdk.Annotations.of(this).addWarningV2(
        '@aws-blocks/bb-data:StorageEncryptionDisabled',
        `Aurora storage-at-rest encryption is not enabled for Database "${this.fullId}" because ` +
          `"${ENCRYPT_STORAGE_CONTEXT_KEY}" is set to false, so the cluster's storage is unencrypted. ` +
          `The existing cluster is left as-is. To move to an encrypted cluster without losing data, follow the README ` +
          `"Enabling storage encryption on an existing database" steps: ${ENCRYPTION_MIGRATION_DOC}`,
      );
    }

    const sharedVpc = providedVpcContext(this);
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
      storageEncrypted,
      storageEncryptionKey: options?.storageEncryptionKeyArn
        ? kms.Key.fromKeyArn(this, 'db-storage-key', options.storageEncryptionKeyArn)
        : undefined,
      backupRetention: cdk.Duration.days(backupRetentionDays),
      // Join the shared VPC only when the CUSTOMER provided it (`source:
      // 'provided'`). A Blocks-DERIVED shared VPC (e.g. one a container compute
      // created) is deliberately ignored: auto-joining it would move this
      // stateful cluster into a new VPC on a routine change — adding a container,
      // or bumping the dependency to a version that derives one — which
      // CloudFormation applies as a REPLACEMENT, destroying the database. With no
      // provided context, materialize() falls back to its own `${name}Vpc`,
      // exactly as before this shared-VPC work. Bringing a Database into a derived
      // shared VPC is a deliberate, out-of-band migration, never an implicit one.
      vpcContext: sharedVpc,
      clusterSubnets: resolveClusterSubnets(this, options?.subnets),
      // Migration Lambda log retention follows the stack-wide default.
      logRetention: this.defaults.logRetention,
      secretRotation,
    });

    // In a shared VPC, register the rotation Lambda's SG so core's endpoint SG
    // admits it (finalizeVpc adds the rule after every block is constructed; see
    // `VpcRequirements.endpointClientSecurityGroups`). With no shared VPC,
    // materialize() created its own endpoint + rule.
    if (infra.rotationSecurityGroup && sharedVpc) {
      registerVpcRequirements(this, {
        endpointClientSecurityGroups: [infra.rotationSecurityGroup],
        // The schedule rotates as soon as it exists, so core orders it after the
        // endpoints and the rule admitting the rotation Lambda. Only the
        // schedule, never this block: the endpoint security group references the
        // rotation security group, so a wider dependency would cycle.
        ...(infra.rotationSchedule ? { endpointClientDependents: [infra.rotationSchedule] } : {}),
      });
    }

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

  // Runtime-only methods throw during synth (see `synthGuard` in `@aws-blocks/core/cdk`).
  query(..._args: unknown[]): never { return synthGuard('Database', 'query'); }
  queryOne(..._args: unknown[]): never { return synthGuard('Database', 'queryOne'); }
  execute(..._args: unknown[]): never { return synthGuard('Database', 'execute'); }
  transaction(..._args: unknown[]): never { return synthGuard('Database', 'transaction'); }
  withRLS(..._args: unknown[]): never { return synthGuard('Database', 'withRLS'); }
  crud(..._args: unknown[]): never { return synthGuard('Database', 'crud'); }
}

export { fromExisting } from './from-existing.js';
export { DatabaseErrors } from './errors.js';
export { RLSEnabledDatabase } from './database.js';
export { PgClientEngine } from './engines/pg-client-engine.js';
export { sql, createKyselyAdapter } from '@aws-blocks/data-common';
export type { SqlQuery, Transaction } from '@aws-blocks/data-common';
export type { PgClientEngineConfig } from './engines/pg-client-engine.js';
export type { RLSContext } from './rls.js';
export type { DatabaseOptions, ExternalDatabaseRef, ExternalSslOptions, SubnetSelection } from './types.js';
export type { TableSchema, TableMetaEntry, CrudOptions, CrudMethods, QueryOpts, TableTypeMeta, CrudAuthResult } from './crud/types.js';
