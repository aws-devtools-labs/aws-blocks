// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadProductionEnv } from './ensure-secrets.js';
import { stageConnectionString, sweepOrphanStagingParams, STAGING_ENV_VAR } from './stage-secret.js';
import { applyExternalMigrations } from './external-migrations-step.js';
import { trackCommand } from '../telemetry/trackCommand.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { runSync } from './run-command.js';

export interface DeployOptions {
  cdkAppPath: string;
  projectRoot: string;
}

export async function deploy(options: DeployOptions) {
  return trackCommand('deploy', async () => {
    console.log('🏗️  Preparing deployment...');

    // Load production environment (from .env.production or CI env vars)
    loadProductionEnv();

    process.env.BLOCKS_STAGE = 'production';

    // Apply external-database migrations to the production database before
    // deploying. No-op unless this app uses an external DB and has ./migrations.
    // Uses the connection string from process.env, not the SSM parameter, so it
    // is independent of the copyFrom staging below.
    await applyExternalMigrations({ stage: 'production' });

    // Stage the connection string for the copyFrom mechanism: write it to a
    // unique throwaway SSM parameter and pass that name (never the value) to the
    // CDK app via the environment. The in-stack copy custom resource reads it at
    // deploy time, writes it into the final stack-scoped parameter, and deletes
    // the staging parameter — all inside the CloudFormation transaction, so the
    // value is seeded atomically with the stack. No-op when there is no
    // connection string. Reap orphaned staging params from prior failed deploys
    // first (best-effort).
    await sweepOrphanStagingParams();
    const staged = await stageConnectionString();
    if (staged) {
      process.env[STAGING_ENV_VAR] = staged.stagingParameterName;
    }
    
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
    
    try {
      runSync(
        "npx",
        [
          "cdk", "deploy",
          "--require-approval", "never",
          "--outputs-file", ".blocks-sandbox/outputs.json",
          "--context", `projectRoot=${options.projectRoot}`,
        ],
        {
          stdio: 'inherit',
          cwd: options.projectRoot,
          env: {
            ...process.env,
            NODE_OPTIONS: '--conditions=cdk',
            ...getCdkTelemetryEnv('production')
          }
        }
      );
    } catch (error) {
      console.error('\n❌ Deployment failed.');
      throw error;
    }
    
    const outputs = JSON.parse(readFileSync(join(options.projectRoot, '.blocks-sandbox', 'outputs.json'), 'utf-8'));
    const stackOutputs = Object.values(outputs)[0] as Record<string, string>;
    const apiUrl = stackOutputs.ApiUrl;

    // Note: the database connection string was already seeded into its
    // stack-scoped SSM parameter by the in-stack copy custom resource during
    // deploy (see the copyFrom staging above) — there is no post-deploy write.

    const hostingUrl = Object.entries(stackOutputs).find(([key]) => 
      key.includes('Hosting') && key.includes('Url')
    )?.[1];
    
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
  });
}
