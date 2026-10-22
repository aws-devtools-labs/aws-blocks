// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK app for the persistent test VPCs (see vpc-test-stack.ts and README.md).
 * CI deploys the stacks it needs with credentials for the PR's E2E account:
 *
 *   npx cdk deploy BlocksTestVpc
 *   npx cdk deploy BlocksComputeTestVpc BlocksComputeTestVpcEndpoints
 */

import * as cdk from 'aws-cdk-lib';
import { buildTestVpcStacks } from './vpc-test-stack.js';

const app = new cdk.App();
buildTestVpcStacks(app, {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
});
app.synth();
