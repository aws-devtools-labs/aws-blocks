// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shape-protocol constants shared by the server runtimes and the browser
 * client. Kept free of Node imports so the client bundle can use it.
 */

export { TOKEN_PARAM, shapePath } from '@aws-blocks/data-common/sync-shared';

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
