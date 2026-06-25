// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';

/**
 * TLS config for the library's **operational** (non-runtime) connections to an
 * external database: `db pull` schema introspection, the migrate CLI, the
 * pg_dump version check, and the external-migration runner.
 *
 * These are short-lived connections opened from the developer / CI host (session
 * port 5432) using a connection string the operator just supplied. They verify
 * the server certificate when a CA is available and otherwise fall back to an
 * encrypted-but-unverified connection.
 *
 * Providers like Supabase present a certificate signed by a private CA
 * (Supabase ships `prod-ca-2021`, downloadable from Database Settings → SSL
 * Configuration) that is not in Node's built-in trust store, so verification
 * requires pinning that CA. Supply it via `DATABASE_CA_CERT` as either an inline
 * PEM string or a path to a `.crt`/`.pem` file. When set, the connection is
 * verified end-to-end (equivalent to `sslmode=verify-full`).
 *
 * Note: for the CA to take effect, any `sslmode` must be stripped from the URL —
 * node `pg` verifies against the system trust store and ignores a programmatic
 * `ssl.ca` when `sslmode` is present in the connection string. The callers in
 * this package already normalize the URL before connecting.
 */
export function externalDbSsl(): { ca?: string; rejectUnauthorized: boolean } {
  const ca = process.env.DATABASE_CA_CERT;
  if (ca && ca.trim() !== '') {
    const pem = ca.includes('-----BEGIN') ? ca : readFileSync(ca, 'utf8');
    return { ca: pem, rejectUnauthorized: true };
  }
  // No CA available — encrypted but unauthenticated. Acceptable for these
  // ephemeral, operator-driven connections to a database the operator owns;
  // pin DATABASE_CA_CERT to verify the server identity.
  return { rejectUnauthorized: false };
}
