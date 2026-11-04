// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { startSandbox } from '@aws-blocks/blocks/scripts';

const backendPath = process.argv[2];

// No stale-stack pre-destroy here: in CI it could never match. The stack name
// carries a random id that each fresh checkout regenerates
// (aws-blocks/index.cdk.ts) plus a BLOCKS_STACK_SUFFIX with the run attempt, so
// the target was always the stack this run is about to create. (It also never succeeded: with two stacks
// and no `--all`, CDK refused, burning ~220 s of retry backoff.) Locally, a
// leftover stack is updated in place by the `cdk deploy --all` below; if it is
// stuck in a failed state, remove it with
// `npx tsx test/sandbox-destroy.ts aws-blocks/index.cdk.ts`
// (`cdk destroy --all`, same VPC_TEST_VPC_ID / BLOCKS_STACK_SUFFIX as the
// deploy), which is also the teardown the test's after hook runs.
await startSandbox({ backendPath, deployOnly: true });
