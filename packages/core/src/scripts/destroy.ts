// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadProductionEnv } from './ensure-secrets.js';
import { trackCommand } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { type DeploymentTargetOptions, environmentAccessKeys, resolveDeploymentTarget } from './deployment-target.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { createCdkOutput } from './cdk-output.js';
import { log } from './log.js';
import { runCapture, runSync } from './run-command.js';
import { REUSE_FRONTEND_BUILD_CONTEXT } from '../common/frontend-build.js';
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
   * The production stack the caller expects to delete, for example `<stackId>-prod`.
   * When set, a stack that does not exist in the target account and Region is
   * reported as "nothing to delete" instead of running `cdk destroy`, which
   * treats a missing stack as a successful no-op.
   */
  stackName?: string;
  /** How the user runs the destroy, in the guidance (for example `cdk-blocks destroy`). Default: `npm run destroy`. */
  invocation?: string;
  /**
   * Delete without asking, even on a terminal. Without it, `destroy` asks for
   * confirmation, listing the stacks, when stdin and stderr are both terminals
   * and the app has more than one top-level stack; every other run deletes
   * without asking. `cdk-blocks destroy --yes` sets it.
   */
  force?: boolean;
}

/** The slice of a CloudFormation client that {@link stackExists} needs. */
export interface DescribeStacksClient {
  send(command: unknown): Promise<unknown>;
}

/**
 * Whether CloudFormation has a stack named `stackName`: `false` only for the
 * `ValidationError` "Stack with id … does not exist"; `undefined` when the
 * request fails otherwise (for example AccessDenied), so the caller goes on and
 * `cdk destroy` reports any real error.
 */
export async function stackExists(
  cfn: DescribeStacksClient,
  describeStacks: (stackName: string) => unknown,
  stackName: string,
): Promise<boolean | undefined> {
  try {
    await cfn.send(describeStacks(stackName));
    return true;
  } catch (error) {
    const { name, message } = error instanceof Error ? error : { name: '', message: String(error) };
    return name === 'ValidationError' && /does not exist/.test(message) ? false : undefined;
  }
}

export interface DeployedStackOptions extends DeploymentTargetOptions {
  stackName: string;
  /** The Region to look in. Default: the Region CDK deploys to. */
  region?: string;
}

/**
 * Whether CloudFormation has the stack, looked up with the credentials and Region
 * CDK deploys with (see `assertAwsCredentials`): CDK uses environment access keys
 * before AWS_PROFILE, and SDK clients do not read `cdk.json`. `false` only when the
 * stack does not exist; `undefined` without a Region, or when the lookup fails
 * otherwise (no credentials, AccessDenied, no network).
 */
export async function deployedStackExists(options: DeployedStackOptions): Promise<boolean | undefined> {
  const target = await resolveDeploymentTarget(options);
  const region = options.region ?? target.region;
  if (!region) return undefined;
  // Loaded only when a lookup runs, like the other SDK clients of the scripts.
  const { CloudFormationClient, DescribeStacksCommand } = await import('@aws-sdk/client-cloudformation');
  const credentials = target.profile ? undefined : environmentAccessKeys(options.env);
  // SDK clients read AWS_PROFILE from process.env, not from `options.env`.
  const profile = target.profile ?? (credentials ? undefined : options.env?.AWS_PROFILE || undefined);
  const cfn = new CloudFormationClient({
    region,
    profile,
    ...(credentials ? { credentials } : {}),
    maxAttempts: 2,
  });
  try {
    return await stackExists(cfn, (StackName) => new DescribeStacksCommand({ StackName }), options.stackName);
  } finally {
    cfn.destroy();
  }
}

/**
 * The stacks in `cdk ls` output: lines that are a stack id, optionally followed
 * by `(name)`. Synthesizing the app also prints to stdout (a Hosting frontend
 * build, CDK notices), and those lines are not stacks.
 * @internal
 */
export function cdkListedStacks(out: string): string[] {
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z][\w/-]*( \([^()]*\))?$/.test(line));
}

/**
 * CDK context every synth of a destroy passes: a destroy doesn't deploy the
 * frontend, so `Hosting` reuses an existing frontend build instead of running
 * `buildCommand` and the framework build (see common/frontend-build.ts).
 */
export const DESTROY_SYNTH_CONTEXT: readonly string[] = ['--context', `${REUSE_FRONTEND_BUILD_CONTEXT}=true`];

/**
 * Where `destroy` has CDK write the assembly it synthesizes (`--output`),
 * relative to the project root. The retry reads the stack list from it. Not
 * the directory `sandbox:destroy` uses, so the two can run at the same time.
 */
