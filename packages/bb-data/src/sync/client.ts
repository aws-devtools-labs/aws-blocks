// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Client middleware for `db.shape()`. Imported by the generated client when a
 * backend has a `Database` with `sync` enabled.
 *
 * Registers {@link LiveShape} as the shape class for Electric shapes. The
 * shared middleware in `@aws-blocks/data-common/sync-client` hydrates
 * `{ __blocks: 'data/shape' }` descriptors in API responses into live shapes.
 * Each hydrated shape remembers the API call that produced it, so when its
 * token expires it calls the same method again: the app's authorization check
 * runs again and issues a fresh token.
 */

import { registerShapeProtocol } from '@aws-blocks/data-common/sync-client';
import { LiveShape } from './live-shape.js';

export { hydrate } from '@aws-blocks/data-common/sync-client';

registerShapeProtocol('electric', (descriptor, transport) => new LiveShape(descriptor, transport));
