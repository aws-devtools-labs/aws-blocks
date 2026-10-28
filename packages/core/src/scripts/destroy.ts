// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { trackCommand } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { runSync } from './run-command.js';
import {
  type DestroyRetryDeps,
  destroyRetryClients,
  destroyWasThrottled,
  edgeStacksBlockedByReplicas,
  type EmptyBucketsClients,
  emptySandboxBuckets,
  listDestroyedStacks,
  runDestroyWithRetries,
  topLevelStacks,
} from './sandbox.js';

export interface DestroyOptions {
  cdkAppPath: string;
  projectRoot: string;
  /**
   * Delete without asking, even on a terminal. Without it, `destroy` asks for
   * confirmation, listing the stacks, when stdin is a terminal and the app has
   * more than one top-level stack; every other run deletes without asking.
   * The template scripts set it from `npm run destroy -- --force`.
   */
  force?: boolean;
}

/**
 * Where `destroy` has CDK write the assembly it synthesizes (`--output`),
 * relative to the project root. The retry reads the stack list from it. Not
 * the directory `sandbox:destroy` uses, so the two can run at the same time.
 */
const DESTROY_ASSEMBLY_DIR = '.blocks-sandbox/destroy.out';

/**
 * Production teardown behind `npm run destroy`: `cdk destroy --all --force`,
 * which deletes every top-level stack of the app (the stacks `npm run deploy`
 * creates; not stacks inside a CDK `Stage`), dependent stacks first.
 * Resources with a `RETAIN` removal policy are kept. When stdin is a terminal
 * and the app has more than one top-level stack, it lists them and asks
 * before deleting (a "no" deletes nothing); pass `force: true`
 * (`npm run destroy -- --force`) to skip the question. Runs without a
 * terminal (CI, piped, scripts) and single-stack apps never ask.
 * Retries transient teardown failures (see {@link runDestroyWithRetries});
 * before a retry it empties only the S3 buckets the delete removes, never one
 * the stack keeps (see `listStackBucketNames` in ./sandbox.ts), reading the
 * stacks, with their Regions, from the assembly the attempt synthesized, and
 * stops early when the Lambda@Edge stack can't be deleted yet.
 */
export async function destroy(options: DestroyOptions) {
  return trackCommand('destroy', async () => {
    console.log('🗑️  Destroying production stacks...');

    // Fail fast on a missing/expired credential BEFORE entering the retry loop:
    // a credential error is deterministic, so retrying it only burns the full
    // [60s, 120s] backoff (the Telemetry E2E timeout this guards against). The
    // retry loop is for transient teardown blockers (bucket-blocked delete,
    // DeleteRestApi 429 throttle, ENI detach), never auth.
    await assertAwsCredentials({ command: 'destroy', projectRoot: options.projectRoot, accountDetails: false });

    const cdkEnv = {
      ...process.env,
      NODE_OPTIONS: '--conditions=cdk',
      ...getCdkTelemetryEnv('production'),
    };
    const clients = await destroyRetryClients(options.projectRoot);
    await runProductionDestroy(options, cdkEnv, clients, { isTTY: process.stdin.isTTY === true, ask: askYesNo });
  });
}

/** How {@link runProductionDestroy} asks before a multi-stack destroy; injectable for tests. */
export interface DestroyPrompt {
  /** Whether stdin is a terminal (someone can answer). */
  isTTY: boolean;
  /** Ask a yes/no question; resolves true for yes. */
  ask: (question: string) => Promise<boolean>;
}

/**
 * The body of {@link destroy} after the credential check: clears the assembly
 * directory, asks for confirmation when it should (see below), runs the
 * retrying `cdk destroy --all --force`, and removes the directory after a
 * successful destroy. `retryOverrides` replaces retry dependencies in tests
 * (e.g. `sleep`).
 *
 * When `prompt.isTTY` and not `options.force`, it first synthesizes the app
 * into the assembly directory (`cdk synth --output`) to count its top-level
 * stacks (the set `--all` deletes), and the destroy then deletes from that
 * same assembly (`--app <dir>`), so the app is built once and the stacks
 * deleted are the stacks listed. With more than one stack, or when the stacks
 * can't be read, it asks; a "no" (or Ctrl-C / Ctrl-D) deletes nothing and
 * returns without retrying. The question is asked here rather than by CDK's
 * own prompt (`cdk destroy` without `--force`) because CDK exits 1 on "no",
 * the same as a failed delete, and the retry loop would empty buckets and try
 * again. Every `cdk destroy` attempt passes `--force`, so a confirmed destroy
 * is never asked twice.
 */
