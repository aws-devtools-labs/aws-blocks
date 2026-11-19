// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { openConsole } from 'aws-cdk-blocks/scripts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

openConsole({ 
  outputsFile: join(__dirname, '..', '..', '.cdk-blocks-sandbox', 'outputs.json')
});
