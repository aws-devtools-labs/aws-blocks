// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub - KVStore and LegacyKVStore run server-side only. Frontends import this entry
// for the error constants (`isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)`)
// and for the types; the data methods have no browser implementation.
export class KVStore {}
/**
 * The store of a `KVStore` release up to 0.4.0, for an upgrade. It runs server-side only.
 *
 * @deprecated Only for the upgrade of a store from a release up to 0.4.0. The class is frozen: it has
 *   the API of that release and gets no new features. Use `KVStore` for new data, and remove the
 *   `LegacyKVStore` when the copy is done. The steps are in the README section "Upgrade from release
 *   0.4.0 or earlier":
 *   https://github.com/aws-devtools-labs/aws-blocks/blob/main/packages/bb-kv-store/README.md#upgrade-from-release-040-or-earlier
 */
export class LegacyKVStore {}
export { KVStoreErrors } from './errors.js';
export type * from './types.js';
