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

/** Default credentials-rotation interval (days). CDK's own default for the schedule. */
export const DEFAULT_SECRET_ROTATION_DAYS = 30;

/** Minimum credentials-rotation interval (days). Secrets Manager itself allows 4 hours. */
export const MIN_SECRET_ROTATION_DAYS = 1;

/** Maximum credentials-rotation interval (days). Secrets Manager's own limit. */
export const MAX_SECRET_ROTATION_DAYS = 1000;

/** How long the deploy waits for the rotation the schedule starts. */
export const ROTATION_WAIT_MAX_MS = 5 * 60 * 1000;

/** Margin over {@link ROTATION_WAIT_MAX_MS} for the wait Lambda's own timeout. */
export const ROTATION_WAIT_MARGIN_MS = 2 * 60 * 1000;

/** Partitions the rotation application is published in; CDK maps only these. */
export const SAR_ROTATION_PARTITIONS = ['aws', 'aws-cn', 'aws-us-gov'];

/** Number of availability zones for the Aurora VPC. */
export const VPC_MAX_AZS = 2;
