// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ExternalDatabaseRef } from './types.js';

/**
 * Reference an existing database not managed by the Database Building Block.
 * Pass the returned reference to the Database constructor's `connection` option.
 *
 * Supports two forms:
 * - `{ connectionString, ssl? }` — direct connection (Supabase, Neon, etc.)
 * - `{ host, port, database, secretArn }` — AWS-managed (Aurora via Secrets Manager)
 *
 * For the connection-string form, the server certificate is **verified by
 * default**. Pass `ssl: { ca }` to pin a provider CA (recommended — for Supabase
 * download `prod-ca-2021.crt` from Database Settings → SSL Configuration), or
 * `ssl: { rejectUnauthorized: false }` to disable verification (not recommended
 * for production — encrypted but exposed to man-in-the-middle).
 *
 * @param config - Connection details for the external database
 * @returns The config object (passthrough)
 */
export const fromExisting = (config: ExternalDatabaseRef): ExternalDatabaseRef => config;
