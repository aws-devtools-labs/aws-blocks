// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The child id of the session store of an `Auth` block: the `KVStore` that
 * holds the server-side sessions. The CDK entry and both runtimes build the
 * store under this one id. It gives the table its name
 * (`<fullId>-session-store`) and its logical id, and gives the mock its data
 * directory (`.bb-data/<fullId>-session-store/`).
 *
 * `AuthCognito` and `AuthOIDC` kept their sessions under the child id
 * `sessions`. The `KVStore` of this release keeps an item under another key
 * attribute, and a DynamoDB table cannot change its key. A new id makes the
 * upgrade a clean break: the first deploy creates a new table and removes the
 * old one from the stack, nothing reads the old table or the old local
 * directory, and each user signs in once more (MIGRATION.md).
 *
 * @internal
 */
export const SESSION_STORE_ID = 'session-store';
