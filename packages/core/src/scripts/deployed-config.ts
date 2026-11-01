// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The stages a deploy records its API URL for. */
export type DeployedStage = 'sandbox' | 'production';

/**
 * The file, in `.blocks-sandbox/`, where a deploy of `stage` records its API
 * URL: `config.sandbox.json` or `config.production.json`.
 *
 * It is never `config.json`. Only a dev server writes that file, and it holds
 * that server's local URL. The Node.js client reads `config.json` from disk, so
 * a deploy that rewrote it would point the local loop at AWS (the e2e tests, a
 * Next.js Server Component) while `npm run dev` runs. Code that means to target
 * a deployed stage reads this file instead.
 */
export function deployedConfigFile(stage: DeployedStage): string {
  return `config.${stage}.json`;
}

/** Record `apiUrl` as the deployed API of `stage` in `outDir` (see {@link deployedConfigFile}). */
export function writeDeployedConfig(outDir: string, stage: DeployedStage, apiUrl: string): void {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, deployedConfigFile(stage));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ apiUrl, environment: stage }, null, 2));
  renameSync(tmp, path);
}
