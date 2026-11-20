// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { destroySandbox } from 'aws-cdk-blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendPath = join(__dirname, '..', 'cdk-blocks', 'index.cdk.ts');

await destroySandbox(backendPath);
