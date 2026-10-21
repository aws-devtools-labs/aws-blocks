// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The trust policy is the only gate on blocks-github-e2e, so pin its exact
// shape: a widened condition must fail here, not slip through as a one-liner.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildGithubE2eOidcStack, E2E_REGION, GITHUB_ENVIRONMENT, GITHUB_REPO } from './github-oidc-stack.js';

const ACCOUNT = '111111111111';

function synth(oidcProviderArn?: string) {
  const stack = buildGithubE2eOidcStack(new cdk.App(), { account: ACCOUNT, oidcProviderArn });
  const template = Template.fromStack(stack);
  const roles = Object.values(template.findResources('AWS::IAM::Role'));
  assert.equal(roles.length, 1);
  return { stack, template, role: roles[0] };
}

describe('BlocksGithubE2eOidc', () => {
  test('trust policy is exactly the e2e environment of this repo', () => {
    const { role } = synth();
    const statements = role.Properties.AssumeRolePolicyDocument.Statement;
    assert.equal(statements.length, 1);
    const [statement] = statements;
    assert.equal(statement.Effect, 'Allow');
    assert.equal(statement.Action, 'sts:AssumeRoleWithWebIdentity');
    assert.deepEqual(statement.Condition, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': `repo:${GITHUB_REPO}:environment:${GITHUB_ENVIRONMENT}`,
      },
    });
  });

  test('trust policy has no wildcard operators', () => {
    const { role } = synth();
    const trust = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
    assert.doesNotMatch(trust, /StringLike|ForAnyValue|ForAllValues|\*/);
  });

  test('is pinned to the E2E region', () => {
    const { stack } = synth();
    assert.equal(stack.region, E2E_REGION);
  });

  test('creates the OIDC provider by default', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
  });

  test('reuses an existing OIDC provider when given its ARN', () => {
    const arn = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
    const { template, role } = synth(arn);
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    assert.equal(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Federated, arn);
  });
});
