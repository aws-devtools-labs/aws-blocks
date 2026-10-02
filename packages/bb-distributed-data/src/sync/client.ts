// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Client middleware for `db.shape()` on `DistributedDatabase`. Imported by the
 * generated client when a backend has a `DistributedDatabase` with `sync`.
 *
 * Registers {@link ReconcileShape} as the shape class for `'reconcile'`
 * shapes. The shared middleware in `@aws-blocks/data-common/sync-client`
 * hydrates `{ __blocks: 'data/shape' }` descriptors in API responses and
 * refreshes expired tokens by calling the originating API method again.
 */

import { registerShapeProtocol } from '@aws-blocks/data-common/sync-client';
import { ReconcileShape } from './reconcile-shape.js';

export { hydrate } from '@aws-blocks/data-common/sync-client';

registerShapeProtocol('reconcile', (descriptor, transport) => new ReconcileShape(descriptor, transport));
