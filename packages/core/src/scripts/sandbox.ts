// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureSecrets, loadEnvFile } from './ensure-secrets.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { applyExternalMigrations } from './external-migrations-step.js';
import { trackCommand } from '../telemetry/trackCommand.js';
import { buildAndSendEvent } from '../telemetry/client.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { runSync, spawnCommand } from './run-command.js';
import { terminateProcessTree } from './process-tree.js';

/**
 * Import the backend definition to populate the Scope BB registry.
 *
 * All BB variants set bbName/bbVersion on construction, so importing the
 * backend is sufficient to register every block. `buildAndSendEvent` then
 * reads the registry internally — callers don't need to pass block data.
 * Failures are silently swallowed — telemetry is best-effort.
 */
async function importBackendForRegistry(backendPath: string): Promise<void> {
  try {
    await import(pathToFileURL(resolve(backendPath)).href);
  } catch {
    // best-effort — telemetry never affects the command
  }
}

export interface SandboxOptions {
  backendPath: string;
  outDir?: string;
  clientPort?: number;
  deployOnly?: boolean;
  /** Custom dev server command. Defaults to 'npx vite'. For Next.js use 'npx next dev'. */
  devCommand?: string;
}

export interface SandboxDeployArgsOptions {
  /** Directory CDK writes stack outputs to (relative to the project root). */
  outDir: string;
  /** Project root passed to synth as `--context projectRoot=…` (usually `process.cwd()`). */
  projectRoot: string;
  /** Backend entry passed to `--app` so CDK synthesizes from the app definition. */
  backendPath: string;
}

/**
 * Build the `npm exec cdk -- deploy …` argv used by the sandbox deploy.
 *
 * Kept pure (no I/O) so the argv contract — in particular the flags below — can
 * be asserted directly, the same way {@link buildCdkDeployArgs} is for the
 * production path.
 *
 * - `--all`: an app that uses Lambda@Edge (e.g. a Next.js route with
 *   `export const runtime = 'edge'`) synthesizes a SECOND stack
 *   (`edge-lambda-stack-*`, region us-east-1) in addition to the main hosting
 *   stack. Without `--all`, CDK refuses with "specify which stacks to use".
 *   Deploying every stack in a sandbox app is the intended behavior.
 * - `--method direct`: skip CloudFormation change-set creation and call
 *   UpdateStack directly. This is the baseline sandbox deployment method that
 *   `--express` builds on.
 * - `--express` (**CloudFormation Express Mode — sandbox only**): the real
 *   speedup. CloudFormation reports each stack operation complete as soon as
 *   the resource's configuration is applied, WITHOUT waiting for full
 *   stabilization. Because it skips stabilization it also disables automatic
 *   rollback by default, so a failed deploy can leave the stack in a failed
 *   state — acceptable for the throwaway sandbox iteration loop, never for
 *   production. We leave rollback at Express Mode's default (off) and do NOT
 *   pass `--rollback`. The production deploy path (`deploy.ts`) deliberately
 *   uses neither `--express` nor `--method direct`: it keeps a reviewable
 *   change set and full stabilization with rollback, which are exactly the
 *   safety signals a production deploy should keep. Requires an aws-cdk CLI
 *   new enough to expose `--express`; our pinned `^2.1138.0` has it.
 */
export function buildSandboxDeployArgs({ outDir, projectRoot, backendPath }: SandboxDeployArgsOptions): string[] {
  return [
    "exec", "cdk", "--", "deploy",
    "--all",
    "--method", "direct",
    "--express",
    "--require-approval", "never",
    "--outputs-file", `${outDir}/outputs.json`,
    "--context", `projectRoot=${projectRoot}`,
    "--context", "sandboxMode=true",
    "--app", `npm exec tsx -- -C cdk ${backendPath}`,
  ];
}

/**
 * Operator-facing recovery guidance printed when a sandbox deploy fails.
 *
 * Express Mode (see {@link buildSandboxDeployArgs}) disables CloudFormation's
 * automatic rollback, so a failed deploy does NOT clean up after itself: a
 * failed *first* deploy leaves the stack in `CREATE_FAILED`/`ROLLBACK_COMPLETE`
 * and a failed update can land in `UPDATE_ROLLBACK_FAILED`. In those states
 * CloudFormation refuses the next `UpdateStack`, so a plain re-run of
 * `npm run sandbox` would hit the same wall — a silent dead-end for the fast
 * loop. This spells out the exact way out instead of leaving the operator to
 * discover it via a cryptic CloudFormation error.
 *
 * Kept pure so it can be asserted in a unit test.
 */
export function sandboxFailureRecoveryHint(): string {
  return [
    "",
    "ℹ️  Express Mode leaves failed sandbox stacks in place (automatic rollback is off).",
    "   If the next `npm run sandbox` reports the stack cannot be updated, recover with:",
    "",
    "     npm run sandbox:destroy   # tears the failed stack down (handles ROLLBACK_COMPLETE)",
    "     npm run sandbox           # redeploy from a clean slate",
    "",
    "   If destroy reports UPDATE_ROLLBACK_FAILED, first run:",
    "     aws cloudformation continue-update-rollback --stack-name <your-sandbox-stack>",
  ].join("\n");
}

