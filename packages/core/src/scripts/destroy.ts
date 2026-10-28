// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { trackCommand } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { inspectDestroyAttempt } from './destroy-retained.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { runSync } from './run-command.js';
import { type DestroyRetryDeps, destroyWasThrottled, emptySandboxBuckets, runDestroyWithRetries } from './sandbox.js';

export interface DestroyOptions {
  cdkAppPath: string;
  projectRoot: string;
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
    const out = execFileSync(
      'npx',
      ['cdk', 'ls', '--context', `projectRoot=${options.projectRoot}`],
      // Capture stderr so a genuine synth/`cdk ls` failure is logged below
      // rather than being indistinguishable from "app has zero stacks".
      { cwd: options.projectRoot, env: cdkEnv, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    const detail = (e as { stderr?: string; message?: string }).stderr || (e as Error).message;
    console.warn(`  ⚠️  could not list production stacks via 'cdk ls'; skipping bucket-emptying: ${detail}`);
    return [];
  }
}

/**
 * The stack names in the cloud assembly `cdk destroy` synthesized into
 * `<projectRoot>/<cdk.json "output" ?? "cdk.out">`, or undefined when that
 * assembly is missing, unreadable, or older than `notBeforeMs` (so a stale
 * assembly from an earlier synth is never trusted). Reading it avoids running
 * the app a second time (`cdk ls` re-synthesizes, frontend build included).
 */
export function assemblyStackNames(projectRoot: string, notBeforeMs: number): string[] | undefined {
  try {
    let output = 'cdk.out';
    try {
      const cdkJson = JSON.parse(readFileSync(join(projectRoot, 'cdk.json'), 'utf-8')) as { output?: unknown };
      if (typeof cdkJson.output === 'string' && cdkJson.output) output = cdkJson.output;
    } catch {
      // No (readable) cdk.json: CDK's default output directory applies.
    }
    const manifestPath = join(resolve(projectRoot, output), 'manifest.json');
    // 1s slack for file systems with coarse mtime resolution.
    if (statSync(manifestPath).mtimeMs < notBeforeMs - 1_000) return undefined;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      artifacts?: Record<string, { type?: string; properties?: { stackName?: string } }>;
    };
    return Object.entries(manifest.artifacts ?? {})
      .filter(([, a]) => a.type === 'aws:cloudformation:stack')
      .map(([id, a]) => a.properties?.stackName ?? id);
  } catch {
    return undefined;
  }
}

export async function destroy(options: DestroyOptions) {
  return trackCommand('destroy', async () => {
    console.log('🗑️  Destroying production stack...');

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
    // Reuse the sandbox path's shipped teardown-retry machinery: on a failed
    // destroy, empty the stacks' versioned S3 buckets (the autoDeleteObjects
    // Lambda never provisions on a failed CREATE, so the bucket blocks the
    // delete and the stack + its IAM roles leak) and back off before retrying.
    // The backoff also rides out a transient API Gateway control-plane throttle
    // (DeleteRestApi 429), which single-shot `cdk destroy` surfaced as a hard
    // teardown failure with no recovery. A failure whose stack events show such
    // a throttle gets a longer, jittered backoff (see runDestroyWithRetries).
    // A failure caused by retained resources (e.g. a retained database still
    // using a subnet being deleted) stops at once instead, and a successful
    // destroy lists the resources it retained.
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
  // When the first `cdk destroy` started: its synth writes a fresh assembly,
  // which listStackNames prefers over a second synth via `cdk ls`.
  let destroyStartedAt: number | undefined;
  return {
    runDestroy: () => {
      destroyStartedAt ??= Date.now();
      runSync('npx', cdkArgs, { stdio: 'inherit', cwd: options.projectRoot, env: cdkEnv });
    },
    listStackNames: () =>
      (destroyStartedAt !== undefined ? assemblyStackNames(options.projectRoot, destroyStartedAt) : undefined) ??
      listProductionStackNames(options, cdkEnv),
    emptyBuckets: emptySandboxBuckets,
    isThrottled: destroyWasThrottled,
    // Stop at once on a failure caused by retained resources, and list what a
    // successful destroy retained (production retains stateful resources).
    inspectAttempt: inspectDestroyAttempt,
    reportRetained: true,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    successLabel: 'Production stack',
  };
}
