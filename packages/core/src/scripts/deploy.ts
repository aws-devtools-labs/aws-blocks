// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureSecrets, loadProductionEnv } from './ensure-secrets.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { applyExternalMigrations } from './external-migrations-step.js';
import { resolveDeploymentTarget } from './deployment-target.js';
import { trackCommand } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { runStreaming, buildCdkDeployArgs, formatDeploySignal } from './deploy-stream.js';
import { waitForLiveBuild, type InvalidationProbe } from './wait-live.js';

export interface DeployOptions {
  cdkAppPath: string;
  projectRoot: string;
  /**
   * When true, block until the new frontend build is actually served through
   * CloudFront before emitting `BLOCKS_DEPLOYED`, so a caller's immediate
   * self-test can't hit a stale bundle during edge propagation. No-op for a
   * backend-only app.
   */
  waitLive?: boolean;
  /** Overall budget for the liveness wait, in seconds. Defaults to 180. */
  waitLiveTimeoutSec?: number;
}

/** Default liveness-wait budget (seconds). */
export const DEFAULT_WAIT_LIVE_TIMEOUT_SEC = 180;
/** Poll interval for the liveness wait, in milliseconds. */
export const WAIT_LIVE_INTERVAL_MS = 2_000;

/**
 * Parse the `--wait-live` flags from an argv tail. Pure and exported so flag
 * handling is unit-tested without spawning a deploy. An out-of-range or
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
    // Floor BEFORE the range check so a fractional value like 0.5 is rejected
    // (it would otherwise floor to a 0s budget) rather than silently accepted.
    const seconds = Math.floor(raw);
    if (Number.isFinite(raw) && seconds >= 1 && seconds <= 3600) {
      waitLiveTimeoutSec = seconds;
    } else {
      console.warn(
        `⚠️  Ignoring --wait-live-timeout=${timeoutArg.slice('--wait-live-timeout='.length)} ` +
          `(expected a whole number of seconds, 1–3600); using ${DEFAULT_WAIT_LIVE_TIMEOUT_SEC}s.`,
      );
    }
  }
  return { waitLive, waitLiveTimeoutSec };
}

// Re-exported from deploy-stream (the shared module) so existing importers of
// `./deploy.js` — including deploy.test.ts — keep resolving it here while
// sandbox() imports the same helper without pulling in deploy()'s dependency
// chain.
export { formatDeploySignal };

/** The HostingUrl/BuildId/InvalidationId outputs resolved for one frontend. */
export interface ResolvedHostingOutputs {
  /** Public frontend origin; falls back to the early-stream URL when no output matched. */
  hostingUrl?: string;
  /** The `HostingBuildId` output value for the same Hosting group, if present. */
  expectedBuildId?: string;
  /** The `HostingInvalidationId` output value (`<distributionId>/<invalidationId>`), if present. */
  invalidationId?: string;
}

/**
 * Pair the HostingUrl, BuildId and InvalidationId outputs for a SINGLE Hosting
 * construct, so the liveness poll waits on one frontend's own ids rather than
 * independent first-matches that could cross groups on a two-Hosting stack.
 *
 * A Hosting construct's CfnOutput logical ids share a prefix and a CDK
 * 8-hex-hash suffix, e.g. `HostingHostingUrl1A2B3C4D`,
 * `HostingHostingBuildId8EDD8441`, `HostingHostingInvalidationIdF60AF4B3`. We
 * anchor on the first `…HostingUrl<hash>` output, take its prefix, and match
 * the sibling ids by the EXACT `<prefix>HostingBuildId<hash>` shape — not a
 * `startsWith`, which would let a `Web`/`WebAdmin` pair collide. Pure and
 * exported so the pairing is unit-tested against real logical ids.
 *
 * `--wait-live` targets a single-frontend stack; the first Hosting group is
 * that frontend. `earlyHostingUrl` is the URL captured from the deploy stream,
 * used when no `HostingUrl` output is present.
 */
