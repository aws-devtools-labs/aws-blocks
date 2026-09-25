// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public entry for `@aws-blocks/cli`. Re-exports the parser factory and the
 * app-path helpers so they can be driven programmatically (and tested) without
 * spawning the bin.
 */

export { createMainParser } from './main_parser_factory.js';
export { resolveAppPaths, requireBlocksApp, NotABlocksAppError } from './paths.js';
export { handleError, reportError } from './error_handler.js';
