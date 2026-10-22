// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { startSandbox } from '@aws-blocks/blocks/scripts';

const backendPath = process.argv[2];

// No stale-stack pre-destroy here. This app has two stacks (main + vpc-ref),
// so destroySandbox (a single-stack `cdk destroy`) always failed and burned its
// retry backoff. In CI it could never match anyway: the stack name carries a
// random id that each fresh checkout regenerates (aws-blocks/index.cdk.ts)
// plus a BLOCKS_STACK_SUFFIX with the run attempt. Locally, a leftover stack is
// updated in place by the `cdk deploy --all` below; if it is stuck in a failed
// state, remove it with `npx tsx test/sandbox-destroy.ts aws-blocks/index.cdk.ts`
// (`cdk destroy --all`, same VPC_TEST_VPC_ID / BLOCKS_STACK_SUFFIX as the
// deploy), which is also the teardown the test's after hook runs.
await startSandbox({ backendPath, deployOnly: true });
