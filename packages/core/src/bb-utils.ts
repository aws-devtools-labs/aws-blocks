// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Utilities for Building Block authors.
 *
 * Used by standard BBs and available to customers writing custom Building Blocks.
 * Not part of the main '.' export — import from '@aws-blocks/core/bb-utils'.
 */
export { getMockDataDir } from './common/mock-data.js';
export { API_NAMESPACE_MARKER } from './api.js';
export { EventSourceMapping } from './lambda-handler.js';
export { constantTimeEquals } from './common/crypto.js';

/**
 * Sanitize a Blocks identifier into a valid config/env-var key segment:
 * uppercase, with every non-alphanumeric character replaced by `_`.
 *
 * Blocks config entries are loaded into `process.env` at runtime
 * (`loadConfigToProcessEnv`), so a key must be a valid env-var name. Every
 * writer and reader of the same key MUST go through this function so they
 * reconstruct a byte-identical string — a hand-inlined variant that drifts
 * from this one silently misses the lookup at runtime.
 *
 * @example
 * ```typescript
 * registerConfig(this, `BLOCKS_QUEUE_URL_${sanitizeConfigKey(this.fullId)}`, url);
 * ```
 */
export function sanitizeConfigKey(id: string): string {
	return id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}