export function resolveHostingOutputs(
  stackOutputs: Record<string, string>,
  earlyHostingUrl?: string,
): ResolvedHostingOutputs {
  const keys = Object.keys(stackOutputs);
  // Anchor on the first output whose id contains `HostingUrl`. CDK suffixes a
  // nested construct's CfnOutput id with a hash, so the real key looks like
  // `HostingHostingUrl1A2B3C4D`.
  const urlKey = keys.find((k) => k.includes('HostingUrl'));
  const hostingUrl = urlKey ? stackOutputs[urlKey] : earlyHostingUrl;

  // Derive the group prefix from the matched Url key (everything up to and
  // including `Hosting`, i.e. the part before `Url`). Sibling ids must share
  // this exact prefix AND end in only the CDK hash (hex) — anchoring on the
  // hex tail rather than a loose `startsWith` is what stops a `Web`/`WebAdmin`
  // pair from colliding (their prefixes differ, so neither matches the other).
  const prefix = urlKey ? urlKey.slice(0, urlKey.indexOf('HostingUrl') + 'Hosting'.length) : undefined;
  const siblingFor = (suffix: string): string | undefined => {
    const k = keys.find((key) =>
      prefix === undefined
        ? key.includes(`Hosting${suffix}`)
        : key.startsWith(`${prefix}${suffix}`) && /^[0-9A-Fa-f]*$/.test(key.slice(`${prefix}${suffix}`.length)),
    );
    return k ? stackOutputs[k] : undefined;
  };

  return {
    hostingUrl,
    expectedBuildId: siblingFor('BuildId'),
    invalidationId: siblingFor('InvalidationId'),
  };
}

/** The slice of a CloudFront client the invalidation probe needs — lets a test
 * inject a fake without the real SDK. */
export interface InvalidationStatusClient {
  send(command: unknown, options: { abortSignal: AbortSignal }): Promise<{ Invalidation?: { Status?: string } }>;
}

/**
 * Classify an invalidation-probe error as terminal (can never clear during this
 * deploy) vs. transient (retry). Terminal cases: the credentials can't read the
 * invalidation (`AccessDenied`), the id/distribution doesn't exist
 * (`NoSuchInvalidation`/`NoSuchDistribution`), or the client has no Region
 * (`Region is missing`). Everything else (throttling, 5xx, a timeout) is
 * transient. Pure and exported so the classification is unit-tested.
 */
export function classifyInvalidationError(error: unknown): { fatal: string } | 'transient' {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const terminalNames = new Set([
    'AccessDenied',
    'AccessDeniedException',
    'NoSuchInvalidation',
    'NoSuchDistribution',
  ]);
  if (terminalNames.has(name)) return { fatal: name };
  if (/region is missing/i.test(message)) return { fatal: 'Region is missing' };
  return 'transient';
}

/**
 * Build the injected invalidation-status probe `waitForLiveBuild` calls. Reads
 * `GetInvalidation` through the given client and maps the result to the pure
 * `InvalidationProbeResult`: `'completed'`/`'pending'`, or a terminal `{ fatal }`
 * for an error that can never clear (see {@link classifyInvalidationError}).
 * Exported with the client injected so the mapping is tested without the SDK.
 */
export function makeInvalidationProbe(
  client: InvalidationStatusClient,
  getInvalidationCommand: (distributionId: string, invalidationId: string) => unknown,
  distributionId: string,
  invalidationId: string,
): InvalidationProbe {
  return async (reqTimeoutMs) => {
    try {
      const res = await client.send(getInvalidationCommand(distributionId, invalidationId), {
        abortSignal: AbortSignal.timeout(reqTimeoutMs),
      });
      return res.Invalidation?.Status === 'Completed' ? 'completed' : 'pending';
    } catch (error) {
      const classified = classifyInvalidationError(error);
      return classified === 'transient' ? 'pending' : classified;
    }
  };
}

