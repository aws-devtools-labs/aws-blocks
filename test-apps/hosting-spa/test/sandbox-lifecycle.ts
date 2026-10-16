// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sandbox deploy/teardown for the sandbox e2e run, wired into `playwright.config.ts`
 * as `globalSetup` / `globalTeardown`. Identical in every hosting test app.
 *
 * Why not `test.beforeAll` / `test.afterAll`: Playwright runs a hook under the test
 * timeout (60–90s here), and a CloudFront deploy takes ~10 minutes. The deploy blocks
 * the worker's event loop in `execFileSync`, so the timeout timer only fires once the
 * hook next yields — the hook "passes" if it never awaits after the deploy and fails
 * if it does (reading the test-support secret from SSM does). Worse, a file-level hook
 * runs once per worker: a test retry starts a fresh worker, so `retries: 1` destroyed
 * and redeployed the whole stack before retrying. Global setup runs once per
 * `playwright test` invocation, in the runner, outside any test timeout; retries reuse
 * the deployed stack. Global teardown is scheduled before global setup runs, so it
 * still runs when the deploy fails part-way (a half-created stack is destroyed).
 */

import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Upper bound on `test/sandbox-deploy.ts`. A real hosting-ssr run took ~10.5 min
 * (pre-cleanup destroy, ~90s synth, ~425s CloudFormation); 30 min is ~3× that.
 */
export const DEPLOY_TIMEOUT_MS = 30 * 60_000;

/**
 * Upper bound on `test/sandbox-destroy.ts` (CloudFront distributions are disabled
 * before deletion, which is the slow part). Deploy + destroy bounds (50 min) fit
 * inside the CI job's `timeout-minutes: 60`.
 */
export const DESTROY_TIMEOUT_MS = 20 * 60_000;

/** The app root (the directory holding `playwright.config.ts`). */
export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Deploys only for `BLOCKS_TEST_ENV=sandbox`; local runs test against a dev server. */
export function isSandboxRun(): boolean {
  return (process.env.BLOCKS_TEST_ENV || 'local') === 'sandbox';
}

/**
 * Run a sandbox script (`test/sandbox-deploy.ts` or `test/sandbox-destroy.ts`, by
 * absolute path) to completion with `tsx`, stopping it with SIGTERM after `timeoutMs`.
 *
 * The script runs in its own process group, and a timeout signals the whole group.
 * `npx tsx <script>` is three processes deep (npx, tsx, the script), and the script
 * itself starts more (`cdk deploy`). Killing only the direct child — what
 * `execFileSync`'s `timeout` does — leaves the script and its `cdk` running, orphaned,
 * so a hung deploy kept going after the run had "stopped" it.
 */
export function runSandboxScript(scriptPath: string, timeoutMs: number): Promise<void> {
  const backendPath = join(projectRoot, 'aws-blocks', 'index.cdk.ts');
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', scriptPath, backendPath], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
      detached: true,
    });
    let timedOut = false;
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // the group has already exited
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      // Escalate if anything in the group ignores SIGTERM.
      setTimeout(() => killGroup('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        killGroup('SIGKILL');
        reject(new Error(`${basename(scriptPath)} did not finish within ${timeoutMs / 1000}s and was stopped`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${basename(scriptPath)} failed (${signal ?? `exit code ${code}`})`));
      }
    });
  });
}
