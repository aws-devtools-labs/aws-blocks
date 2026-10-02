// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * React bindings for AWS Blocks. Needs `react` 18 or later.
 *
 * - `useShape(open, deps)`: keep a component in sync with a live shape from
 *   `Database` or `DistributedDatabase` (`db.shape()`).
 */
export { useShape } from '@aws-blocks/data-common/react';
export type { UseShapeResult } from '@aws-blocks/data-common/react';