export async function startSandbox(options: SandboxOptions) {
  const { backendPath, outDir = ".blocks-sandbox", clientPort = 3000, deployOnly = false, devCommand } = options;
  const sandboxStartTime = Date.now();

  // Load .env.local so CDK can read secret ARNs and other config.
  try { loadEnvFile('.env.local'); } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }

  process.env.BLOCKS_STAGE = 'sandbox';

  // Fail fast if AWS credentials are missing/expired, before spending ~10s in
  // synth only to hit an opaque CDK credential error.
  await assertAwsCredentials('sandbox');

  // Provision connection string to SSM SecureString.
  // On first deploy, creates the parameter. On subsequent deploys, updates if changed.
  // projectRoot is process.cwd() — the same value passed to cdk as --context
  // projectRoot below — so the written name matches the name resolved at synth.
  const secrets = await ensureSecrets('sandbox', process.cwd());
  if (secrets.created.length > 0) {
    console.log(`🔐 Created secrets: ${secrets.created.join(', ')}`);
  }
  if (secrets.updated.length > 0) {
    console.log(`🔐 Updated secrets: ${secrets.updated.join(', ')}`);
  }

  // Apply external-database migrations to the sandbox database before
  // deploying. No-op unless this app uses an external DB and has ./migrations.
  await applyExternalMigrations({ stage: 'sandbox' });

  // Import backend to populate Scope BB registry (for telemetry).
  // Runs before CDK deploy so both success and failure paths include block info.
  await importBackendForRegistry(backendPath);

  console.log("🚀 Deploying to AWS...");
  console.log("   (This may take a few minutes on first deploy)");

  try {
    runSync(
      "npm",
      // Argv (including sandbox-only CloudFormation Express Mode, `--express`)
      // is built by buildSandboxDeployArgs — see its doc for why each flag exists.
      buildSandboxDeployArgs({ outDir, projectRoot: process.cwd(), backendPath }),
      {
        stdio: "inherit",
        env: { ...process.env, NODE_OPTIONS: "--conditions=cdk", ...getCdkTelemetryEnv('sandbox') },
      },
    );
  } catch (error) {
    buildAndSendEvent({
      command: 'sandbox',
      state: 'FAIL',
      duration: Date.now() - sandboxStartTime,
      error: { code: 'CDK_DEPLOY_FAILED', phase: 'deploy' },
    });
    console.error("\n❌ Deployment failed.");
    console.error(sandboxFailureRecoveryHint());
    throw error;
  }

  const outputs = JSON.parse(readFileSync(`${outDir}/outputs.json`, "utf-8"));
  const stackOutputs = Object.values(outputs)[0] as Record<string, string> || {};

  const apiUrl = stackOutputs.ApiUrl;
  if (!apiUrl) {
    throw new Error("Could not find API URL in CDK outputs");
  }

  console.log("\n✅ Sandbox deployed!");
  console.log(`📡 API URL: ${apiUrl}`);

  buildAndSendEvent({
    command: 'sandbox',
    state: 'SUCCESS',
    duration: Date.now() - sandboxStartTime,
  });

  // Write config — just apiUrl. Client middleware gets service-specific
  // config from transferables in API responses, not from static config.
  const config: Record<string, string> = { apiUrl, environment: 'sandbox' };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/config.json`, JSON.stringify(config, null, 2));

  // Generate client code targeting AWS (aws-runtime condition ensures
  // the backend registers aws-middleware, not mock-middleware).
  const backendDefPath = resolve(join(dirname(resolve(backendPath)), 'index.ts'));
  const clientPath = join(dirname(backendDefPath), 'client.js');
  console.log('📝 Generating client code...');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const workerPath = join(__dirname, 'generate-client-worker.js');
  execFileSync('node', ['--conditions=aws-runtime', '--import', 'tsx', workerPath, backendDefPath, clientPath], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '' },
  });

  if (deployOnly) {
    return apiUrl;
  }

  console.log("\n👀 Starting CDK watch mode...");
  console.log("🌐 Starting local dev server (proxying to AWS)...");
  console.log(`\n   Open http://localhost:${clientPort}\n`);

  const cdkWatch = spawnCommand("npx", [
    "cdk", "watch",
    `--outputs-file`, `${outDir}/outputs.json`,
    `--context`, `projectRoot=${process.cwd()}`,
    `--context`, `sandboxMode=true`,
    `--app`, `npm exec tsx -- -C cdk ${backendPath}`
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group on POSIX so cleanup can reap the whole `cdk watch` tree
    // (npx → cdk → node) via terminateProcessTree, not just the npx shell — a
    // bare kill() would orphan the real cdk-watch node process, the same
    // shell-only-kill leak this PR eliminates for the dev server. Windows has no
    // groups; terminateProcessTree reaps the tree via taskkill.
    detached: process.platform !== 'win32',
    env: { ...process.env, NODE_OPTIONS: "--conditions=cdk", ...getCdkTelemetryEnv('sandbox') },
  });

  cdkWatch.stdout?.on("data", (data) => {
    const str = data.toString().trim();
    if (!str.match(/\[(START|END|REPORT|INIT_START)\s+RequestId:/)) {
      console.log(`[CDK Watch] ${str}`);
    }
  });
  cdkWatch.stderr?.on("data", (data) => {
    console.error(`[CDK Watch] ${data.toString().trim()}`);
  });

  const devServerCmd = devCommand || `npx tsx watch aws-blocks/scripts/server.ts`;
  const [cmd, ...args] = devServerCmd.split(' ');
  
  const devServer = spawnCommand(cmd, args, {
    stdio: "inherit",
    shell: true,
    // Own process group on POSIX so cleanup can signal the whole dev-server
    // tree (shell → tsx → node). The node dev server then runs its own SIGTERM
    // handler — the ~2s terminateFrontend drain that reaps the *detached* Vite
    // great-grandchild — which a bare `devServer.kill()` (the shell only) never
    // triggers. Windows has no groups; terminateProcessTree reaps via taskkill.
    detached: process.platform !== 'win32',
    env: { 
      ...process.env,
      NODE_OPTIONS: '',
      BLOCKS_API_URL: apiUrl,
    },
  });

  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return; // idempotent — a second signal must not re-enter
    cleaningUp = true;
    console.log("\n\n🛑 Stopping local processes...");
    console.log("   (AWS resources are still running)");
    console.log("\n   To destroy AWS resources, run: npm run sandbox:destroy\n");
    // Reap BOTH child trees the way the dev server reaps Vite — a process-group
    // SIGTERM→SIGKILL via the shared terminateProcessTree — instead of a bare
    // kill() that signals only the npx/shell parent and orphans the real
    // grandchild (cdk-watch's node, or the dev server's detached Vite). Run them
    // concurrently so the cdk-watch teardown doesn't serialize on top of the dev
    // server's longer drain.
    //
    // Only the dev-server child owns the `:3100` port-free wait: its own SIGTERM
    // handler runs terminateFrontend (a ~2s drain that reaps the detached Vite
    // great-grandchild AND polls until the port frees), so we give it the longer
    // 6s budget (> that ~2s drain) — a hung dev server still escalates to a tree
    // SIGKILL and we exit regardless, so shutdown can never wedge. cdk watch
    // holds no local port, so a bounded tree-kill is all it needs.
    //
    // That a group SIGTERM (terminateProcessTree → killFrontendTree's
    // `process.kill(-pid, 'SIGTERM')`) actually reaches the *nested* node dev
    // server and runs its own SIGTERM handler — the load-bearing assumption of
    // the 6s budget above — is verified by the "group SIGTERM reaches a nested
    // node child" integration test in dev-server-supervisor.test.ts.
    await Promise.all([
      terminateProcessTree(cdkWatch, 2000),
      terminateProcessTree(devServer, 6000),
    ]);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await new Promise(() => {});
}

