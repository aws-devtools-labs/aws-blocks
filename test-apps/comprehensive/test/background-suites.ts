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
 * A new suite belongs here only if it shares no server-side state that a test
 * asserts on with the suites in e2e.test.ts or with the other background
 * suites: no fixed keys another suite writes, no scan of a store or table
 * another suite writes to without a prefix filter, no global purge.
 *
 * The extra load also changes which Lambda instance serves each of the
 * parent's requests. A parent suite whose flow relies on state one instance
 * keeps in memory between requests must run before the background suites
 * start (AuthOIDC's stub IdP refresh tokens, see e2e.test.ts and
 * https://github.com/aws-devtools-labs/aws-blocks/issues/988).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { dirname, join } from 'node:path';

/** Suites run-background-suite.ts can run; each maps to one `*Tests` registrar there. */
export type BackgroundSuiteName = 'agent' | 'async-job' | 'async-job-status';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultEntry = join(__dirname, 'run-background-suite.ts');

/**
 * Upper bound for one background suite, measured from its start. The Agent
 * suite, the slowest, takes about 3 minutes deployed; this only stops a hung
 * child from holding the job (and the stack teardown after it) for the full
 * job timeout.
 */
const SUITE_BUDGET_MS = 20 * 60_000;

export interface BackgroundSuite<Name extends string = BackgroundSuiteName> {
  readonly name: Name;
  /**
   * Resolves when the child exits 0; rejects on any failure, hang or spawn
   * error. Starts the child first if start() has not (for example when a
   * --test-name-pattern filtered the start test out).
   */
  done(): Promise<void>;
}

export interface BackgroundSuites<Name extends string = BackgroundSuiteName> {
  readonly suites: readonly BackgroundSuite<Name>[];
  /** Spawn every child not yet started. Call after the server is ready. */
  start(): void;
  /**
   * Resolves once every child started so far has exited, whatever its result.
   * Await it before stopping the server or destroying the stack: a
   * --test-name-pattern can run the start test but filter out the
   * `Background suite - *` tests, and then nothing else waits for the children.
   */
  settle(): Promise<void>;
}

export interface BackgroundSuitesOptions {
  /** Script each child runs with the suite name as its argument. Defaults to run-background-suite.ts. */
  readonly entry?: string;
  /** Where the children's prefixed output lines go. Defaults to this process's stdout and stderr. */
  readonly output?: { stdout: (line: string) => void; stderr: (line: string) => void };
}

/** How many of a child's failing test names a failed suite's error repeats. */
const MAX_FAILING_TESTS = 10;

/**
 * node:test flags that pick the only tests to run. A child inheriting the
 * parent's filter would run none of its own tests and pass; its
 * `Background suite - *` test stands for the whole suite, so the child runs
 * all of it. (--test-skip-pattern is passed on: it only skips the matching
 * tests, which is what whoever set it wants in the children too.)
 */
const TEST_FILTER_FLAGS = ['--test-name-pattern', '--test-only'];

/**
 * Inspector flags: three children would fight over the debug port (and with
 * --inspect-brk wait for a debugger forever). Of these --inspect-port,
 * --debug-port and --inspect-publish-uid can take their value as a separate
 * argument.
 */
const isInspectorFlag = (flag: string): boolean => flag.startsWith('--inspect') || flag.startsWith('--debug-port');
const INSPECTOR_FLAGS_WITH_VALUE = ['--inspect-port', '--debug-port', '--inspect-publish-uid'];

/**
 * `flags` without the test filters and the inspector flags, and without the
 * value of a separate-value form (`--test-name-pattern <value>`,
 * `--inspect-port <port>`). A flag is matched without the double quotes
 * NODE_OPTIONS may wrap it in, and with `_` in its name read as `-` (node
 * accepts both spellings).
 */
function withoutChildUnsafeFlags(flags: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const unquoted = flags[i].replace(/"/g, '');
    const eq = unquoted.indexOf('=');
    const flag = unquoted.startsWith('--')
      ? (eq < 0 ? unquoted : unquoted.slice(0, eq)).replace(/_/g, '-') + (eq < 0 ? '' : unquoted.slice(eq))
      : unquoted;
    const filter = TEST_FILTER_FLAGS.find((f) => flag === f || flag.startsWith(`${f}=`));
    if (filter) {
      if (flag === filter && filter !== '--test-only') i++;
    } else if (isInspectorFlag(flag)) {
      if (INSPECTOR_FLAGS_WITH_VALUE.includes(flag)) i++;
    } else kept.push(flags[i]);
  }
  return kept;
}

/** This process's flags minus the test filters and the inspector flags. */
function childExecArgv(): string[] {
  return withoutChildUnsafeFlags(process.execArgv);
}

/**
 * The child's stdout is a pipe, so node:test would pick TAP. Ask for spec,
 * unless a reporter is already set (CI sets one in NODE_OPTIONS, which the
 * child inherits): a second `--test-reporter` makes node:test exit on startup.
 */
function reporterArgs(): string[] {
  const flags = [...process.execArgv, ...nodeOptionsTokens(process.env.NODE_OPTIONS ?? '')];
  return flags.some((flag) => flag.replace(/"/g, '').startsWith('--test-reporter')) ? [] : ['--test-reporter=spec'];
}

/**
 * NODE_OPTIONS split the way node splits it: on spaces outside double quotes.
 * Each token keeps its quotes, so joining them back gives node the same flags.
 */
function nodeOptionsTokens(options: string): string[] {
  return options.match(/(?:[^ "]+|"(?:\\.|[^"\\])*")+/g) ?? [];
}

/**
 * This process's environment minus NODE_TEST_CONTEXT (node --test sets it in
 * each test file's process; a child inheriting it would report to that runner
 * in its internal protocol instead of printing results to its own stdout) and
 * minus any test filter or inspector flag in NODE_OPTIONS (see childExecArgv).
 */
function childEnv(): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _runnerContext, ...env } = process.env;
  if (env.NODE_OPTIONS) {
    env.NODE_OPTIONS = withoutChildUnsafeFlags(nodeOptionsTokens(env.NODE_OPTIONS)).join(' ');
  }
  return env;
}

/**
 * Children still running, across every backgroundSuites() call. A child
 * outliving this process (a crash, the open-handle backstop in e2e.test.ts)
 * would keep calling a server or stack that is going away.
 */
const live = new Set<ChildProcess>();
process.once('exit', () => {
  for (const child of live) child.kill('SIGKILL');
});

/** The suites run-background-suite.ts knows, with their children's output on this process's own streams. */
export function backgroundSuites(names: readonly BackgroundSuiteName[]): BackgroundSuites;
/** Any suite names, run by another entry script (tests of this runner). */
export function backgroundSuites<Name extends string>(
  names: readonly Name[],
  options: BackgroundSuitesOptions & { readonly entry: string },
): BackgroundSuites<Name>;
export function backgroundSuites<Name extends string>(
  names: readonly Name[],
  { entry = defaultEntry, output }: BackgroundSuitesOptions = {},
): BackgroundSuites<Name> {
  const results = new Map<Name, Promise<void>>();
  const writeOut = output?.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeErr = output?.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  const run = (name: Name): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const prefix = `[${name}] `;
      // Same node binary and loader flags as this process (tsx, -C browser), so
      // `import 'aws-blocks'` resolves to the same generated client.
      const child = spawn(
        process.execPath,
        [...childExecArgv(), ...reporterArgs(), entry, name],
        { cwd: process.cwd(), env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      live.add(child);
      // The spec reporter ends a failed run with a `failing tests:` block; keep
      // the test names from it so this suite's error in the parent's own
      // summary names them, not only the prefixed lines somewhere above
      // (U+2716 is the reporter's failure mark).
      const failingTests: string[] = [];
      let inFailingBlock = false;
      createInterface({ input: child.stdout }).on('line', (line) => {
        writeOut(`${prefix}${line}`);
        const trimmed = stripVTControlCharacters(line).trim();
        if (trimmed.endsWith('failing tests:')) inFailingBlock = true;
        else if (inFailingBlock && trimmed.startsWith('\u2716') && failingTests.length < MAX_FAILING_TESTS) {
          failingTests.push(trimmed);
        }
      });
      createInterface({ input: child.stderr }).on('line', (line) => writeErr(`${prefix}${line}`));

      const timer = globalThis.setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Background suite "${name}" did not finish within ${SUITE_BUDGET_MS / 60_000} min; killed it. Its output is in the ${prefix.trim()} lines above.`));
      }, SUITE_BUDGET_MS);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Background suite "${name}" could not start: ${err.message}`));
      });
      child.on('close', (code, signal) => {
        live.delete(child);
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          const failed = failingTests.length > 0 ? `: ${failingTests.join('; ')}` : '';
          reject(new Error(`Background suite "${name}" failed (exit ${code ?? signal})${failed}. Its results are in the ${prefix.trim()} lines above.`));
        }
      });
    });

  const ensureStarted = (name: Name): Promise<void> => {
    let result = results.get(name);
    if (!result) {
      result = run(name);
      // Observed by done(); keep an early failure from surfacing as an
      // unhandled rejection before the suite's own test awaits it.
      result.catch(() => {});
      results.set(name, result);
    }
    return result;
  };

  return {
    suites: names.map((name) => ({ name, done: () => ensureStarted(name) })),
    start() {
      for (const name of names) ensureStarted(name);
    },
    async settle() {
      await Promise.allSettled(results.values());
    },
  };
}
