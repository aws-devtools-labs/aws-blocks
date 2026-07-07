// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { destroySandbox } from '@aws-blocks/blocks/scripts';

// Keep the path relative: destroySandbox interpolates it unquoted into the
// CDK --app command, so an absolute path containing spaces would split.
const backendPath = process.argv[2] ?? 'aws-blocks/index.cdk.ts';

await destroySandbox(backendPath);
