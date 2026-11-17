// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Runs `deploy()` from the CHECKOUT this file was materialized into, so the
// pre-refactor revision is deployed with its own deploy tooling. Started by
// ../../upgrade-in-place.ts as a child process (cwd = the app directory).
import { deploy } from '@aws-blocks/blocks/scripts';

await deploy({ cdkAppPath: 'aws-blocks/index.cdk.ts', projectRoot: process.cwd() });
