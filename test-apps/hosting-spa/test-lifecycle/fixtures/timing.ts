// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

/**
 * Timings for the fixture runs. The defaults keep `npm test` fast: the stand-in
 * "deploy" blocks for longer than the test timeout, which is all that matters.
 * `LIFECYCLE_REAL_TIMING=1` uses the hosting apps' real 60s test timeout and a
 * 65s deploy (expect ~5 min for the whole check).
 */
const real = !!process.env.LIFECYCLE_REAL_TIMING;
export const TEST_TIMEOUT_MS = real ? 60_000 : 1_000;
export const DEPLOY_BLOCK_S = real ? '65' : '3';

/** Record a lifecycle event (deploy / destroy / test attempt) for the check to count. */
export function record(event: string): void {
  const file = process.env.LIFECYCLE_EVENTS;
  if (!file) throw new Error('LIFECYCLE_EVENTS is not set');
  appendFileSync(file, `${event}\n`);
}

/** A short fingerprint of this process's test-support secret (never the value), or `none`. */
export function secretFingerprint(): string {
  const value = process.env.BLOCKS_TEST_SUPPORT_SECRET;
  if (!value) return 'none';
  return `${/^[0-9a-f]{64}$/.test(value) ? 'hex64' : 'other'}:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}