/**
 * Refuse to destroy when the CDK app does not define `stackName`. `cdk destroy`
 * acts on the stacks the app defines, not on the name the caller printed and
 * confirmed, so an app whose `index.cdk.ts` names its stack differently (an app
 * created before `.blocks/config.json`, or a stackId that does not match) would
 * delete another stack than the one named. `cdk ls` prints a stack as its
 * construct id, followed by `(name)` when the stack name differs.
 */
function assertAppDefinesStack(options: DestroyOptions, stackName: string, cdkEnv: NodeJS.ProcessEnv): void {
  let out: string;
  try {
    // runCapture (cross-platform, captures stderr) as listProductionStackNames uses.
    out = runCapture('npx', ['cdk', 'ls', '--context', `projectRoot=${options.projectRoot}`, ...DESTROY_SYNTH_CONTEXT], {
      cwd: options.projectRoot,
      env: cdkEnv,
    });
  } catch (e) {
    const stderr = e instanceof Error && 'stderr' in e ? String(e.stderr ?? '') : '';
    const detail = stderr || (e instanceof Error ? e.message : String(e));
    throw new Error(`Could not list the stacks of the CDK app with 'cdk ls', so nothing was deleted: ${detail}`);
  }
  const stacks = cdkListedStacks(out);
  if (stacks.some((s) => s === stackName || s.endsWith(` (${stackName})`))) return;
  throw new Error(
    `The CDK app (aws-blocks/index.cdk.ts) defines ${stacks.length > 0 ? stacks.join(', ') : 'no stack'}, ` +
      `not ${stackName}, the production stack that .blocks/config.json names; nothing was deleted. ` +
      `Set "stackId" in .blocks/config.json so that <stackId>-prod is the app's production stack, ` +
      `or name the stack in index.cdk.ts with getStackName().`,
  );
}

const DESTROY_ASSEMBLY_DIR = '.blocks-sandbox/destroy.out';

/**
 * Production teardown behind `npm run destroy`: `cdk destroy --all --force`,
 * which deletes every top-level stack of the app (the stacks `npm run deploy`
 * creates; not stacks inside a CDK `Stage`), dependent stacks first.
 * Resources with a `RETAIN` removal policy are kept. When stdin and stderr
 * are both terminals and the app has more than one top-level stack, it lists
 * them on stderr and asks before deleting; a "no" deletes nothing and sets
 * the exit code to 1, so `npm run destroy && ...` stops there. Pass
 * `force: true` (`cdk-blocks destroy --yes`) to skip the question. Runs
 * without a terminal on stdin or stderr (CI, `< /dev/null`, `2> log`,
 * `2>&1 | tee log`) and single-stack apps never ask; redirecting only stdout
 * (`> log`, `| tee log`) still asks on the terminal.
 * Retries transient teardown failures (see {@link runDestroyWithRetries});
 * before a retry it empties only the S3 buckets the delete removes and would
 * empty itself (`autoDeleteObjects`), never one the stack keeps (see
 * `listStackBucketNames` in ./sandbox.ts), reading the
 * stacks, with their Regions, from the assembly the attempt synthesized, and
 * stops early when the Lambda@Edge stack can't be deleted yet.
 */
export async function destroy(options: DestroyOptions) {
  return trackCommand('destroy', async () => {
    log.progress('🗑️  Destroying production stacks...');

    // The same environment as the production deploy: `.env.production` can set
    // AWS_PROFILE and AWS_REGION (an exported variable wins), so without it the
    // destroy could target other credentials or another Region than the deploy.
    loadProductionEnv();
    process.env.BLOCKS_STAGE = 'production';

    // Fail fast on a missing/expired credential BEFORE entering the retry loop:
    // a credential error is deterministic, so retrying it only burns the full
    // [60s, 120s] backoff (the Telemetry E2E timeout this guards against). The
    // retry loop is for transient teardown blockers (bucket-blocked delete,
    // DeleteRestApi 429 throttle, ENI detach), never auth.
    await assertAwsCredentials({
      command: 'destroy',
      invocation: options.invocation,
      projectRoot: options.projectRoot,
      accountDetails: false,
    });

    const cdkEnv = {
      ...process.env,
      NODE_OPTIONS: '--conditions=cdk',
      ...getCdkTelemetryEnv('production'),
    };

    if (options.stackName) {
      assertAppDefinesStack(options, options.stackName, cdkEnv);
      if ((await deployedStackExists({ projectRoot: options.projectRoot, stackName: options.stackName })) === false) {
        const { region } = await resolveDeploymentTarget({ projectRoot: options.projectRoot });
        console.log(`\nℹ️  There is no stack ${options.stackName} in Region ${region}; nothing to delete.`);
        return;
      }
    }
    const clients = await destroyRetryClients(options.projectRoot);
    if ((await runProductionDestroy(options, cdkEnv, clients, terminalPrompt())) === 'cancelled') {
      process.exitCode = 1;
    }
  });
}

