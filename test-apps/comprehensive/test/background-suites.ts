// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Background suites: the slow, mostly-waiting e2e suites run in child
 * processes while the rest of e2e.test.ts runs, all against the one server or
 * stack that e2e.test.ts started or deployed.
 *
 * Agent, AsyncJob and AsyncJob status take most of the deployed e2e test time,
 * nearly all of it spent polling queues, Lambda and the model. Each suite still
 * runs its own tests one at a time, exactly as before; only the suites overlap.
 *
 * Why a child process per suite and not node:test `concurrency`: this process
 * holds state every suite shares and some suites change: the cookie jar on
 * global.fetch (the Agent suite signs users in and out), the realtime client's
 * pooled WebSocket (the Agent suite force-closes it to test reconnects) and
 * fetch spies. A child process gets its own copy of all three. Server-side
 * state the suites share is kept apart with per-suite keys and resources
 * instead (see the AppSetting and delivered-code notes in aws-blocks/index.ts).
 *
 * A new suite belongs here only if it shares no server-side state with the
 * suites in e2e.test.ts that a test asserts on: no fixed keys another suite
 * writes, no scan of a store or table another suite writes to without a prefix
 * filter, no global purge.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Suites run-background-suite.ts can run; each maps to one `*Tests` registrar there. */
export type BackgroundSuiteName = 'agent' | 'async-job' | 'async-job-status';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, 'run-background-suite.ts');

/**
 * Upper bound for one background suite, measured from its start. The Agent
 * suite, the slowest, takes about 3 minutes deployed; this only stops a hung
 * child from holding the job (and the stack teardown after it) for the full
 * job timeout.
 */
const SUITE_BUDGET_MS = 20 * 60_000;

export interface BackgroundSuite {
  readonly name: BackgroundSuiteName;
  /** Resolves when the child exits 0; rejects on any failure, hang or spawn error. */
  done(): Promise<void>;
}

export interface BackgroundSuites {
  readonly suites: readonly BackgroundSuite[];
  /** Spawn every child. Call once, after the server is ready. */
  start(): void;
}

export function backgroundSuites(names: readonly BackgroundSuiteName[]): BackgroundSuites {
  const results = new Map<BackgroundSuiteName, Promise<void>>();

  const run = (name: BackgroundSuiteName): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const prefix = `[${name}] `;
      // Same node binary and loader flags as this process (tsx, -C browser), so
      // `import 'aws-blocks'` resolves to the same generated client. The spec
      // reporter is explicit because stdout is a pipe, which would select TAP.
      const child = spawn(
        process.execPath,
        [...process.execArgv, '--test-reporter=spec', entry, name],
        { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      createInterface({ input: child.stdout }).on('line', (line) => process.stdout.write(`${prefix}${line}\n`));
      createInterface({ input: child.stderr }).on('line', (line) => process.stderr.write(`${prefix}${line}\n`));

      const timer = globalThis.setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Background suite "${name}" did not finish within ${SUITE_BUDGET_MS / 60_000} min; killed it. Its output is in the ${prefix.trim()} lines above.`));
      }, SUITE_BUDGET_MS);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Background suite "${name}" could not start: ${err.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Background suite "${name}" failed (exit ${code ?? signal}). Its results are in the ${prefix.trim()} lines above.`));
      });
    });

  return {
    suites: names.map((name) => ({
      name,
      done: () => results.get(name) ?? Promise.reject(new Error(`Background suite "${name}" was never started`)),
    })),
    start() {
      for (const name of names) {
        if (results.has(name)) continue;
        const result = run(name);
        // Observed by done(); keep an early failure from surfacing as an
        // unhandled rejection before the suite's own test awaits it.
        result.catch(() => {});
        results.set(name, result);
      }
    },
  };
}
