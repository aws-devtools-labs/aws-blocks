// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Which compute serves which API namespace, as seen by a running compute.
//
// With `defaults.strictNamespacePlacement`, the CDK layer writes the placement of
// every API namespace that runs on a non-default compute into the backend config
// (`BLOCKS_API_NAMESPACE_COMPUTES`) and stamps each of those computes with its
// own id (`BLOCKS_API_COMPUTE_ID`). Each compute's dispatcher then serves only
// the namespaces placed on it: the default compute (no id) refuses a namespace
// placed elsewhere, even on the bare `/aws-blocks/api` endpoint, and a
// non-default compute refuses every namespace that isn't its own.
//
// Kept free of Node and CDK imports: the CDK layer imports the key names, the
// Lambda handler and the container HTTP server import the parser.

/**
 * Config key holding the placement map: a JSON object from API namespace export
 * name to the id of the compute it runs on, for each namespace placed on a
 * compute other than the default one. Absent unless `strictNamespacePlacement` is on.
 *
 * @internal
 */
export const API_NAMESPACE_COMPUTES_KEY = 'BLOCKS_API_NAMESPACE_COMPUTES';

/**
 * Environment variable naming the compute a process runs on, set on each
 * non-default compute that hosts an API namespace. Absent on the default compute.
 *
 * @internal
 */
export const API_COMPUTE_ID_KEY = 'BLOCKS_API_COMPUTE_ID';

/**
 * Whether this compute serves the API namespace with the given export name.
 *
 * @internal
 */
export type ServesApiNamespace = (exportName: string) => boolean;

/**
 * Build the namespace filter for this compute from its environment, or
 * `undefined` when no placement is configured (every namespace is served, the
 * behaviour without `strictNamespacePlacement`).
 *
 * A compute id with no placement map means the compute's definition and the map
 * disagree. That throws rather than serving every namespace: the Lambda handler
 * retries initialization on the next request, and a container task that fails to
 * start is replaced.
 *
 * @param env - the process environment, after the backend config is loaded into it
 * @throws {Error} When the placement config is present but isn't a JSON object of
 * strings, or when this compute has an id but no placement config.
 * @internal
 */
export function apiNamespaceFilterFromEnv(
  env: Record<string, string | undefined> = process.env,
): ServesApiNamespace | undefined {
  const raw = env[API_NAMESPACE_COMPUTES_KEY];
  const self = env[API_COMPUTE_ID_KEY] || undefined;
  if (raw === undefined || raw === '') {
    if (self === undefined) return undefined;
    throw new Error(
      `[Blocks] ${API_COMPUTE_ID_KEY} is set but ${API_NAMESPACE_COMPUTES_KEY} is missing: this compute can't tell ` +
        'which API namespaces it serves, so it serves none until both are deployed',
    );
  }
  const placement = parsePlacement(raw);
  return (exportName) => {
    const placedOn = Object.hasOwn(placement, exportName) ? placement[exportName] : undefined;
    return placedOn === self;
  };
}

function parsePlacement(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((v) => typeof v === 'string')
  ) {
    throw new Error(
      `[Blocks] ${API_NAMESPACE_COMPUTES_KEY} must be a JSON object mapping API namespace names to compute ids`,
    );
  }
  return parsed as Record<string, string>;
}
