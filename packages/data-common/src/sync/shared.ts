// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/data-common/sync-shared — the side-effect-free, browser-safe
 * parts of `db.shape()`: constants and the `ShapeStore` base class. Safe to
 * import on the server (unlike `./sync-client`, which registers middleware).
 */

export { TOKEN_PARAM, shapePath } from './constants.js';
export { ServerShape, ShapeStore, liveShapes } from './shape-store.js';
export type { ShapeTransport } from './shape-store.js';
export type { Shape, ShapeBell, ShapeDescriptor, ShapeOptions, SyncHint } from './types.js';
export { SYNC_HINT } from './types.js';
export { camelToSnake, columnToField, fieldToColumn, mapRow, snakeToCamel } from './mapping.js';
export type { ColumnMapping } from './mapping.js';
export type { FieldCondition, SnapshotFilter, SnapshotOrder, SnapshotQuery } from './types.js';
