// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureSecrets, loadEnvFile } from './ensure-secrets.js';
import { applyExternalMigrations } from './external-migrations-step.js';
import { trackCommand } from '../telemetry/trackCommand.js';
import { buildAndSendEvent } from '../telemetry/client.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { runSync, spawnCommand } from './run-command.js';

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

export async function startSandbox(options: SandboxOptions) {
  const { backendPath, outDir = ".blocks-sandbox", clientPort = 3000, deployOnly = false, devCommand } = options;
  const sandboxStartTime = Date.now();

  // Load .env.local so CDK can read secret ARNs and other config.
  try { loadEnvFile('.env.local'); } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }

  process.env.BLOCKS_STAGE = 'sandbox';

  // Provision connection string to SSM SecureString.
  // On first deploy, creates the parameter. On subsequent deploys, updates if changed.
  const secrets = await ensureSecrets('sandbox');
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
      [
        "exec", "cdk", "--", "deploy",
        // `--all`: an app that uses Lambda@Edge (e.g. a Next.js route with
        // `export const runtime = 'edge'`) synthesizes a SECOND stack
        // (`edge-lambda-stack-*`, region us-east-1) in addition to the main
        // hosting stack. Without `--all`, CDK refuses with "specify which
        // stacks to use". Deploying every stack in a sandbox app is the
        // intended behavior, so select them all.
        "--all",
        "--require-approval", "never",
        "--outputs-file", `${outDir}/outputs.json`,
        "--context", `projectRoot=${process.cwd()}`,
        "--context", "sandboxMode=true",
        "--app", `npm exec tsx -- -C cdk ${backendPath}`,
      ],
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
    "cdk", "watch", "--hotswap",
    `--outputs-file`, `${outDir}/outputs.json`,
    `--context`, `projectRoot=${process.cwd()}`,
    `--context`, `sandboxMode=true`,
    `--app`, `npm exec tsx -- -C cdk ${backendPath}`
  ], {
    stdio: ["ignore", "pipe", "pipe"],
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
    env: { 
      ...process.env,
      NODE_OPTIONS: '',
      BLOCKS_API_URL: apiUrl,
    },
  });

  const cleanup = () => {
    console.log("\n\n🛑 Stopping local processes...");
    console.log("   (AWS resources are still running)");
    console.log("\n   To destroy AWS resources, run: npm run sandbox:destroy\n");
    cdkWatch.kill();
    devServer.kill();
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
