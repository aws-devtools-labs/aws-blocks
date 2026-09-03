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
import { runStreaming, buildCdkDeployArgs } from './deploy-stream.js';
import { getStackName } from './stack-id.js';

export interface DeployOptions {
  cdkAppPath: string;
  projectRoot: string;
}

/**
 * Whether a stack in CloudFormation status `status` will next deploy as an
 * UPDATE change set (so `--revert-drift` is valid) rather than a CREATE.
 *
 * REVERT_DRIFT is a deployment mode CFN allows ONLY on UPDATE change sets, and
 * several statuses resolve in DescribeStacks yet still deploy as CREATE — so
 * "a stack row exists" is not the same question as "the next deploy is an
 * UPDATE". We answer by EXCLUDING the states that are effectively a CREATE, so
 * every genuinely-created, deployable state (CREATE_COMPLETE, UPDATE_COMPLETE,
 * UPDATE_ROLLBACK_COMPLETE, IMPORT_COMPLETE, …) is updatable by default:
 *
 *  - `REVIEW_IN_PROGRESS`: a change set was created but never executed, so the
 *    stack was never successfully created — the next deploy is a CREATE.
 *  - any `ROLLBACK_*` (ROLLBACK_COMPLETE / ROLLBACK_FAILED / ROLLBACK_IN_PROGRESS):
 *    the initial create failed or is rolling back; CDK treats this as a failed
 *    initial creation and deletes-and-recreates the stack, so the next deploy is
 *    again a CREATE. (Note: this is the bare `ROLLBACK_` prefix only —
 *    `UPDATE_ROLLBACK_*` are genuine UPDATE targets and remain updatable.)
 *  - any `DELETE_*`: the stack is gone or going (DELETE_COMPLETE already surfaces
 *    as "does not exist"; DELETE_IN_PROGRESS is a transient non-deployable
 *    window) — not an UPDATE.
 */
export function isUpdatableStackStatus(status: string | undefined): boolean {
  return !!status && status !== 'REVIEW_IN_PROGRESS' && !status.startsWith('ROLLBACK_') && !status.startsWith('DELETE_');
}

/**
 * Whether the production CloudFormation stack `stackName` is present AND in a
 * state whose next deploy is an UPDATE (see {@link isUpdatableStackStatus}).
 *
 * Used to gate `--revert-drift` on the production deploy: REVERT_DRIFT is a
 * CloudFormation deployment mode allowed only on UPDATE change sets, so it may
 * be emitted only when the stack already exists AND is updatable — never on a
 * first/CREATE deploy, nor when a present-but-not-created status (e.g.
 * REVIEW_IN_PROGRESS / ROLLBACK_COMPLETE / DELETE_*) means CFN still runs a
 * CREATE change set, which it hard-rejects the flag on.
 *
 * Best-effort and fail-safe: a `does not exist` / ValidationError means "no
 * stack" (CREATE → `false`). On ANY OTHER error (throttle, network,
 * permissions, missing SDK) we also return `false` and warn — losing drift
 * reconciliation for this one run is strictly safer than breaking the deploy.
 * Reuses the region/credentials already resolved into the environment.
 */
export async function productionStackIsUpdatable(stackName: string): Promise<boolean> {
  try {
    const { CloudFormationClient, DescribeStacksCommand } = await import('@aws-sdk/client-cloudformation');
    const cfn = new CloudFormationClient({});
    const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const status = res.Stacks?.[0]?.StackStatus;
    return isUpdatableStackStatus(status);
  } catch (e) {
    const message = (e as Error).message ?? '';
    // A missing stack is the expected first-deploy case: DescribeStacks throws a
    // ValidationError whose message contains "does not exist".
    if (/does not exist/i.test(message) || (e as { name?: string }).name === 'ValidationError') {
      return false;
    }
    // Any other failure (throttle/network/permissions) must not break the deploy;
    // fall back to omitting --revert-drift for this run.
    console.warn(`  ⚠️  could not determine whether stack ${stackName} exists (${message}); skipping --revert-drift`);
    return false;
  }
}

export async function deploy(options: DeployOptions) {
  return trackCommand('deploy', async () => {
    console.log('🏗️  Preparing deployment...');

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

    try {
      // `--revert-drift` (CFN REVERT_DRIFT deployment mode) is valid only on an
      // UPDATE change set; CFN rejects it on a first/CREATE deploy. Emit it only
      // when the production stack already exists AND is in an updatable state
      // (not REVIEW_IN_PROGRESS/ROLLBACK_COMPLETE/DELETE_*, which still deploy as
      // CREATE) so the first deploy succeeds and later deploys still reconcile
      // dev-loop drift.
      const stackName = getStackName({ sandbox: false, projectRoot: options.projectRoot });
      const revertDrift = await productionStackIsUpdatable(stackName);
      await runStreaming(
        "npx",
        buildCdkDeployArgs({
          projectRoot: options.projectRoot,
          outputsFile: '.blocks-sandbox/outputs.json',
          revertDrift,
        }),
        {
          label: 'cdk deploy',
          cwd: options.projectRoot,
          env: {
            ...process.env,
            NODE_OPTIONS: '--conditions=cdk',
            ...getCdkTelemetryEnv('production')
          }
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
