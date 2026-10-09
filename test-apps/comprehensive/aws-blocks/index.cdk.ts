// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSandboxId } from './scripts/sandbox-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const suffix = process.env.BLOCKS_STACK_SUFFIX;

// Reuse the sandbox-id helper for the production stack salt too.
// `.blocks-sandbox/sandbox-id.txt` is regenerated on every fresh CI
// checkout, giving each run a unique stack name so a stuck
// DELETE_FAILED stack from a prior run can't block a fresh deploy.
// (The scheduled cleanup workflow can't unstick stacks blocked on
// non-empty S3 buckets — its async delete-stack fails again on the
// same buckets — so each push needs its own name.)
const id = getSandboxId(projectRoot);

const stackName = sandboxMode
  ? `bb-test-${id}${suffix ? `-${suffix}` : ''}`
  : `bb-test-prod-${suffix || 'default'}-${id}`;

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  // E2E test stacks must be fully deletable regardless of deploy mode, so pass
  // the sandbox preset (DESTROY + no deletion protection) unconditionally. This
  // replaces the previous `RemovalPolicies.of(...).destroy()` +
  // `SandboxDisableDeletionProtection` mixin. A production app would use
  // `sandboxMode ? BlocksPresets.sandbox : BlocksPresets.production`.
  defaults: BlocksPresets.sandbox,
});

// Propagate E2E_FROM_EMAIL to the Lambda runtime so the EmailClient BB
// resolves the verified SES sender address in deployed environments.
if (process.env.E2E_FROM_EMAIL) {
  blocksStack.handler.addEnvironment('E2E_FROM_EMAIL', process.env.E2E_FROM_EMAIL);
}

// Deployed e2e only — see "e2e test support" in `index.ts`. The flag
// is read here at synth. `BlocksStack.create` has already written the
// handler's config (`registerConfig`) by the time it returns, so the flag goes
// onto the handler environment instead: the deployed backend then builds the
// same `testSupport` namespace that synth did. The output names the SSM
// parameter holding the per-deploy secret, which the harness reads.
const testEnv = process.env.BLOCKS_TEST_ENV;
if (testEnv === 'local') {
  // `local` is the dev-server e2e build. Synthesized, it would grant the test
  // support's Admin* IAM to a stack whose handler never registers the namespace.
  throw new Error('BLOCKS_TEST_ENV=local is the local (dev server) e2e build; it is never synthesized or deployed');
}
if (testEnv === 'sandbox' || testEnv === 'production') {
  blocksStack.handler.addEnvironment('BLOCKS_TEST_ENV', testEnv);
  // The `AppSetting` construct `index.ts` declares (its CDK layer carries `parameterName`).
  const setting = blocksStack.node.findAll().find((c) => c.node.id === 'test-support-secret');
  const parameterName = setting && 'parameterName' in setting ? setting.parameterName : undefined;
  if (typeof parameterName !== 'string') {
    throw new Error(`BLOCKS_TEST_ENV=${testEnv}, but index.ts declared no test-support-secret AppSetting`);
  }
  new cdk.CfnOutput(blocksStack, 'TestSupportSecretParameter', { value: parameterName });

  // The `auth-gated` pool's native app client id, for the sandbox test that
  // sends a `SignUp` straight to Cognito (as anyone holding the id could) and
  // expects the `validateUser` PreSignUp trigger to reject it.
  const gated = blocksStack.node.findAll().find((c) => c.node.id === 'auth-gated');
  const gatedClient: unknown = gated ? Reflect.get(gated, 'userPoolClient') : undefined;
  const gatedClientId: unknown =
    typeof gatedClient === 'object' && gatedClient !== null ? Reflect.get(gatedClient, 'userPoolClientId') : undefined;
  if (typeof gatedClientId !== 'string') {
    throw new Error(`BLOCKS_TEST_ENV=${testEnv}, but index.ts declared no auth-gated Auth with a user pool client`);
  }
  new cdk.CfnOutput(blocksStack, 'GatedAuthClientId', { value: gatedClientId });
  new cdk.CfnOutput(blocksStack, 'GatedAuthRegion', { value: blocksStack.region });
}

// Tag every taggable resource in the stack for easy identification and cleanup
cdk.Tags.of(blocksStack).add('blocks:purpose', 'e2e-test');
cdk.Tags.of(blocksStack).add('blocks:deploy-mode', sandboxMode ? 'sandbox' : 'production');
cdk.Tags.of(blocksStack).add('blocks:created-at', new Date().toISOString().split('T')[0]);
