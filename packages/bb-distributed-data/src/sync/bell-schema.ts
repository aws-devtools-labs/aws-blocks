// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { BellMessage } from './protocol.js';

/** Validates bell messages without a schema library. Shared by the runtime and the CDK layer. */
export const bellSchema: StandardSchemaV1<BellMessage> = {
  '~standard': {
    version: 1,
    vendor: 'aws-blocks',
    validate: (value) =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { t?: unknown }).t === 'number' &&
      ['undefined', 'string'].includes(typeof (value as { k?: unknown }).k)
        ? { value: value as BellMessage }
        : { issues: [{ message: 'Expected { t: number; k?: string }' }] },
  },
};
