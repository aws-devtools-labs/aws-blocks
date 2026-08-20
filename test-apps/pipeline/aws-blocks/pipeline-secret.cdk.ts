// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// E2E variant: connectionArn comes from a config() marker, resolved at synth
// time from SSM under /blocks/<stackId>/config/CONNECTION_ARN via Pipeline.create()
// (the core Pipeline scopes the namespace by the app's stackId). A connection ARN
// is a reference, not a credential, and is inlined into the template at synth — so
// it is config(), not secret().

import * as cdk from 'aws-cdk-lib';
import { config, Pipeline } from '@aws-blocks/core/cdk';

const app = new cdk.App();

await Pipeline.create(app, 'pipeline-secret-test', {
  appFile: './index.cdk.ts',
  source: {
    repo: 'test-org/test-repo',
    connectionArn: config('CONNECTION_ARN'),
  },
  branches: [{
    branch: 'main',
    stages: [{ name: 'beta' }],
  }],
});
