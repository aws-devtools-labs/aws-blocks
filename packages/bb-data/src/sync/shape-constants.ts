// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shape-protocol constants shared by the server runtimes and the browser
 * client. Kept free of Node imports so the client bundle can use it.
 */

/** Name of the query parameter that carries the shape token. */
export const TOKEN_PARAM = 'token';

/** Electric shape-protocol response headers the browser must be able to read. */
export const ELECTRIC_EXPOSED_HEADERS = [
  'electric-cursor',
  'electric-handle',
  'electric-offset',
  'electric-schema',
  'electric-up-to-date',
  'electric-snapshot',
].join(', ');

/**
 * Electric protocol query parameters a client may set. Everything else
 * (table, where, params, columns, secret) comes from the token or the server.
 */
export const CLIENT_PROTOCOL_PARAMS = ['offset', 'handle', 'live', 'cursor', 'cache-buster', 'expired_handle'] as const;

/**
 * Path of the shape endpoint for a Database.
 *
 * Built from the ids of the Database and its enclosing scopes, without the
 * stack: `fullId` carries the stack name on AWS but not locally, and the path
 * must be identical in both, because the sandbox dev server routes requests to
 * AWS by matching its locally registered path.
 */
export function shapePath(scope: { id: string; parent?: unknown }): string {
  const ids: string[] = [];
  let node: { id: string; parent?: unknown } | undefined = scope;
  while (node && 'parent' in node && node.parent) {
    ids.unshift(node.id);
    node = node.parent as { id: string; parent?: unknown };
  }
  return `/aws-blocks/sync/${encodeURIComponent(ids.join('-'))}/v1/shape`;
}
