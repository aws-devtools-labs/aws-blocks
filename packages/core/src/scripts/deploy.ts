// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureSecrets, loadProductionEnv } from './ensure-secrets.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { applyExternalMigrations } from './external-migrations-step.js';
import { trackCommand } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { runStreaming, buildCdkDeployArgs, formatDeploySignal } from './deploy-stream.js';
import { waitForLiveBuild } from './wait-live.js';

export interface DeployOptions {
  cdkAppPath: string;
  projectRoot: string;
  /**
   * When true, after `cdk deploy` completes, block until the new frontend
   * build is actually being served through CloudFront before emitting
   * `BLOCKS_DEPLOYED`. Prevents a caller's immediate self-test
   * from hitting a stale bundle during edge propagation. No-op for a
   * backend-only app (no frontend to serve).
   */
  waitLive?: boolean;
  /** Overall budget for the liveness wait, in seconds. Defaults to 180. */
  waitLiveTimeoutSec?: number;
}

/** Default liveness-wait budget (seconds) when `--wait-live` is given without a value. */
export const DEFAULT_WAIT_LIVE_TIMEOUT_SEC = 180;
/** Poll interval for the liveness wait, in milliseconds. */
export const WAIT_LIVE_INTERVAL_MS = 5_000;

/**
 * Parse the `--wait-live` family of flags from a process argv tail. Pure and
 * exported so flag handling is unit-tested without spawning a deploy.
 *
 * Accepts `--wait-live` (opt in, default timeout) and
 * `--wait-live-timeout=<seconds>` (override the budget). An out-of-range or
 * non-numeric timeout falls back to the default rather than failing the deploy.
 */
export function parseWaitLiveArgs(argv: readonly string[]): {
  waitLive: boolean;
  waitLiveTimeoutSec: number;
} {
  const waitLive = argv.includes('--wait-live');
  let waitLiveTimeoutSec = DEFAULT_WAIT_LIVE_TIMEOUT_SEC;
  const timeoutArg = argv.find((a) => a.startsWith('--wait-live-timeout='));
  if (timeoutArg) {
    const raw = Number(timeoutArg.slice('--wait-live-timeout='.length));
    if (Number.isFinite(raw) && raw > 0 && raw <= 3600) {
      waitLiveTimeoutSec = Math.floor(raw);
    }
  }
  return { waitLive, waitLiveTimeoutSec };
}

// Re-exported from deploy-stream (the shared module) so existing importers of
// `./deploy.js` — including deploy.test.ts — keep resolving it here while
// sandbox() imports the same helper without pulling in deploy()'s dependency
// chain.
export { formatDeploySignal };

