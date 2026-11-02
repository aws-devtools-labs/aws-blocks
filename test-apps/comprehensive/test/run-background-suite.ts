// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Child-process entry for one background suite (see ./background-suites.ts).
 *
 * Usage (spawned by e2e.test.ts, never run on its own):
 *   tsx -C browser test/run-background-suite.ts <suite>
 *
 * Runs one suite against the server or stack the parent e2e.test.ts already
 * started or deployed. It never starts, deploys or destroys anything, so it
 * only works while the parent is running.
 */

import { test } from 'node:test';
import type { api as apiType } from 'aws-blocks';
import { installCookieJar } from './cookie-jar.js';
import { agentTests } from './agent.test.js';
import { asyncJobTests } from './async-job.test.js';
import { asyncJobStatusTests } from './async-job-status.test.js';
import type { BackgroundSuiteName } from './background-suites.js';

const SUITES: Record<BackgroundSuiteName, (getApi: () => typeof apiType) => void> = {
  agent: agentTests,
  'async-job': asyncJobTests,
  'async-job-status': asyncJobStatusTests,
};

const name = process.argv[2];
if (!name || !Object.hasOwn(SUITES, name)) {
  throw new Error(`Unknown background suite "${name}". Known: ${Object.keys(SUITES).join(', ')}`);
}

let api: typeof apiType;

test.before(async () => {
  // Own cookie jar: this process starts signed out, whatever the parent's
  // suites do to theirs.
  installCookieJar();
  api = (await import('aws-blocks')).api;
});

test.after(async () => {
  // Close the realtime client's pooled WebSocket so this process can exit;
  // same reasoning as the matching block in e2e.test.ts.
  for (const spec of ['@aws-blocks/bb-realtime/mock-middleware', '@aws-blocks/bb-realtime/aws-middleware']) {
    try {
      const mw = await import(spec);
      (mw as { __resetConnectionsForTest?: () => void }).__resetConnectionsForTest?.();
    } catch {
      // Best-effort teardown.
    }
  }
  // Backstop, as in e2e.test.ts: a leaked handle fails the suite instead of
  // holding the parent until its budget runs out.
  const backstop = globalThis.setTimeout(() => {
    console.error('Open handles prevented clean exit after 15s; forcing exit with code 1. Fix the leak.');
    process.exit(1);
  }, 15000);
  backstop.unref();
});

SUITES[name as BackgroundSuiteName](() => api);
