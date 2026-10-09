// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { record } from '../timing.js';

export default function globalTeardown(): void {
  record('destroy');
}