export async function deploy(options: DeployOptions) {
  return trackCommand('deploy', async () => {
    console.log('🏗️  Preparing deployment...');

    // Resolve the liveness-wait config: an explicit option wins; otherwise read
    // the `--wait-live` / `--wait-live-timeout=` flags from argv, so the thin
    // template wrapper (which just calls `deploy({...})`) needs no arg plumbing.
    const argvWaitLive = parseWaitLiveArgs(process.argv.slice(2));
    const waitLive = options.waitLive ?? argvWaitLive.waitLive;
    const waitLiveTimeoutSec = options.waitLiveTimeoutSec ?? argvWaitLive.waitLiveTimeoutSec;

    // Load production environment (from .env.production or CI env vars)
    loadProductionEnv();

    process.env.BLOCKS_STAGE = 'production';

    // Fail fast if AWS credentials are missing/expired, before generating the
    // client and spending time in synth only to hit an opaque CDK credential error.
    await assertAwsCredentials({ command: 'deploy', projectRoot: options.projectRoot });

    // Provision secrets for production. projectRoot must match the root cdk
    // synth uses (passed as --context below) so the written parameter name
    // equals the one the app resolves at synth.
    const secrets = await ensureSecrets('production', options.projectRoot);
    if (secrets.created.length > 0 || secrets.updated.length > 0) {
      console.log(`🔐 Secrets provisioned: ${[...secrets.created, ...secrets.updated].join(', ')}`);
    }

    // Apply external-database migrations to the production database before
    // deploying. No-op unless this app uses an external DB and has ./migrations.
    await applyExternalMigrations({ stage: 'production' });
    
    // Import backend to populate BB registry for telemetry
    const foundationPath = resolve(options.projectRoot, 'aws-blocks/index.ts');
    try {
      await import(pathToFileURL(foundationPath).href);
    } catch { /* ignore import errors */ }

    // Generate client code FIRST (before cdk deploy triggers the Vite build)
    const clientPath = join(dirname(foundationPath), 'client.js');
    console.log('📝 Generating client code...');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const workerPath = join(__dirname, 'generate-client-worker.js');
    execFileSync('node', ['--conditions=aws-runtime', '--import', 'tsx', workerPath, foundationPath, clientPath], {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    console.log('🚀 Deploying to AWS...');
    console.log('   (This may take a few minutes on first deploy)');
    console.log('   - Backend API (Lambda + API Gateway)');
    console.log('   - Frontend hosting (S3 + CloudFront)');
    console.log('   Streaming CloudFormation events below; the deploy keeps running if this');
    console.log('   process is backgrounded (press Ctrl-C, or send SIGTERM twice, to abort).');

    // Captured from the CDK progress stream the moment CloudFront's URL appears
    // — well before CREATE_COMPLETE and the post-run outputs.json read. Printing
    // it early means a deploy that is still converging, or gets killed at a
    // caller's timeout, has already surfaced where the frontend lives.
    let earlyHostingUrl: string | undefined;

    try {
      await runStreaming(
        "npx",
        buildCdkDeployArgs({
          projectRoot: options.projectRoot,
          outputsFile: '.blocks-sandbox/outputs.json',
        }),
        {
          label: 'cdk deploy',
          cwd: options.projectRoot,
          env: {
            ...process.env,
            NODE_OPTIONS: '--conditions=cdk',
            ...getCdkTelemetryEnv('production')
          },
          onHostingUrl: (url) => {
            earlyHostingUrl = url;
            // Not the canonical BLOCKS_DEPLOYED line (that needs the API URL,
            // known only from outputs.json below). This is an early, greppable
            // frontend-URL line so a caller learns where the app lives even if
            // the process is killed before the deploy fully completes. Its label
            // deliberately differs from the final `🌐 Frontend URL:` line so a
            // naive grep does not match both — the early line says "converging".
            console.log(`\n🌐 Frontend deploying to: ${url}`);
          },
        }
      );
    } catch (error) {
      // Terminal verdict on stdout: a caller that only captures stdout (the case
      // that produced phantom failures) must still be able to tell a failed
      // deploy from a killed process. This banner deliberately moved off stderr,
      // so grepping stderr for this exact string no longer matches — the failure
      // *reason* is still there. The CDK CLI keeps error-level output on stderr
      // even under `--ci`, and the entrypoint prints the error itself with
      // `console.error(error)`.
      console.log('\n❌ Deployment failed.');
      throw error;
    }
    
    const outputs = JSON.parse(readFileSync(join(options.projectRoot, '.blocks-sandbox', 'outputs.json'), 'utf-8'));
    const stackOutputs = Object.values(outputs)[0] as Record<string, string>;
    const apiUrl = stackOutputs.ApiUrl;
    
    const hostingUrl = Object.entries(stackOutputs).find(([key]) => 
      key.includes('Hosting') && key.includes('Url')
    )?.[1] ?? earlyHostingUrl;
    
    if (!apiUrl) {
      throw new Error('Could not find API URL in CDK outputs');
    }
    
    // Write config.json with API endpoint
    const config: Record<string, string> = { apiUrl, environment: 'production' };
    const outDir = join(options.projectRoot, '.blocks-sandbox');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'config.json'), JSON.stringify(config, null, 2));

    console.log('\n✅ Deployment complete!');
    console.log(`\n📡 API URL: ${apiUrl}`);
    if (hostingUrl) {
      console.log(`🌐 Frontend URL: ${hostingUrl}`);
    }

    // Liveness gate: `cdk deploy` returning does NOT mean the new
    // build is being served — CloudFront takes a short window to propagate the
    // new viewer-request function and config. When `--wait-live` is set, block
    // until the deployed frontend actually serves the new build before emitting
    // the completion signal, so a caller's immediate self-test can't hit a
    // stale bundle. Skipped for a backend-only app (no frontend to verify).
    if (waitLive && hostingUrl) {
      const timeoutMs = waitLiveTimeoutSec * 1000;
      console.log(`\n⏳ Waiting for the new build to go live at ${hostingUrl} (up to ${timeoutMs / 1000}s)…`);
      const result = await waitForLiveBuild({
        hostingUrl,
        timeoutMs,
        intervalMs: WAIT_LIVE_INTERVAL_MS,
        fetch: (url) => fetch(url, { cache: 'no-store' }),
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        onAttempt: ({ attempt, result: r, detail }) => {
          if (r !== 'live') {
            console.log(`   …not live yet (attempt ${attempt}: ${r}${detail ? ` — ${detail}` : ''})`);
          }
        },
      });
      if (!result.live) {
        // Never emit a false "live" signal. Report the timeout honestly and
        // exit non-zero so a caller treats it as "could not confirm", not done.
        console.log(
          `\n⚠️  Could not confirm the new build is live after ${Math.round(result.elapsedMs / 1000)}s ` +
            `(${result.attempts} attempts). The deploy itself SUCCEEDED, but CloudFront may still be ` +
            `serving the previous build — re-check the frontend before trusting a self-test.`,
        );
        console.log(`\n📡 API URL: ${apiUrl}`);
        if (hostingUrl) console.log(`🌐 Frontend URL: ${hostingUrl}`);
        process.exitCode = 1;
        return;
      }
      console.log(`\n✅ New build is live (confirmed in ${Math.round(result.elapsedMs / 1000)}s).`);
    }

    // Machine-readable completion signal — a single stable line a caller (a
    // coding agent, a CI step, a script) can grep for "deploy done + where it
    // lives" without parsing CloudFormation output or polling the stack. Always
    // the LAST line on the success path. With `--wait-live` it is emitted only
    // after the new build is confirmed live, so a request issued immediately
    // after it returns the new asset.
    console.log(`\n${formatDeploySignal(apiUrl, hostingUrl)}`);
  });
}
