// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Runs `destroy()` for the upgrade-in-place stack. Started by
// ../../upgrade-in-place.ts as a child process (cwd = the app directory).
import { destroy } from '@aws-blocks/blocks/scripts';

await destroy({ cdkAppPath: 'aws-blocks/index.cdk.ts', projectRoot: process.cwd() });
