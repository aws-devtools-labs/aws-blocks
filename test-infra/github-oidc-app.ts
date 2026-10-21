// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK app for the GitHub OIDC role in the dedicated E2E account. Deployed by
 * hand, once per account (not by CI), with credentials for that account:
 *
 *   E2E_ACCOUNT_ID=<e2e-account-id> npm run deploy:oidc
 *
 * Then set the `RoleArn` output as the `AWS_ROLE_ARN` secret of the `e2e`
 * environment (and as a Dependabot secret).
 */

import * as cdk from 'aws-cdk-lib';
import { buildGithubE2eOidcStack } from './github-oidc-stack.js';

// Refuse to synthesize unless the caller names the E2E account and the active
// credentials match it, so the role can't land in another account by mistake.
const expectedAccount = process.env.E2E_ACCOUNT_ID;
if (!expectedAccount) {
  throw new Error('Set E2E_ACCOUNT_ID to the dedicated E2E account ID.');
}
if (process.env.CDK_DEFAULT_ACCOUNT !== expectedAccount) {
  throw new Error(
    `Credentials are for account ${process.env.CDK_DEFAULT_ACCOUNT}, expected E2E account ${expectedAccount}. Refusing to deploy.`,
  );
}

const app = new cdk.App();
buildGithubE2eOidcStack(app, {
  account: expectedAccount,
  oidcProviderArn: process.env.GITHUB_OIDC_PROVIDER_ARN || undefined,
});
app.synth();
