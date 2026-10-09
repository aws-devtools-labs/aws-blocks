// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Hosting, BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSandboxId } from './scripts/sandbox-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const suffix = process.env.BLOCKS_STACK_SUFFIX;

const stackName = sandboxMode
  ? `blocks-hosting-spa-${getSandboxId(projectRoot)}${suffix ? `-${suffix}` : ''}`
  : `blocks-hosting-spa-prod-${suffix || 'default'}`;

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  // Disposable CI test stack: force the sandbox posture (DESTROY, no deletion
  // protection) so teardown works in every deploy mode. A real app would use
  // `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`.
  defaults: BlocksPresets.sandbox,
});

// Hosting — SPA (static site served via CloudFront)
new Hosting(blocksStack, 'Hosting', {
  root: join(__dirname, '..'),
  buildCommand: 'npm run build',
  buildOutputDir: 'dist',
  framework: 'spa',
  api: blocksStack,
});

// Sandbox e2e only — see "Sandbox e2e test support" in `index.ts`. The flag
// is read here at synth. `BlocksStack.create` has already written the
// handler's config (`registerConfig`) by the time it returns, so the flag goes
// onto the handler environment instead: the deployed backend then builds the
// same `testSupport` namespace that synth did. The output names the SSM
// parameter holding the per-deploy secret, which the harness reads.
if (process.env.BLOCKS_TEST_ENV === 'sandbox') {
  blocksStack.handler.addEnvironment('BLOCKS_TEST_ENV', 'sandbox');
  // The `AppSetting` construct `index.ts` declares (its CDK layer carries `parameterName`).
  const setting = blocksStack.node.findAll().find((c) => c.node.id === 'test-support-secret');
  const parameterName = setting && 'parameterName' in setting ? setting.parameterName : undefined;
  if (typeof parameterName !== 'string') {
    throw new Error('BLOCKS_TEST_ENV=sandbox, but index.ts declared no test-support-secret AppSetting');
  }
  new cdk.CfnOutput(blocksStack, 'TestSupportSecretParameter', { value: parameterName });
}

cdk.Tags.of(blocksStack).add('blocks:purpose', 'e2e-hosting-spa');
cdk.Tags.of(blocksStack).add('blocks:deploy-mode', sandboxMode ? 'sandbox' : 'production');
cdk.Tags.of(blocksStack).add('blocks:created-at', new Date().toISOString().split('T')[0]);
