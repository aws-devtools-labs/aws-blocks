// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// E2E variant: connectionArn comes from a secret() marker, resolved at synth
// time from the default store (Secrets Manager) under the name
// hosting/secrets/CONNECTION_ARN via Pipeline.create().

import * as cdk from 'aws-cdk-lib';
import { Pipeline, secret } from '@aws-blocks/core/cdk';

const app = new cdk.App();

await Pipeline.create(app, 'pipeline-secret-test', {
  appFile: './index.cdk.ts',
  source: {
    repo: 'test-org/test-repo',
    connectionArn: secret('CONNECTION_ARN'),
  },
  branches: [{
    branch: 'main',
    stages: [{ name: 'beta' }],
  }],
});