export async function runProductionDestroy(
  options: DestroyOptions,
  cdkEnv: NodeJS.ProcessEnv,
  clients: Required<EmptyBucketsClients>,
  prompt: DestroyPrompt,
  retryOverrides: Partial<DestroyRetryDeps> = {},
): Promise<void> {
  // The destroy synthesizes into this directory; the retry reads the stacks
  // it selected from there. Cleared first so a failed synth can't leave an
  // earlier run's stack list behind, and removed after a successful destroy.
  const assemblyDir = join(options.projectRoot, DESTROY_ASSEMBLY_DIR);
  rmSync(assemblyDir, { recursive: true, force: true });
  let fromAssembly = false;
  if (prompt.isTTY && !options.force) {
    runSync(
      'npx',
      ['cdk', 'synth', '--quiet', '--output', DESTROY_ASSEMBLY_DIR, '--context', `projectRoot=${options.projectRoot}`],
      { stdio: 'inherit', cwd: options.projectRoot, env: cdkEnv },
    );
    // Fail closed: no readable stack list (an unreadable manifest, an `app`
    // that writes elsewhere) asks too. Only a known single stack skips it.
    const stacks = topLevelStacks(assemblyDir);
    // Delete from the listed assembly only when it could be read; otherwise
    // the destroy synthesizes the app itself, as without a terminal.
    fromAssembly = stacks.length > 0;
    if (stacks.length !== 1 && !(await prompt.ask(confirmQuestion(stacks)))) {
      rmSync(assemblyDir, { recursive: true, force: true });
      console.log('\nDestroy cancelled. No stack was deleted.');
      return;
    }
  }
  // Reuse the sandbox path's shipped teardown-retry machinery: on a failed
  // destroy, empty the stacks' versioned S3 buckets (the autoDeleteObjects
  // Lambda never provisions on a failed CREATE, so the bucket blocks the
  // delete and the stack + its IAM roles leak) and back off before retrying.
  // The backoff also rides out a transient API Gateway control-plane throttle
  // (DeleteRestApi 429), which single-shot `cdk destroy` surfaced as a hard
  // teardown failure with no recovery. A failure whose stack events show such
  // a throttle gets a longer, jittered backoff (see runDestroyWithRetries).
  await runDestroyWithRetries({ ...productionDestroyDeps(options, cdkEnv, clients, { fromAssembly }), ...retryOverrides });
  rmSync(assemblyDir, { recursive: true, force: true });
}

/** The question asked before deleting several stacks (or stacks it could not list). */
function confirmQuestion(stacks: Array<{ stackName: string; region?: string }>): string {
  if (stacks.length === 0) {
    return '\nCould not list the stacks of this app. Delete every top-level stack of the app? (y/N) ';
  }
  const list = stacks.map(({ stackName, region }) => `  - ${stackName}${region ? ` (${region})` : ''}`).join('\n');
  return (
    `\nThis deletes these ${stacks.length} stacks, and every resource in them whose removal policy does not ` +
    `keep it:\n${list}\nDelete them? (y/N) `
  );
}

/** Whether a typed answer is yes: `y` or `yes`, any case. Everything else is no. */
export function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * Ask a yes/no question on the terminal. Anything but yes is no, and so is
 * Ctrl-C or Ctrl-D (readline rejects with ABORT_ERR, or closes before an
 * answer), so the caller's "cancelled" path runs instead of a raw error.
 */
async function askYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await Promise.race([rl.question(question), once(rl, 'close').then(() => '')]);
    return isYes(answer);
  } catch (e) {
    if ((e as { code?: string }).code === 'ABORT_ERR') return false;
    throw e;
  } finally {
    rl.close();
  }
}

/**
 * The {@link runDestroyWithRetries} dependencies the production `destroy`
 * runs with. A separate function so a test can pin the wiring (throttle
 * detection, bucket emptying, the Lambda@Edge stop) without spawning cdk.
 * `clients` are the AWS clients the retry uses (see `destroyRetryClients` in
 * ./sandbox.ts). With `fromAssembly`, the destroy deletes from the assembly
 * already synthesized into the assembly directory (`--app <dir>`) instead of
 * synthesizing the app again.
 */
export function productionDestroyDeps(
  options: DestroyOptions,
  cdkEnv: NodeJS.ProcessEnv,
  clients: Required<EmptyBucketsClients>,
  { fromAssembly = false }: { fromAssembly?: boolean } = {},
): DestroyRetryDeps {
  const cdkArgs = [
    'cdk', 'destroy',
    // `--all`, like the deploy (see buildCdkDeployArgs): without it CDK
    // refuses an app with more than one stack, so the destroy could never
    // succeed. It deletes every top-level stack of the app, dependent
    // stacks first; a stack deployed from this app by hand is included.
    '--all',
    '--force',
    '--output', DESTROY_ASSEMBLY_DIR,
    '--context', `projectRoot=${options.projectRoot}`,
    // With `fromAssembly`, `--app` and `--output` name the same directory on
    // purpose: an `--app` that is a cloud assembly is read as-is and not
    // synthesized, so every attempt, retries included, deletes the stacks the
    // confirmation listed rather than a fresh synth of the app.
    ...(fromAssembly ? ['--app', DESTROY_ASSEMBLY_DIR] : []),
  ];
  return {
    runDestroy: () => runSync('npx', cdkArgs, { stdio: 'inherit', cwd: options.projectRoot, env: cdkEnv }),
    listStacks: () => listDestroyedStacks(join(options.projectRoot, DESTROY_ASSEMBLY_DIR)),
    emptyBuckets: (stacks) => emptySandboxBuckets(stacks, clients),
    isThrottled: (stacks, since, previous) => destroyWasThrottled(stacks, since, previous, clients.cfnFor),
    edgeReplicaBlocked: (stacks, since) => edgeStacksBlockedByReplicas(stacks, since, clients.cfnFor),
    rerunCommand: 'npm run destroy',
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    successLabel: 'Production stacks',
  };
}
