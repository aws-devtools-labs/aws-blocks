// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Names that the CDK layer and the migration Lambda (`migrate-lambda.ts`)
 * share. This file has no imports, so the CDK entry can read it without
 * loading an AWS SDK client.
 */

/** The custom resource that copies the items of the old table and replays its stream up to its tip. */
export const MIGRATE_COPY_RESOURCE_TYPE = 'Custom::BlocksKvMigrateCopy';

/** The custom resource that follows the stream of the old table through the update of the app's functions. */
export const MIGRATE_DRAIN_RESOURCE_TYPE = 'Custom::BlocksKvMigrateDrain';

/**
 * Where the drain keeps its position in the stream between two invocations:
 * a Systems Manager parameter under this path. (Systems Manager reserves
 * names that begin with `aws` or `ssm`.)
 */
export const MIGRATE_PARAMETER_PATH = '/blocks/kv-migrate/';

/** How long the drain follows the old table after the app's functions are updated, when `drainSeconds` is not set. */
export const DEFAULT_DRAIN_SECONDS = 45;

/** The longest `drainSeconds`. The drain is one custom resource, and CloudFormation gives a custom resource one hour. */
export const MAX_DRAIN_SECONDS = 900;

/** The attributes of an item of a release up to 0.4.0: `{ pk, value: <JSON text>, ttl? }`. */
export const RELEASE_PK = 'pk';
export const RELEASE_VALUE = 'value';
export const RELEASE_TTL = 'ttl';
