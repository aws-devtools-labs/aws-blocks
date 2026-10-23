// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Destroy ALL stacks created by the compute-smoke app (main + vpc-ref lookup
 * stack) through the product's own `destroySandbox`, which runs
 * `cdk destroy --all`. That keeps a real AWS check of the multi-stack sandbox
 * teardown that `npm run sandbox:destroy` runs. Run from the app directory.
 */
import { destroySandbox } from '@aws-blocks/blocks/scripts';

await destroySandbox(process.argv[2]);
