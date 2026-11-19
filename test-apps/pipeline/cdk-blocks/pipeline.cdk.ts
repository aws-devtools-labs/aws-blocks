// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Pipeline } from '@aws-blocks/core/cdk';

const app = new cdk.App();

await Pipeline.create(app, 'pipeline-synth-test', {
  appFile: './index.cdk.ts',
  source: {
    repo: 'test-org/test-repo',
    connectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  },
  branches: [{
    branch: 'main',
    stages: [
      { name: 'beta' },
    ],
  }],
});
