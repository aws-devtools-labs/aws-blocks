// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal entry point (`@aws-blocks/data-common/internal`): first-party
 * plumbing shared by `bb-data` and `bb-distributed-data`, intentionally NOT
 * part of the package's public API. No backward-compatibility guarantee.
 *
 * @packageDocumentation
 */

export { closeOnProcessExit, pgliteUnrefTimersExtension } from './pglite-process.js';
