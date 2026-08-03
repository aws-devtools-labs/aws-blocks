// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Keeps this module out of the browser bundle. A Client Component that imports it
// fails the build with a clear error instead of quietly shipping an AWS SDK — and
// PGlite — to the browser. Client code reaches the server via Server Actions.
import 'server-only';

import { Database, KVStore, Scope } from '@aws-blocks/blocks';
import { createDataClient } from '@aws-blocks/bb-data/fluent';
import { type TableMeta, tableMeta } from './schema/database.meta';

// Constructors ARE the infrastructure definition: one file, no sub-package, no
// wrapper methods. The same file is what CDK synth reads at deploy time.
const scope = new Scope('dx-poc');

/** Real Postgres. In-process PGlite locally; Aurora when deployed. */
export const db = new Database(scope, 'main', { migrationsPath: './migrations' });

/** Used to show a second block sharing the same scope. */
export const cache = new KVStore(scope, 'cache');

/**
 * Typed query client. Both arguments are generated from ./migrations, so table and
 * column names are checked against the real schema instead of trusted.
 */
export const data = createDataClient<TableMeta>(db, tableMeta);