/** How {@link runProductionDestroy} asks before a multi-stack destroy; injectable for tests. */
export interface DestroyPrompt {
  /** Whether someone at a terminal can see the question and answer it. */
  isTTY: boolean;
  /** Ask a yes/no question; resolves true for yes. */
  ask: (question: string) => Promise<boolean>;
}

/**
 * The body of {@link destroy} after the credential check: clears the assembly
 * directory, asks for confirmation when it should (see below), runs the
 * retrying `cdk destroy --all --force`, and removes the directory after a
 * successful destroy. Resolves `'cancelled'` when the question was answered
 * no (nothing was deleted), else `'destroyed'`; a failed destroy rejects.
 * `retryOverrides` replaces retry dependencies in tests (e.g. `sleep`).
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
): Promise<'destroyed' | 'cancelled'> {
  // The destroy synthesizes into this directory; the retry reads the stacks
  // it selected from there. Cleared first so a failed synth can't leave an
  // earlier run's stack list behind, and removed after a successful destroy.
  const assemblyDir = join(options.projectRoot, DESTROY_ASSEMBLY_DIR);
  rmSync(assemblyDir, { recursive: true, force: true });
  let fromAssembly = false;
  if (prompt.isTTY && !options.force) {
    runSync(
      'npx',
      [
        'cdk', 'synth', '--quiet', '--output', DESTROY_ASSEMBLY_DIR,
        '--context', `projectRoot=${options.projectRoot}`,
        ...DESTROY_SYNTH_CONTEXT,
      ],
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
      return 'cancelled';
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
  return 'destroyed';
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

/** The streams {@link terminalPrompt} asks on; `isTTY` is set when the stream is a terminal. */
export interface PromptStreams {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
}

/**
 * The {@link DestroyPrompt} `destroy` uses: it asks on stderr and reads the
 * answer from stdin, and can ask only when both are terminals. stderr rather
 * than stdout, so `npm run destroy > destroy.log` (or `| tee`) still shows the
 * question on the terminal instead of writing it into the file; and both must
 * be terminals, so `2>&1 | tee destroy.log` doesn't wait for an answer to a
 * question no one sees. With the output on a terminal, readline also puts the
 * terminal in raw mode, which is what turns Ctrl-C into a "no".
 */
export function terminalPrompt(streams: PromptStreams = { input: process.stdin, output: process.stderr }): DestroyPrompt {
  return {
    isTTY: streams.input.isTTY === true && streams.output.isTTY === true,
    ask: (question) => askYesNo(question, streams),
  };
}

/**
 * Ask a yes/no question on `output`, reading the answer from `input`. Anything
 * but yes is no, and so is Ctrl-C or Ctrl-D (readline rejects with ABORT_ERR,
 * or closes before an answer), so the caller's "cancelled" path runs instead
 * of a raw error.
 */
async function askYesNo(question: string, { input, output }: PromptStreams): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input, output });
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
    ...DESTROY_SYNTH_CONTEXT,
    // With `fromAssembly`, `--app` and `--output` name the same directory on
    // purpose: an `--app` that is a cloud assembly is read as-is and not
    // synthesized, so every attempt, retries included, deletes the stacks the
    // confirmation listed rather than a fresh synth of the app.
    ...(fromAssembly ? ['--app', DESTROY_ASSEMBLY_DIR] : []),
  ];
  // At BLOCKS_LOG_LEVEL=quiet|normal the CDK stream is condensed and retained;
  // the retry loop prints it once the destroy finally fails.
  const cdkOutput = createCdkOutput({ label: 'cdk destroy', verb: 'destroy' });
  return {
    runDestroy: () => cdkOutput.run('npx', cdkArgs, { cwd: options.projectRoot, env: cdkEnv }),
    printRetainedOutput: () => cdkOutput.printRetained(),
    listStacks: () => listDestroyedStacks(join(options.projectRoot, DESTROY_ASSEMBLY_DIR)),
    emptyBuckets: (stacks) => emptySandboxBuckets(stacks, clients),
    isThrottled: (stacks, since, previous) => destroyWasThrottled(stacks, since, previous, clients.cfnFor),
    edgeReplicaBlocked: (stacks, since) => edgeStacksBlockedByReplicas(stacks, since, clients.cfnFor),
    rerunCommand: options.invocation ?? 'npm run destroy',
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    successLabel: 'Production stacks',
  };
}
