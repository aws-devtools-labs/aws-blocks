// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side shape definition for `Database`. The engine-agnostic parts
 * (validation, signed tokens, the descriptor) live in
 * `@aws-blocks/data-common/sync` and are shared with `DistributedDatabase`;
 * this module re-exports them and adds the Electric-specific query mapping.
 */

import { compileSnapshotQuery } from '@aws-blocks/data-common/sync';
import type { ShapeClaims } from '@aws-blocks/data-common/sync';
export {
  buildClaims,
  deriveTokenKey,
  rejectionResponse,
  signClaims,
  toDescriptor,
  validateSyncOptions,
  verifyToken,
} from '@aws-blocks/data-common/sync';
export type { ShapeClaims, TokenRejection } from '@aws-blocks/data-common/sync';
export { CLIENT_PROTOCOL_PARAMS, ELECTRIC_EXPOSED_HEADERS, TOKEN_PARAM, shapePath } from './shape-constants.js';

/**
 * Electric's query parameters for the claims: table, where, params[n], columns.
 * Used by both the AWS proxy and the mock server (which reads them back), so
 * the two agree on the shape definition.
 */
export function claimsToElectricParams(claims: ShapeClaims): URLSearchParams {
  const params = new URLSearchParams();
  params.set('table', claims.t);
  if (claims.w) params.set('where', claims.w);
  for (const [i, value] of (claims.p ?? []).entries()) params.set(`params[${i + 1}]`, value);
  if (claims.c) params.set('columns', claims.c.join(','));
  if (claims.q) params.set('queryable_columns', claims.q.join(','));
  if (claims.m === 'c') params.set('log', 'changes_only');
  return params;
}

/** Electric's subset (snapshot) query parameters. */
export const SUBSET_PARAMS = ['subset__where', 'subset__params', 'subset__order_by', 'subset__limit', 'subset__offset'] as const;

/**
 * A client's snapshot request, compiled for Electric. The client sends the
 * structured `SnapshotQuery` (JSON) in `subset__where`; it never sends SQL.
 * Returns Electric's `subset__*` parameters with server-compiled SQL and bound
 * parameters, or `null` when the request is not a snapshot. Throws
 * `ShapeInvalidException` for a bad query.
 */
export function electricSubsetParams(claims: ShapeClaims, incoming: URLSearchParams): URLSearchParams | null {
  const packed = incoming.get('subset__where');
  if (packed === null) return null;
  let query: unknown;
  try {
    query = JSON.parse(packed);
  } catch {
    query = undefined;
  }
  const compiled = compileSnapshotQuery(query, claims.q ?? claims.c ?? null, undefined, 1, claims.k);
  const params = new URLSearchParams();
  // Electric needs a condition: `true` selects the whole shape.
  params.set('subset__where', compiled.where ?? 'true');
  if (compiled.params.length > 0) {
    params.set('subset__params', JSON.stringify(Object.fromEntries(compiled.params.map((value, i) => [String(i + 1), value]))));
  }
  if (compiled.orderBy) params.set('subset__order_by', compiled.orderBy);
  if (compiled.limit !== null) params.set('subset__limit', String(compiled.limit));
  if (compiled.offset !== null) params.set('subset__offset', String(compiled.offset));
  return params;
}
