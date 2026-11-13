// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared constants for the Database Building Block.
 */

/** Regex to sanitize names into valid environment variable / resource name segments. */
export const ENV_NAME_SANITIZE_PATTERN = /[^a-zA-Z0-9]/g;

/** Prefix for environment variables injected by the CDK layer and read by DataApiEngine. */
export const ENV_VAR_PREFIX = 'BLOCKS';

/** Default PostgreSQL port. */
export const DEFAULT_POSTGRES_PORT = 5432;

/** Default minimum Aurora Capacity Units (ACUs). */
export const DEFAULT_MIN_CAPACITY = 0.5;

/** Default maximum Aurora Capacity Units (ACUs). */
export const DEFAULT_MAX_CAPACITY = 2;

/**
 * Default automated-backup retention (days) for the Aurora cluster, which is
 * also the enabled point-in-time-recovery window. Matches the SecureCDK
 * baseline. Single source of truth for both the CDK layer (index.cdk.ts) and the
 * materialization layer (infra.ts).
 */
export const DEFAULT_BACKUP_RETENTION_DAYS = 15;

/** Number of availability zones for the Aurora VPC. */
export const VPC_MAX_AZS = 2;

/** CDK context key carrying the project's Aurora storage-encryption choice. */
export const ENCRYPT_STORAGE_CONTEXT_KEY = '@aws-blocks/bb-data:encryptStorageByDefault';

/**
 * README section with the steps to move an existing unencrypted cluster onto an
 * encrypted one (or keep it as-is). Referenced from the synth error and warning,
 * and from the pre-deploy storage-encryption check.
 */
export const ENCRYPTION_MIGRATION_DOC =
  'https://github.com/aws-devtools-labs/aws-blocks/blob/main/packages/bb-data/README.md#enabling-storage-encryption-on-an-existing-database';

/**
 * CloudFormation resource metadata key the CDK layer puts on a provisioned
 * `AWS::RDS::DBCluster` whose storage is encrypted. Its value is the Database's
 * full id. The pre-deploy check (predeploy.ts) uses it to find the clusters this
 * block manages in the synthesized templates. It is added only when
 * `StorageEncrypted: true` is emitted, so an opted-out cluster's template is
 * unchanged.
 */
export const STORAGE_ENCRYPTION_METADATA_KEY = '@aws-blocks/bb-data:database';
