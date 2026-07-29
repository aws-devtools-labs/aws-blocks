// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { destroySandbox } from '@aws-blocks/blocks/scripts';

const backendPath = process.argv[2];
await destroySandbox(backendPath);
