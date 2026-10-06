// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureSecrets, loadProductionEnv } from './ensure-secrets.js';
import { assertAwsCredentials } from './preflight-credentials.js';
import { applyExternalMigrations } from './external-migrations-step.js';
import { trackCommand } from '@aws-blocks/core/runtime';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import { runStreaming, buildCdkDeployArgs } from './deploy-stream.js';
import { filteredSink } from './stream-filter.js';
import { createDeployStdout } from './deploy-progress.js';
import { getLogLevel, info, verbose, error as logError } from '../logger.js';
import { runSync } from './run-command.js';

export interface DeployOptions {
  cdkAppPath: string;
  projectRoot: string;
}

export async function deploy(options: DeployOptions) {
  return trackCommand('deploy', async () => {
    verbose('Preparing deployment…');

    // Load production environment (from .env.production or CI env vars)
    loadProductionEnv();

    process.env.BLOCKS_STAGE = 'production';

    // Fail fast if AWS credentials are missing/expired, before generating the
    // client and spending time in synth only to hit an opaque CDK credential error.
    await assertAwsCredentials('deploy');

    // Provision secrets for production. projectRoot must match the root cdk
    // synth uses (passed as --context below) so the written parameter name
    // equals the one the app resolves at synth.
    const secrets = await ensureSecrets('production', options.projectRoot);
    if (secrets.created.length > 0 || secrets.updated.length > 0) {
      verbose(`Secrets provisioned: ${[...secrets.created, ...secrets.updated].join(', ')}`);
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
    verbose('Generating client code…');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const workerPath = join(__dirname, 'generate-client-worker.js');
    runSync('node', ['--conditions=aws-runtime', '--import', 'tsx', workerPath, foundationPath, clientPath], {
      cwd: options.projectRoot,
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    // The progress reporter owns the user-facing "Deploying" milestone (it is
    // emitted on the first CloudFormation event), so keep these as verbose detail.
    verbose('Deploying to AWS (this can take a few minutes on first deploy)…');
    verbose('  - Backend API (Lambda + API Gateway)');
    verbose('  - Frontend hosting (S3 + CloudFront)');
    verbose('  Streaming CloudFormation events; the deploy keeps running if this');
    verbose('  process is backgrounded (Ctrl-C, or SIGTERM twice, to abort).');

    const { sink: deployStdout, finish: finishProgress } = createDeployStdout(
      process.stdout,
      getLogLevel(),
      { isTty: Boolean(process.stdout.isTTY), label: 'Deploying to AWS' },
    );
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
          // Heartbeats are redundant with the progress indicator at Normal; the
          // reporter's own live line is the "still working" signal.
          heartbeatMs: getLogLevel() >= 2 ? undefined : 0,
          stdout: deployStdout,
          stderr: filteredSink(process.stderr, getLogLevel()),
          env: {
            ...process.env,
            NODE_OPTIONS: '--conditions=cdk',
            ...getCdkTelemetryEnv('production')
          }
        }
      );
      finishProgress(true);
    } catch (error) {
      // Terminal verdict: a caller that only captures stdout (the case that
      // produced phantom failures) must still be able to tell a failed deploy
      // from a killed process. The CDK CLI keeps error-level output on stderr
      // even under `--ci`, and the entrypoint prints the error itself.
      finishProgress(false);
      logError('Deployment failed.');
      throw error;
    }
    
    const outputs = JSON.parse(readFileSync(join(options.projectRoot, '.blocks-sandbox', 'outputs.json'), 'utf-8'));
    const stackOutputs = Object.values(outputs)[0] as Record<string, string>;
    const apiUrl = stackOutputs.ApiUrl;
    
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

    info('\n✅ Deployment complete.');
    info(`📡 API URL: ${apiUrl}`);
    if (hostingUrl) {
      info(`🌐 Frontend URL: ${hostingUrl}`);
    }
  });
}
