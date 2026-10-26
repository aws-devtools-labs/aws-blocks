// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertNotMockInDeployedEnv } from '@aws-blocks/core/bb-utils';

// Fail closed if this MOCK entry is loaded in a deployed environment (the
// artifact was bundled without the `aws-runtime` export condition). No-op
// locally. See assertNotMockInDeployedEnv.
assertNotMockInDeployedEnv('bb-logger');

// Local dev runtime — identical to AWS runtime (both write to stdout/stderr)
export * from './index.aws.js';
