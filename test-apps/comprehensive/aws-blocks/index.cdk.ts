// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';
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
  backendCDKPath: join(__dirname, 'index.ts')
});

// Propagate E2E_FROM_EMAIL to the Lambda runtime so the EmailClient BB
// resolves the verified SES sender address in deployed environments.
if (process.env.E2E_FROM_EMAIL) {
  blocksStack.handler.addEnvironment('E2E_FROM_EMAIL', process.env.E2E_FROM_EMAIL);
}

// Test-support: let the handler admin-provision Cognito users server-side for the WebSocket
// long-running agent test. The e2e runner uses --conditions=browser, under which the AWS SDK
// can't be constructed client-side, and Cognito self-signup codes aren't retrievable in-process
// — so provisioning has to happen in the Lambda. Scoped to this test stack's account; this is a
// test app, not a customer template.
blocksStack.handler.addToRolePolicy(new PolicyStatement({
  actions: [
    'cognito-idp:AdminCreateUser',
    'cognito-idp:AdminSetUserPassword',
    'cognito-idp:AdminDeleteUser',
  ],
  resources: ['*'],
}));

// E2E test stacks must be fully deletable regardless of deploy mode.
// Production apps would only apply these in sandbox mode.
RemovalPolicies.of(blocksStack).destroy();
Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());

// Tag every taggable resource in the stack for easy identification and cleanup
cdk.Tags.of(blocksStack).add('blocks:purpose', 'e2e-test');
cdk.Tags.of(blocksStack).add('blocks:deploy-mode', sandboxMode ? 'sandbox' : 'production');
cdk.Tags.of(blocksStack).add('blocks:created-at', new Date().toISOString().split('T')[0]);
