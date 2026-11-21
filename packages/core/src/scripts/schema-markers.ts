// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Set on a named object schema to the declaration it comes from
 * (`<file>#<name>`, the file relative to the working directory), so
 * `generate-spec` can tell instantiations of one generic type from two types
 * that share a name, and name both in its warning. Internal: stripped before
 * the spec is written.
 *
 * In its own module, without the TypeScript compiler, so `generate-spec` can
 * read it while `extract-ts-types.ts` (which imports `typescript`) is loaded
 * only when the spec is generated.
 */
export const DECLARATION_MARKER = 'x-blocks-declaration';
