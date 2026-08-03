// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Blocks whose runtime loads an asset through `new URL(..., import.meta.url)`,
 * plus the underlying packages that do the loading.
 *
 * Bundlers rewrite that URL expression, which breaks the load. Both Turbopack and
 * webpack fail identically without this list: bb-data's PGlite engine throws a
 * TypeError reporting that the "path" argument received an instance of URL.
 *
 * Marking a package external has a second, deliberate effect: Node performs the
 * resolution instead of the bundler, and Node honors custom export conditions
 * (such as `aws-runtime`) where Turbopack does not.
 */
export const BLOCKS_SERVER_EXTERNAL_PACKAGES: readonly string[] = [
	// Local dev runs real Postgres in-process via PGlite (WASM).
	'@aws-blocks/bb-data',
	'@aws-blocks/bb-distributed-data',
	'@electric-sql/pglite',
];
