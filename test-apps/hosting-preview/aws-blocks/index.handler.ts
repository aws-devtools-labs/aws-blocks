// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createLambdaHandler } from '@aws-blocks/blocks/lambda-handler';

export const handler = createLambdaHandler(() => import('./index.js'));
