// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadProductionEnv } from './ensure-secrets.js';
import { trackCommand } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { environmentAccessKeys, resolveDeploymentTarget } from './deployment-target.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { createCdkOutput } from './cdk-output.js';
import { log } from './log.js';
import { runCapture } from './run-command.js';
import { type DestroyRetryDeps, destroyWasThrottled, emptySandboxBuckets, runDestroyWithRetries } from './sandbox.js';

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
  /** How the user runs the destroy, in the guidance (for example `blocks destroy`). Default: `npm run destroy`. */
  invocation?: string;
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

/**
 * Look up `stackName` with the credentials and Region CDK destroys with (see
 * `assertAwsCredentials`): CDK uses environment access keys before AWS_PROFILE,
 * and SDK clients do not read `cdk.json`. `undefined` without a Region.
 */
async function productionStackExists(projectRoot: string, stackName: string): Promise<boolean | undefined> {
  const { region, profile } = await resolveDeploymentTarget({ projectRoot });
  if (!region) return undefined;
  // Loaded only when a destroy runs, like the other SDK clients of the scripts.
  const { CloudFormationClient, DescribeStacksCommand } = await import('@aws-sdk/client-cloudformation');
  const credentials = profile ? undefined : environmentAccessKeys();
  const cfn = new CloudFormationClient({ region, profile, ...(credentials ? { credentials } : {}), maxAttempts: 2 });
  try {
    return await stackExists(cfn, (StackName) => new DescribeStacksCommand({ StackName }), stackName);
  } finally {
    cfn.destroy();
  }
}

/**
 * Resolve the production app's stack names via `cdk ls` (best-effort; [] on
 * error). Mirrors the sandbox resolver but without `sandboxMode` — it drives
 * the pre-retry bucket-emptying in {@link runDestroyWithRetries}, so a failure
 * here must WARN rather than stay silent: a silent [] skips bucket-emptying,
 * the exact no-op the retry exists to avoid.
 */
function listProductionStackNames(options: DestroyOptions, cdkEnv: NodeJS.ProcessEnv): string[] {
  try {
    const out = runCapture(
      'npx',
      ['cdk', 'ls', '--context', `projectRoot=${options.projectRoot}`],
      // runCapture captures stderr so a genuine synth/`cdk ls` failure is logged
      // below rather than being indistinguishable from "app has zero stacks".
      { cwd: options.projectRoot, env: cdkEnv },
    );
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    const detail = (e as { stderr?: string; message?: string }).stderr || (e as Error).message;
    log.warn(`  ⚠️  could not list production stacks via 'cdk ls'; skipping bucket-emptying: ${detail}`);
    return [];
  }
}

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
    out = runCapture('npx', ['cdk', 'ls', '--context', `projectRoot=${options.projectRoot}`], {
      cwd: options.projectRoot,
      env: cdkEnv,
    });
  } catch (e) {
    const stderr = e instanceof Error && 'stderr' in e ? String(e.stderr ?? '') : '';
    const detail = stderr || (e instanceof Error ? e.message : String(e));
    throw new Error(`Could not list the stacks of the CDK app with 'cdk ls', so nothing was deleted: ${detail}`);
  }
  const stacks = out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (stacks.some((s) => s === stackName || s.endsWith(` (${stackName})`))) return;
  throw new Error(
    `The CDK app (aws-blocks/index.cdk.ts) defines ${stacks.length > 0 ? stacks.join(', ') : 'no stack'}, ` +
      `not ${stackName}, the production stack that .blocks/config.json names; nothing was deleted. ` +
      `Set "stackId" in .blocks/config.json so that <stackId>-prod is the app's production stack, ` +
      `or name the stack in index.cdk.ts with getStackName().`,
  );
}

export async function destroy(options: DestroyOptions) {
  return trackCommand('destroy', async () => {
    log.progress('🗑️  Destroying production stack...');

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
      if ((await productionStackExists(options.projectRoot, options.stackName)) === false) {
        const { region } = await resolveDeploymentTarget({ projectRoot: options.projectRoot });
        console.log(`\nℹ️  There is no stack ${options.stackName} in Region ${region}; nothing to delete.`);
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
    await runDestroyWithRetries(productionDestroyDeps(options, cdkEnv));
  });
}

/**
 * The {@link runDestroyWithRetries} dependencies the production `destroy`
 * runs with. A separate function so a test can pin the wiring (throttle
 * detection, bucket emptying) without spawning cdk.
 */
export function productionDestroyDeps(options: DestroyOptions, cdkEnv: NodeJS.ProcessEnv): DestroyRetryDeps {
  const cdkArgs = [
    'cdk', 'destroy',
    '--force',
    '--context', `projectRoot=${options.projectRoot}`,
  ];
  // At BLOCKS_LOG_LEVEL=quiet|normal the CDK stream is condensed and retained;
  // the retry loop prints it once the destroy finally fails.
  const cdkOutput = createCdkOutput({ label: 'cdk destroy', verb: 'destroy' });
  return {
    runDestroy: () => cdkOutput.run('npx', cdkArgs, { cwd: options.projectRoot, env: cdkEnv }),
    printRetainedOutput: () => cdkOutput.printRetained(),
    listStacks: () => listProductionStackNames(options, cdkEnv).map((stackName) => ({ stackName })),
    emptyBuckets: emptySandboxBuckets,
    isThrottled: destroyWasThrottled,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    successLabel: 'Production stack',
  };
}
