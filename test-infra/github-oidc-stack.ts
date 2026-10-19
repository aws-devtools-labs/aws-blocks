// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub Actions OIDC role for the dedicated E2E account.
 *
 * PR E2E jobs (including Dependabot PRs) run third-party code with these
 * credentials, so this stack lives in an AWS account that holds nothing but
 * test stacks.
 *
 * Only jobs in this repo's `e2e` GitHub environment can assume the role.
 * Deployed by hand, once per account (not by CI), with credentials for that
 * account:
 *
 *   E2E_ACCOUNT_ID=<e2e-account-id> npm run deploy:oidc
 *
 * Then set the `RoleArn` output as the `AWS_ROLE_ARN` secret of the `e2e`
 * environment (and as a Dependabot secret).
 *
 * Resources:
 * - GitHub OIDC identity provider
 * - `blocks-github-e2e` role with the permissions the E2E suites use
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

const GITHUB_REPO = 'aws-devtools-labs/aws-blocks';
const GITHUB_ENVIRONMENT = 'e2e';
// Default `cdk bootstrap` qualifier.
const CDK_QUALIFIER = 'hnb659fds';
// Stack/bucket name prefixes the E2E suites deploy and cleanup-stacks.yml
// deletes. `my-app-` is the scaffolded app from windows-template-e2e.mjs.
const E2E_PREFIXES = [
  'bb-hosting-',
  'bb-telemetry-',
  'bb-test-',
  'bb-vpc-smoke-',
  'blocks-hosting-',
  'blocks-test-',
  'my-app-',
];

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

const stack = new cdk.Stack(app, 'BlocksGithubE2eOidc', {
  description: 'GitHub Actions OIDC role for AWS Blocks E2E tests. Deploy only into the dedicated E2E account.',
  env: {
    account: expectedAccount,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

const { account, region } = stack;

// ── OIDC provider ───────────────────────────────────────────────────────────

// Native AWS::IAM::OIDCProvider (no custom-resource Lambda). No thumbprints:
// IAM validates GitHub's endpoint against its trusted CA library.
const provider = new iam.OidcProviderNative(stack, 'GithubOidcProvider', {
  url: 'https://token.actions.githubusercontent.com',
  clientIds: ['sts.amazonaws.com'],
});

// ── Role ────────────────────────────────────────────────────────────────────

const role = new iam.Role(stack, 'GithubE2eRole', {
  roleName: 'blocks-github-e2e',
  description: `Assumed by ${GITHUB_REPO} jobs in the "${GITHUB_ENVIRONMENT}" GitHub environment`,
  maxSessionDuration: cdk.Duration.hours(2),
  assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': `repo:${GITHUB_REPO}:environment:${GITHUB_ENVIRONMENT}`,
    },
  }),
  managedPolicies: [
    iam.ManagedPolicy.fromAwsManagedPolicyName('AWSCloudFormationReadOnlyAccess'),
    // Amplify Gen 2 sandboxes in the amplify-interop suite.
    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmplifyBackendDeployFullAccess'),
  ],
});

// CDK deploys go through the bootstrap roles.
role.addToPolicy(
  new iam.PolicyStatement({
    sid: 'CdkBootstrapRoles',
    actions: ['sts:AssumeRole'],
    resources: ['cfn-exec', 'deploy', 'file-publishing', 'image-publishing', 'lookup'].map(
      (r) => `arn:aws:iam::${account}:role/cdk-${CDK_QUALIFIER}-${r}-role-${account}-${region}`,
    ),
  }),
);
role.addToPolicy(
  new iam.PolicyStatement({
    sid: 'CdkAssetsBucket',
    actions: ['s3:GetBucketLocation', 's3:GetObject', 's3:ListBucket', 's3:PutObject'],
    resources: [
      `arn:aws:s3:::cdk-${CDK_QUALIFIER}-assets-${account}-${region}`,
      `arn:aws:s3:::cdk-${CDK_QUALIFIER}-assets-${account}-${region}/*`,
    ],
  }),
);
role.addToPolicy(
  new iam.PolicyStatement({
    sid: 'CdkBootstrapSsm',
    actions: ['ssm:GetParameter'],
    resources: [`arn:aws:ssm:${region}:${account}:parameter/cdk-bootstrap/${CDK_QUALIFIER}/*`],
  }),
);

// Direct stack management and cleanup of E2E stacks and their buckets.
role.addToPolicy(
  new iam.PolicyStatement({
    sid: 'E2eCloudFormation',
    actions: [
      'cloudformation:CreateChangeSet',
      'cloudformation:CreateStack',
      'cloudformation:DeleteChangeSet',
      'cloudformation:DeleteStack',
      'cloudformation:DescribeChangeSet',
      'cloudformation:DescribeStackEvents',
      'cloudformation:DescribeStackResources',
      'cloudformation:DescribeStacks',
      'cloudformation:ExecuteChangeSet',
      'cloudformation:GetTemplate',
      'cloudformation:GetTemplateSummary',
      'cloudformation:ListStackResources',
      'cloudformation:UpdateStack',
    ],
    resources: E2E_PREFIXES.map((p) => `arn:aws:cloudformation:${region}:${account}:stack/${p}*/*`),
  }),
);
// ListStacks has no resource-level scoping; '*' is the only valid resource.
role.addToPolicy(
  new iam.PolicyStatement({
    sid: 'E2eListStacks',
    actions: ['cloudformation:ListStacks'],
    resources: ['*'],
  }),
);
role.addToPolicy(
  new iam.PolicyStatement({
    sid: 'E2eBucketCleanup',
    actions: [
      's3:DeleteObject',
      's3:DeleteObjectVersion',
      's3:GetObject',
      's3:GetObjectVersion',
      's3:ListBucket',
      's3:ListBucketVersions',
    ],
    resources: E2E_PREFIXES.flatMap((p) => [`arn:aws:s3:::${p}*`, `arn:aws:s3:::${p}*/*`]),
  }),
);

// Test harness calls against the deployed test apps.
role.addToPolicy(
  new iam.PolicyStatement({
    sid: 'CognitoE2eAdmin',
    actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminDeleteUser', 'cognito-idp:AdminSetUserPassword'],
    resources: [`arn:aws:cognito-idp:${region}:${account}:userpool/*`],
  }),
);
role.addToPolicy(
  new iam.PolicyStatement({
    sid: 'ReadSupabaseE2ESecret',
    actions: ['secretsmanager:GetSecretValue'],
    resources: [`arn:aws:secretsmanager:${region}:${account}:secret:blocks/supabase-e2e-*`],
  }),
);

// ── Outputs ─────────────────────────────────────────────────────────────────

new cdk.CfnOutput(stack, 'RoleArn', {
  value: role.roleArn,
  description: 'Set as the AWS_ROLE_ARN secret of the e2e GitHub environment (and as a Dependabot secret).',
});

cdk.Tags.of(stack).add('blocks:purpose', 'github-e2e-oidc');
cdk.Tags.of(stack).add('blocks:do-not-delete', 'true');

app.synth();
