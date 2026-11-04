// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertNotMockInDeployedEnv } from '@aws-blocks/core/bb-utils';

// Fail closed if this mock entry loads in a deployed env — see assertNotMockInDeployedEnv.
assertNotMockInDeployedEnv('bb-logger');

// Local dev runtime — identical to AWS runtime (both write to stdout/stderr)
export * from './index.aws.js';
