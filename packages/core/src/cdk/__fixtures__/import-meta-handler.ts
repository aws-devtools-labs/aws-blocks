// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Repro fixture for the "handler bundles to CJS but uses import.meta.url" bug.
//
// The handler is bundled to CJS by NodejsFunction. In a CJS bundle `import.meta`
// is empty, so this top-level `fileURLToPath(import.meta.url)` would become
// `fileURLToPath(undefined)` and throw at Lambda load. blocksNodejsBundling shims
// `import.meta.url` to a CommonJS equivalent, so the bundle loads and resolves a
// real path instead of crashing — see bundling.test.ts.
import { fileURLToPath } from 'node:url';

export const moduleDir = fileURLToPath(import.meta.url);

// Reference moduleDir so esbuild can't tree-shake the import.meta.url usage away.
export const handler = async () => ({ statusCode: 200, body: JSON.stringify({ moduleDir }) });
