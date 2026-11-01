// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The process that `blocks-generate-client` (`generate-client-cli.ts`) starts
 * to generate the client: it runs the client-generation worker of
 * `@aws-blocks/core`, which reads the same arguments
 * (`<foundationPath> <outputPath>`) and imports the backend.
 *
 * At `BLOCKS_LOG_LEVEL=quiet` (`blocks -q`) the warnings that importing the
 * backend prints are hidden: a Building Block's runtime warning, such as
 * Realtime's `BLOCKS_RT_WS_URL not set`, says nothing about the generated client.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

if (process.env.BLOCKS_LOG_LEVEL?.toLowerCase() === 'quiet') console.warn = () => {};

// Dynamic: a static import would evaluate the worker, and import the backend, before the line above runs.
await import(pathToFileURL(require.resolve('@aws-blocks/core/scripts/generate-client-worker')).href);
