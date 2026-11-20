// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Redirect } from '../../manifest/types.js';

/**
 * Trailing-slash mode declared by a framework's config. Mirrors the
 * shape Next.js + Astro both use; Nitro/Nuxt is per-route, not global,
 * and is not modeled here.
 */
export type TrailingSlashMode = 'always' | 'never' | 'ignore';

/**
 * Emit canonical-form 308 redirects for the configured trailing-slash
 * mode. Pure function — no I/O, no framework-specific knowledge.
 *
 * - `'always'`: `/foo` → 308 → `/foo/` (force trailing slash).
 * - `'never'`: `/foo/` → 308 → `/foo` (drop trailing slash).
 * - `'ignore'`: `[]` (no canonical form preferred; let both work).
 *
 * Skips the root `/` (no canonical form to enforce — `/` is `/`) and
 * skips wildcard patterns (`/foo/*`, `*`) which can't be redirected
 * verbatim. Caller is responsible for cap enforcement and ordering.
 */
export const emitTrailingSlashRedirects = (
  paths: string[],
  mode: TrailingSlashMode,
): Redirect[] => {
  if (mode === 'ignore' || paths.length === 0) return [];
  const out: Redirect[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw === '') continue;
    if (raw.includes('*')) continue;
    const path = raw.startsWith('/') ? raw : `/${raw}`;
    if (path === '/') continue;
    const hasTrailing = path.endsWith('/');
    if (mode === 'always' && !hasTrailing) {
      const source = path;
      if (seen.has(source)) continue;
      seen.add(source);
      out.push({ source, destination: `${path}/`, statusCode: 308 });
    } else if (mode === 'never' && hasTrailing) {
      const source = path;
      if (seen.has(source)) continue;
      seen.add(source);
      out.push({ source, destination: path.slice(0, -1), statusCode: 308 });
    }
  }
  return out;
};
