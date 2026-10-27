// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { destroy } from '@aws-blocks/blocks/scripts';

const backendPath = process.argv[2];

await destroy({
  cdkAppPath: backendPath,
  projectRoot: process.cwd(),
  // A local run in a terminal must not wait on the multi-stack confirmation.
  force: true,
});
