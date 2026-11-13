// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Destroy ALL stacks created by the vpc-smoke app (main + vpc-ref lookup stack)
 * through the product's own `destroySandbox`, which runs `cdk destroy --all`,
 * the multi-stack sandbox teardown that `npm run sandbox:destroy` runs (as in
 * compute-smoke). Run from the app directory.
 */
import { destroySandbox } from '@aws-blocks/blocks/scripts';

await destroySandbox(process.argv[2]);
