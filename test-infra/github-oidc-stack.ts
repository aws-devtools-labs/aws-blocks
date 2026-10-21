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
 * Deployed by hand from `github-oidc-app.ts` (see README), not by CI. This file
 * only builds the stack, so the trust policy can be unit tested.
 *
 * Resources:
 * - GitHub OIDC identity provider (or an existing one, by ARN)
 * - `blocks-github-e2e` role with the permissions the E2E suites and
 *   cleanup-stacks.yml use
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

export const GITHUB_REPO = 'aws-devtools-labs/aws-blocks';
export const GITHUB_ENVIRONMENT = 'e2e';
// Every E2E workflow and cleanup-stacks.yml run in us-east-1. Pinned so the
// region-scoped ARNs below can't follow the operator's profile elsewhere.
export const E2E_REGION = 'us-east-1';
// Default `cdk bootstrap` qualifier.
const CDK_QUALIFIER = 'hnb659fds';
// Stack/bucket name prefixes the E2E suites deploy and cleanup-stacks.yml
// deletes. `my-app-` is the scaffolded app from windows-template-e2e.mjs.
const E2E_PREFIXES = [
  'bb-telemetry-',
  'bb-test-',
  'bb-vpc-smoke-',
  'blocks-hosting-',
  'blocks-test-',
  'my-app-',
];
// Amplify Gen 2 sandbox stacks (amplify-interop suite). cleanup-stacks.yml
// empties their buckets before deleting them.
const AMPLIFY_SANDBOX_PREFIXES = ['amplify-amplifygen2-', 'amplify-amplifyinteroptest-'];

export interface GithubE2eOidcStackProps {
  account: string;
  // Reuse the account's existing GitHub OIDC provider instead of creating one
  // (it is a per-account singleton).
  oidcProviderArn?: string;
}

export function buildGithubE2eOidcStack(scope: cdk.App, props: GithubE2eOidcStackProps): cdk.Stack {
  const stack = new cdk.Stack(scope, 'BlocksGithubE2eOidc', {
    description: 'GitHub Actions OIDC role for AWS Blocks E2E tests. Deploy only into the dedicated E2E account.',
    env: {
      account: props.account,
      region: E2E_REGION,
    },
  });

  const { account, region } = stack;

  // ── OIDC provider ───────────────────────────────────────────────────────────

  // Native AWS::IAM::OIDCProvider (no custom-resource Lambda). No thumbprints:
  // IAM validates GitHub's endpoint against its trusted CA library.
  const provider = props.oidcProviderArn
    ? iam.OidcProviderNative.fromOidcProviderArn(stack, 'GithubOidcProvider', props.oidcProviderArn)
    : new iam.OidcProviderNative(stack, 'GithubOidcProvider', {
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

  // CDK deploys go through the bootstrap roles. Not cfn-exec: only
  // CloudFormation assumes it (deploy-role passes it).
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'CdkBootstrapRoles',
      actions: ['sts:AssumeRole'],
      resources: ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(
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
      resources: [...E2E_PREFIXES, ...AMPLIFY_SANDBOX_PREFIXES].flatMap((p) => [
        `arn:aws:s3:::${p}*`,
        `arn:aws:s3:::${p}*/*`,
      ]),
    }),
  );

  // cleanup-stacks.yml sweeps that keep account quotas in check: orphaned REST
  // APIs (120 EDGE APIs), API Gateway CloudWatch roles (3000 roles) and
  // CloudFront response headers policies. Its calls swallow errors, so a missing
  // grant here shows up as an empty sweep, not a failed job.
  // These list calls have no resource-level scoping; '*' is the only valid resource.
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'CleanupList',
      actions: ['cloudfront:ListResponseHeadersPolicies', 'ec2:DescribeRegions', 'iam:ListRoles'],
      resources: ['*'],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'CleanupRestApis',
      actions: ['apigateway:GET', 'apigateway:DELETE'],
      resources: [`arn:aws:apigateway:${region}::/restapis`, `arn:aws:apigateway:${region}::/restapis/*`],
    }),
  );
  // The CloudWatch role sweep reads the API Gateway account setting in every region.
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'CleanupApiGatewayAccount',
      actions: ['apigateway:GET'],
      resources: ['arn:aws:apigateway:*::/account'],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'CleanupApiGatewayCloudWatchRoles',
      actions: ['iam:DeleteRole', 'iam:DetachRolePolicy', 'iam:ListAttachedRolePolicies', 'iam:ListRolePolicies'],
      resources: E2E_PREFIXES.map((p) => `arn:aws:iam::${account}:role/${p}*`),
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'CleanupResponseHeadersPolicies',
      actions: ['cloudfront:DeleteResponseHeadersPolicy', 'cloudfront:GetResponseHeadersPolicy'],
      resources: [`arn:aws:cloudfront::${account}:response-headers-policy/*`],
    }),
  );

  // Test harness calls against the deployed test apps.
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: 'CognitoE2eAdmin',
      actions: [
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:AdminSetUserPassword',
      ],
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

  return stack;
}