export async function destroySandbox(backendPath: string) {
  return trackCommand('sandbox:destroy', async () => {
    console.log("🗑️  Destroying sandbox...");

    // Load .env.local so CDK synth can read project refs and other config.
    try { loadEnvFile('.env.local'); } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }

    const cdkArgs = [
      "exec", "cdk", "--", "destroy",
      "--force",
      "--context", "sandboxMode=true",
      "--app", `npm exec tsx -- -C cdk ${backendPath}`,
    ];
    const cdkEnv = { ...process.env, NODE_OPTIONS: "--conditions=cdk", ...getCdkTelemetryEnv('sandbox') };
    // Retry with backoff for VPC-dependent resources (e.g. Aurora clusters).
    // CloudFormation deletes the cluster first, but its ENIs take 60-120s to
    // detach from the VPC subnets asynchronously. The initial destroy fails
    // because the subnets still have attached ENIs; retrying after the cleanup
    // window lets the VPC delete succeed.
    const retryDelays = [60_000, 120_000]; // 1min, then 2min

    for (let attempt = 0; ; attempt++) {
      try {
        runSync("npm", cdkArgs, { stdio: "inherit", env: cdkEnv });
        console.log(attempt === 0 ? "\n✅ Sandbox destroyed!" : "\n✅ Sandbox destroyed on retry!");
        return;
      } catch (error) {
        if (attempt < retryDelays.length) {
          const delaySec = retryDelays[attempt] / 1000;
          console.log(`\n⏳ Stack deletion failed. Retrying in ${delaySec}s (waiting for resource cleanup)...`);
          await new Promise(r => setTimeout(r, retryDelays[attempt]));
        } else {
          console.error("\n❌ Destroy failed after retries.");
          throw error;
        }
      }
    }
  });
}
