// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { legacyDeployedStage } from '../client/legacy-config.js';

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

/**
 * Move a `config.json` that a deploy from core 0.8.0 or earlier wrote in `outDir`
 * (see `legacyDeployedStage`) to the `config.<stage>.json` of its stage, unless
 * a newer deploy already recorded that stage, and remove it, so the local loop
 * no longer finds an AWS URL there. A dev server's own `config.json` stays.
 * Deploy, sandbox deploy and both destroys run it first. Never throws.
 */
export function migrateLegacyDeployedConfig(outDir: string): void {
  const legacy = join(outDir, 'config.json');
  try {
    const config = JSON.parse(readFileSync(legacy, 'utf-8')) as { apiUrl?: unknown };
    const stage = legacyDeployedStage(config);
    if (!stage) return;
    if (!existsSync(join(outDir, deployedConfigFile(stage))) && typeof config.apiUrl === 'string') {
      writeDeployedConfig(outDir, stage, config.apiUrl);
    }
    rmSync(legacy, { force: true });
    console.error(`ℹ️  Moved the ${stage} API URL an older deploy wrote to .blocks-sandbox/config.json into ${deployedConfigFile(stage)}.`);
  } catch {
    // No config.json, or one that does not parse: nothing a deploy wrote.
  }
}
