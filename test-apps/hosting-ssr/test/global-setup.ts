// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { FullConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEPLOY_TIMEOUT_MS, ensureTestSupportSecret, isSandboxRun, projectRoot, runSandboxScript } from './sandbox-lifecycle.js';

/** Consecutive good answers that count as "the hosting URL is serving the app". */
const SERVING_STREAK = 3;
/** Pause between polls of the hosting URL. */
const SERVING_POLL_INTERVAL_MS = 5_000;
/** Upper bound on the wait for the hosting URL to serve the app after the deploy. */
const SERVING_TIMEOUT_MS = 4 * 60_000;
/** Upper bound on a single poll, so a hung connection can't stall the wait. */
const SERVING_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Playwright `globalSetup`: deploy the sandbox once per run (sandbox mode only).
 * The deployed stack's outputs land in `.blocks-sandbox/outputs.json`, which the
 * spec's `beforeAll` reads. See `sandbox-lifecycle.ts` for why this is not a hook.
 *
 * The deploy returns at CREATE_COMPLETE, which can come before CloudFront serves
 * the app. An app whose `playwright.config.ts` sets `metadata.servingMarker` (a
 * string its page always contains) waits after the deploy until the hosting URL
 * serves that page; see `waitUntilServing`. Apps without one start right away.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  if (!isSandboxRun()) return;
  ensureTestSupportSecret();
  console.log(`🚀 Deploying ${basename(projectRoot)} sandbox...\n`);
  await runSandboxScript(join(projectRoot, 'test', 'sandbox-deploy.ts'), DEPLOY_TIMEOUT_MS);
  const marker: unknown = config.metadata.servingMarker;
  if (typeof marker === 'string' && marker) await waitUntilServing(readHostingUrl(), marker);
}

/** The deployed hosting URL, read from the stack outputs the same way the spec's `beforeAll` does. */
function readHostingUrl(): string {
  const outputs = JSON.parse(readFileSync(join(projectRoot, '.blocks-sandbox', 'outputs.json'), 'utf-8'));
  const stackOutputs = Object.values(outputs)[0] as Record<string, string>;
  const hostingKey = Object.keys(stackOutputs).find((k) => k.startsWith('HostingHostingUrl'));
  const url = hostingKey ? stackOutputs[hostingKey] : '';
  if (!url) throw new Error('HostingHostingUrl* not found in stack outputs: ' + JSON.stringify(stackOutputs));
  return url.startsWith('http') ? url : `https://${url}`;
}

/**
 * Poll `url` until it answers 200 with a body containing `marker`
 * {@link SERVING_STREAK} times in a row, so the tests don't start while
 * CloudFront still answers with an error. Fails after {@link SERVING_TIMEOUT_MS}
 * with the last status it saw.
 */
async function waitUntilServing(url: string, marker: string): Promise<void> {
  const deadline = Date.now() + SERVING_TIMEOUT_MS;
  let streak = 0;
  let lastStatus = 'no response';
  console.log(`⏳ Waiting for ${url} to serve the app...`);
  while (true) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(SERVING_REQUEST_TIMEOUT_MS) });
      const body = await res.text();
      lastStatus = String(res.status);
      if (res.status === 200 && body.includes(marker)) {
        streak++;
        if (streak >= SERVING_STREAK) {
          console.log(`✅ ${url} is serving the app\n`);
          return;
        }
      } else {
        streak = 0;
        if (res.status === 200) lastStatus = `200 without ${marker}`;
      }
    } catch (err) {
      streak = 0;
      lastStatus = `request failed (${err instanceof Error ? err.message : String(err)})`;
    }
    if (Date.now() + SERVING_POLL_INTERVAL_MS > deadline) {
      throw new Error(
        `${url} did not answer 200 with ${marker} ${SERVING_STREAK} times in a row within ` +
          `${SERVING_TIMEOUT_MS / 1000}s of the deploy; last status: ${lastStatus}`,
      );
    }
    await sleep(SERVING_POLL_INTERVAL_MS);
  }
}
