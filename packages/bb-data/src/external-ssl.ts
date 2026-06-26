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
 *
 * When no CA is configured the connection is encrypted but unverified. That is an
 * acceptable default for an interactive operator connecting to their own database,
 * but a privileged automated path (CI/CD migrations applying DDL) should not run
 * unverified silently — so in a non-interactive run (`CI` set) this throws unless
 * the caller explicitly opts in via `allowUnverifiedInCi` (used by first-pull
 * introspection, which by definition runs before a CA has been captured).
 */
const PEM_CERT_MARKER = '-----BEGIN CERTIFICATE-----';

/**
 * Whether we're running in a non-interactive automation context (CI/CD), where a
 * privileged DB operation must not silently run unverified.
 *
 * Detection is best-effort and based on the conventional `CI` env var (set by
 * GitHub Actions, GitLab, CircleCI, etc.), explicitly treating the common
 * `CI=false` / `CI=0` opt-out strings as interactive. Limitation: a pipeline or
 * deploy host that does not set `CI` is treated as interactive, so the unverified
 * fallback still applies there — set `DATABASE_CA_CERT` to guarantee verification
 * in any automated run.
 */
function isNonInteractive(): boolean {
  const ci = process.env.CI;
  return !!ci && ci !== 'false' && ci !== '0';
}

/** Read a CA file, surfacing a TLS-specific error instead of a bare ENOENT. */
function readCaFile(filePath: string): string {
  let pem: string;
  try {
    pem = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `[bb-data] DB TLS: could not read the CA certificate at DATABASE_CA_CERT="${filePath}": ` +
      `${(err as Error).message}. Point DATABASE_CA_CERT at your provider CA (e.g. prod-ca-2021.crt) ` +
      `or unset it. See MIGRATION_GUIDE.md.`,
    );
  }
  if (!pem.includes(PEM_CERT_MARKER)) {
    throw new Error(
      `[bb-data] DB TLS: the CA file at DATABASE_CA_CERT="${filePath}" is empty or not a PEM ` +
      `certificate (missing "${PEM_CERT_MARKER}").`,
    );
  }
  return pem;
}

export function externalDbSsl(opts: { allowUnverifiedInCi?: boolean } = {}): { ca?: string; rejectUnauthorized: boolean } {
  const source = process.env.DATABASE_CA_CERT;
  if (source && source.trim() !== '') {
    // An inline PEM contains the certificate marker; anything else is treated as
    // a file path (`-----BEGIN CERTIFICATE-----`, not a looser `-----BEGIN`, so a
    // stray CSR/private key is not mistaken for a CA).
    const pem = source.includes(PEM_CERT_MARKER) ? source : readCaFile(source);
    if (!pem.includes(PEM_CERT_MARKER)) {
      throw new Error(
        `[bb-data] DB TLS: DATABASE_CA_CERT does not contain a PEM certificate (missing "${PEM_CERT_MARKER}").`,
      );
    }
    return { ca: pem, rejectUnauthorized: true };
  }
  // No CA available. Fail closed in non-interactive automation (DDL/migrations
  // must not run against an unverified server), unless the caller opts in.
  if (isNonInteractive() && !opts.allowUnverifiedInCi) {
    throw new Error(
      '[bb-data] DB TLS: no CA certificate available (DATABASE_CA_CERT unset) in a non-interactive ' +
      'run, refusing to open an unverified connection for a privileged database operation. ' +
      'Set DATABASE_CA_CERT to your provider CA (e.g. prod-ca-2021.crt). See MIGRATION_GUIDE.md.',
    );
  }
  // Interactive operator path: encrypted but unauthenticated. Acceptable for these
  // ephemeral, operator-driven connections to a database the operator owns; pin
  // DATABASE_CA_CERT to verify the server identity.
  console.warn(
    '[bb-data] DB TLS: server certificate NOT verified — encrypted only (no CA). ' +
    'Set DATABASE_CA_CERT to your provider CA to verify. See MIGRATION_GUIDE.md.',
  );
  return { rejectUnauthorized: false };
}
