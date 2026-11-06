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

/**
 * Default rotation interval (days) for the cluster's credentials secret.
 * Matches CDK's `addRotationSingleUser` default.
 */
export const DEFAULT_SECRET_ROTATION_DAYS = 30;

/**
 * Minimum rotation interval (days). Blocks' own bound: Secrets Manager and CDK
 * accept down to 4 hours, but the option is expressed in whole days.
 */
export const MIN_SECRET_ROTATION_DAYS = 1;

/**
 * Maximum rotation interval (days). Secrets Manager's bound; CDK enforces it at
 * synth too.
 */
export const MAX_SECRET_ROTATION_DAYS = 1000;

/** Number of availability zones for the Aurora VPC. */
export const VPC_MAX_AZS = 2;
