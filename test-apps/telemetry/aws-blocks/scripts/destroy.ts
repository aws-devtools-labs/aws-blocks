// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { destroy } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

destroy({
  cdkAppPath: join(__dirname, '..', 'index.ts'),
  projectRoot: join(__dirname, '..', '..'),
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
