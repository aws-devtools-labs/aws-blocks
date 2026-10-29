// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Pure core of the parity bench: types, catalog validation, breakpoint search, differ and report.
// No I/O, so it is safe to import from any layer (server, client, CLI, browser).

export * from './types.js';
export { findBreakpoint } from './breakpoint.js';
export type { BreakpointResult } from './breakpoint.js';
export { validateCatalog } from './catalog.js';
export type { CatalogProblem } from './catalog.js';
export { cell, diff, normalize, renderMarkdown, suiteMapper } from './report.js';
export type { Finding, SuiteMapper, Verdict } from './report.js';
