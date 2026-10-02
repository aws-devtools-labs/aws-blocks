// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shape constants shared by the server runtimes and the browser client.
 * Kept free of Node imports so the client bundle can use it.
 */

/** Name of the query parameter that carries the shape token. */
export const TOKEN_PARAM = 'token';

/**
 * Path of the shape endpoint for a database.
 *
 * Built from the ids of the database and its enclosing scopes, without the
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
