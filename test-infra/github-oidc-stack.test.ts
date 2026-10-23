// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The trust policies are the only gate on blocks-github-e2e and
// blocks-github-bench, so pin their exact shape: a widened condition must fail
// here, not slip through as a one-liner.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  BENCH_GITHUB_ENVIRONMENT,
  buildGithubE2eOidcStack,
  E2E_REGION,
  GITHUB_ENVIRONMENT,
  GITHUB_REPO,
} from './github-oidc-stack.js';

const ACCOUNT = '111111111111';

function synth({ oidcProviderArn, agentBench = false }: { oidcProviderArn?: string; agentBench?: boolean } = {}) {
  const stack = buildGithubE2eOidcStack(new cdk.App(), { account: ACCOUNT, oidcProviderArn, agentBench });
  const template = Template.fromStack(stack);
  const roles = Object.values(template.findResources('AWS::IAM::Role'));
  assert.equal(roles.length, agentBench ? 2 : 1);
  const byName = (name: string) => roles.filter((r) => r.Properties.RoleName === name);
  const [role] = byName('blocks-github-e2e');
  const [benchRole] = byName('blocks-github-bench');
  assert.ok(role);
  return { stack, template, role, benchRole };
}

function assertTrustIsExactly(role: ReturnType<typeof synth>['role'], environment: string) {
  const statements = role.Properties.AssumeRolePolicyDocument.Statement;
  assert.equal(statements.length, 1);
  const [statement] = statements;
  assert.equal(statement.Effect, 'Allow');
  assert.equal(statement.Action, 'sts:AssumeRoleWithWebIdentity');
  assert.deepEqual(statement.Condition, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': `repo:${GITHUB_REPO}:environment:${environment}`,
    },
  });
}

describe('BlocksGithubE2eOidc', () => {
  test('E2E role trust policy is exactly the e2e environment of this repo', () => {
    assertTrustIsExactly(synth().role, GITHUB_ENVIRONMENT);
  });

  test('bench role trust policy is exactly the agent-bench environment of this repo', () => {
    assertTrustIsExactly(synth({ agentBench: true }).benchRole, BENCH_GITHUB_ENVIRONMENT);
  });

  // A token from one environment must not assume the other environment's role.
  test('E2E and bench roles trust different environments', () => {
    assert.notEqual(GITHUB_ENVIRONMENT, BENCH_GITHUB_ENVIRONMENT);
    const { role, benchRole } = synth({ agentBench: true });
    assert.notDeepEqual(
      role.Properties.AssumeRolePolicyDocument.Statement[0].Condition,
      benchRole.Properties.AssumeRolePolicyDocument.Statement[0].Condition,
    );
  });

  test('trust policies have no wildcard operators', () => {
    const { role, benchRole } = synth({ agentBench: true });
    for (const r of [role, benchRole]) {
      const trust = JSON.stringify(r.Properties.AssumeRolePolicyDocument);
      assert.doesNotMatch(trust, /StringLike|ForAnyValue|ForAllValues|\*/);
    }
  });

  // Every pool account runs this stack; only account 1 opts into the bench.
  test('adds no bench role or bucket by default', () => {
    const { template, benchRole } = synth();
    assert.equal(benchRole, undefined);
    template.resourceCountIs('AWS::S3::Bucket', 0);
  });

  test('is pinned to the E2E region', () => {
    const { stack } = synth();
    assert.equal(stack.region, E2E_REGION);
  });

  test('creates the OIDC provider by default', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
  });

  // The log-group sweep may delete only log groups of test functions and DB
  // clusters, never any other group in the account.
  test('log-group deletes are scoped to test-prefixed Lambda and RDS groups', () => {
    const { template } = synth();
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (p) => p.Properties.PolicyDocument.Statement,
    );
    const deletes = statements.filter((s) => [s.Action].flat().includes('logs:DeleteLogGroup'));
    assert.equal(deletes.length, 1);
    const resources = [deletes[0].Resource].flat().map((r) => JSON.stringify(r));
    assert.ok(resources.length > 0);
    for (const r of resources) {
      assert.match(r, /^"arn:aws:logs:us-east-1:111111111111:log-group:\/aws\/(lambda|rds\/cluster)\/(amplify-amplify|bb-|blocks-)[a-z0-9-]+\*"$/);
    }
    assert.equal([deletes[0].Action].flat().length, 1, 'no other action rides on the scoped resources');
  });

  test('the log-group sweep may only list, not change, anything else', () => {
    const { template } = synth();
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (p) => p.Properties.PolicyDocument.Statement,
    );
    const list = statements.filter((s) => s.Sid === 'CleanupLogGroupsList');
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].Action].flat().sort(), ['lambda:ListFunctions', 'logs:DescribeLogGroups', 'rds:DescribeDBClusters']);
  });

  test('reuses an existing OIDC provider when given its ARN', () => {
    const arn = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
    const { template, role, benchRole } = synth({ oidcProviderArn: arn, agentBench: true });
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    assert.equal(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Federated, arn);
    assert.equal(benchRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.Federated, arn);
  });
});

describe('blocks-github-e2e cleanup grants', () => {
  // The leftover-table report only needs to know whether a table still exists.
  test('reads Amplify sandbox tables with DescribeTable only', () => {
    const { template } = synth();
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (p) => p.Properties.PolicyDocument.Statement,
    );
    const dynamodb = statements.filter((s) => [s.Action].flat().some((a: string) => a.startsWith('dynamodb:')));
    assert.equal(dynamodb.length, 1);
    assert.equal(dynamodb[0].Sid, 'CleanupLeftoverAmplifyTables');
    assert.equal(dynamodb[0].Action, 'dynamodb:DescribeTable');
    assert.equal(dynamodb[0].Resource, `arn:aws:dynamodb:${E2E_REGION}:${ACCOUNT}:table/*-NONE`);
  });
});
