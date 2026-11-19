// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Realistic CDK backend for pipeline synth test.
// Exercises the full BlocksStack import path with actual Building Blocks.

import { Scope, RawRoute } from '@aws-blocks/core/cdk';

const scope = new Scope('pipeline-app');

// RawRoute — exercises a real Building Block that registers CDK-time constructs
new RawRoute(scope, 'health', {
  method: 'GET',
  path: '/health',
  handler: async (context) => {
    context.response.send({ status: 'ok' });
  },
});

new RawRoute(scope, 'version', {
  method: 'GET',
  path: '/version',
  handler: async (context) => {
    context.response.send({ version: '1.0.0' });
  },
});