export async function deploy(options: DeployOptions) {
  return trackCommand('deploy', async () => {
    console.log('🏗️  Preparing deployment...');

    // Resolve the liveness-wait config: an explicit option wins, else read the
    // flags from argv so the thin template wrapper needs no arg plumbing.
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

    // Pair the frontend URL, build id, and invalidation id from the SAME
    // Hosting output group (see resolveHostingOutputs). `--wait-live` targets a
    // single-frontend stack; the first Hosting group is that frontend.
    const { hostingUrl, expectedBuildId, invalidationId } = resolveHostingOutputs(
      stackOutputs,
      earlyHostingUrl,
    );
    
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

    // Liveness gate: block until the deployed frontend serves the new build
    // before emitting the completion signal, so a caller's immediate self-test
    // can't hit a stale bundle. Skipped for a backend-only app (no hostingUrl)
    // and for the degenerate case of a frontend with no build-id output.
    if (waitLive && hostingUrl && expectedBuildId) {
      const timeoutMs = waitLiveTimeoutSec * 1000;
      console.log(`\n⏳ Waiting for the new build to go live at ${hostingUrl} (up to ${timeoutMs / 1000}s)…`);

      // For a compute deploy, also wait on the fire-and-forget `/*`
      // invalidation. The output carries `<distributionId>/<invalidationId>`.
      // Resolve the Region/profile the deploy itself used (SDK v3 clients don't
      // read cdk.json or AWS_DEFAULT_PROFILE — see resolveDeploymentTarget), and
      // load the CloudFront SDK lazily so a deploy without `--wait-live`, or a
      // pure-static one, never pays for it.
      let invalidationComplete: InvalidationProbe | undefined;
      let destroyClient: (() => void) | undefined;
      if (invalidationId) {
        const [distributionId, invId] = invalidationId.split('/');
        const target = await resolveDeploymentTarget({ projectRoot: options.projectRoot });
        const { CloudFrontClient, GetInvalidationCommand } = await import('@aws-sdk/client-cloudfront');
        const cloudfront = new CloudFrontClient({ region: target.region ?? undefined, profile: target.profile });
        destroyClient = () => cloudfront.destroy();
        invalidationComplete = makeInvalidationProbe(
          cloudfront,
          (DistributionId, Id) => new GetInvalidationCommand({ DistributionId, Id }),
          distributionId,
          invId,
        );
      }

      let result;
      try {
        result = await waitForLiveBuild({
          hostingUrl,
          expectedBuildId,
          invalidationComplete,
          timeoutMs,
          intervalMs: WAIT_LIVE_INTERVAL_MS,
          fetch: (url, reqTimeoutMs) => fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(reqTimeoutMs) }),
          now: () => Date.now(),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          onAttempt: ({ attempt, result: r, detail }) => {
            if (r !== 'live') {
              console.log(`   …not live yet (attempt ${attempt}: ${r}${detail ? ` — ${detail}` : ''})`);
            }
          },
        });
      } finally {
        destroyClient?.();
      }

      if (!result.live) {
        // Not live: a terminal error (can never clear this deploy) names its
        // real cause; a timeout means the deploy succeeded but liveness is
        // unconfirmed. Either way exit non-zero rather than emit a false "live".
        if (result.reason === 'fatal') {
          console.log(
            `\n⚠️  Could not read the invalidation status: ${result.fatal}. The deploy itself ` +
              `SUCCEEDED, but build liveness can't be confirmed — grant cloudfront:GetInvalidation to ` +
              `the deploying credentials, or drop --wait-live.`,
          );
        } else {
          console.log(
            `\n⚠️  Could not confirm the new build is live after ${Math.round(result.elapsedMs / 1000)}s ` +
              `(${result.attempts} attempts). The deploy itself SUCCEEDED, but CloudFront may still be ` +
              `serving the previous build — re-check the frontend before trusting a self-test.`,
          );
        }
        console.log(`\n📡 API URL: ${apiUrl}`);
        if (hostingUrl) console.log(`🌐 Frontend URL: ${hostingUrl}`);
        process.exitCode = 1;
        return;
      }
      console.log(`\n✅ New build is live (confirmed in ${Math.round(result.elapsedMs / 1000)}s).`);
    } else if (waitLive && hostingUrl && !expectedBuildId) {
      // A frontend with no build-id output: the config poll has nothing to
      // match, so it would wait the whole budget and fail. Skip it with a note
      // rather than waste the time — re-synthesize to emit HostingBuildId.
      console.log(
        '\nℹ️  --wait-live skipped: this stack emits no HostingBuildId output, so build liveness ' +
          'cannot be confirmed. Re-synthesize with the current hosting construct to enable it.',
      );
    }

    // Machine-readable completion signal — a single stable line a caller (a
    // coding agent, a CI step, a script) can grep for "deploy done + where it
    // lives" without parsing CloudFormation output or polling the stack. Always
    // the LAST line on the success path; with `--wait-live` it is emitted only
    // after the new build is confirmed live.
    console.log(`\n${formatDeploySignal(apiUrl, hostingUrl)}`);
  });
}
