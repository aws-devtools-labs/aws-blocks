// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as esbuild from 'esbuild';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import type { Construct } from 'constructs';

export interface BackendImageProps {
  /** Absolute path to the app's backend handler entry (the same file the Lambda bundles). */
  backendHandlerPath: string;
  /** Image platform. Default: LINUX_AMD64. */
  platform?: ecr_assets.Platform;
  /** Container port the server listens on. Default: 8080. */
  port?: number;
}

/**
 * Stage the container build context for a Blocks backend: bundle the handler
 * with esbuild under the `aws-runtime` condition (the same condition the
 * Lambda bundle uses, so Building Blocks load their AWS implementations),
 * wrap it in the `@aws-blocks/core/http-server` entrypoint, and write a
 * minimal non-root Dockerfile.
 *
 * Returns the staging directory (the Docker build context).
 *
 * Exported separately from {@link buildBackendImageAsset} so tests can verify
 * the bundle without requiring Docker.
 */
export function stageBackendImage(props: BackendImageProps): string {
  const staging = mkdtempSync(join(tmpdir(), 'blocks-backend-image-'));
  const port = props.port ?? 8080;

  // The wrapper is the single esbuild entry: it pulls the user's handler and
  // the HTTP server into one self-contained ESM file.
  const wrapper = [
    `import { handler } from './${basename(props.backendHandlerPath)}';`,
    `import { startBlocksHttpServer } from '@aws-blocks/core/http-server';`,
    `await startBlocksHttpServer(handler);`,
    '',
  ].join('\n');

  // Sync API: this runs inside CDK construct instantiation, which is synchronous.
  esbuild.buildSync({
    stdin: {
      contents: wrapper,
      resolveDir: dirname(props.backendHandlerPath),
      sourcefile: 'blocks-container-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    minify: true,
    conditions: ['aws-runtime'],
    outfile: join(staging, 'server.mjs'),
    // ESM bundles of CommonJS dependencies need a require() shim.
    banner: {
      js: 'import { createRequire as __blocksCreateRequire } from "node:module"; const require = __blocksCreateRequire(import.meta.url);',
    },
    logLevel: 'warning',
  });

  const dockerfile = [
    'FROM public.ecr.aws/docker/library/node:22-slim',
    'ENV NODE_ENV=production',
    `ENV PORT=${port}`,
    'WORKDIR /app',
    'COPY server.mjs ./',
    'USER node',
    `EXPOSE ${port}`,
    'CMD ["node", "server.mjs"]',
    '',
  ].join('\n');
  writeFileSync(join(staging, 'Dockerfile'), dockerfile);

  return staging;
}

/**
 * Build the backend container image as a CDK ECR asset. Requires Docker on
 * the deploying machine (same requirement class as CDK image assets anywhere).
 */
export function buildBackendImageAsset(
  scope: Construct,
  id: string,
  props: BackendImageProps,
): ecr_assets.DockerImageAsset {
  const directory = stageBackendImage(props);
  return new ecr_assets.DockerImageAsset(scope, id, {
    directory,
    platform: props.platform ?? ecr_assets.Platform.LINUX_AMD64,
  });
}
