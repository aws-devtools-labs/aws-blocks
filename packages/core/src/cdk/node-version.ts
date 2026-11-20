// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Runtime } from 'aws-cdk-lib/aws-lambda';

/**
 * The single source of truth for the Node.js Lambda runtime used by CDK Blocks'
 * own Lambda functions and every Building Block. Set every
 * `aws_lambda.Function` / `NodejsFunction` runtime to this constant rather
 * than hardcoding `Runtime.NODEJS_*_X`, so the whole framework moves in
 * lockstep when the runtime is bumped.
 *
 * Currently the latest Active LTS. This controls only the AWS-managed
 * runtime that executes deployed handlers; it is independent of the Node
 * version a consumer runs the CLI / CDK synth on.
 */
export const DEFAULT_NODE_RUNTIME = Runtime.NODEJS_24_X;
