// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createLambdaHandler } from 'aws-cdk-blocks/lambda-handler';

// Lazy import: the handler loads its injected configuration before the backend
// module (and the Building Blocks it constructs) is evaluated.
export const handler = createLambdaHandler(() => import('./index.js'));