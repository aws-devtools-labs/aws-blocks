// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Destroy every stack the compute-smoke app synthesizes for the leg selected by
 * `COMPUTE_API_FRONT_DOOR` (default cloudfront): the main stack and its vpc-ref
 * lookup stack. Runs the product's own `destroySandbox` (`cdk destroy --all`,
 * the multi-stack sandbox teardown `npm run sandbox:destroy` runs), which reads
 * `COMPUTE_API_FRONT_DOOR` from the environment like the deploy. Run it once per
 * leg you deployed, from the app directory.
 */
import { destroySandbox } from '@aws-blocks/blocks/scripts';

await destroySandbox(process.argv[2]);
