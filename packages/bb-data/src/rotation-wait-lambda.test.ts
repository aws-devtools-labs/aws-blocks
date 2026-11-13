// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import type { CloudFormationCustomResourceDeleteEvent } from 'aws-lambda';
import { ROTATION_WAIT_MAX_MS } from './constants.js';
import {
  RECENT_MS,
  handler,
  isRotationComplete,
  rotationOutcome,
  type SecretRotationState,
  waitForRotation,
} from './rotation-wait-lambda.js';

test('rotation-wait handler returns early on Delete event', async () => {
  const event: Partial<CloudFormationCustomResourceDeleteEvent> = {
    RequestType: 'Delete',
    PhysicalResourceId: 'rotation-wait-abc',
  };
  const result = await handler(event as CloudFormationCustomResourceDeleteEvent);
  assert.strictEqual(result.PhysicalResourceId, 'rotation-wait-abc');
});

const T = 1_000_000;

test('a secret that has never rotated is not complete', () => {
  assert.strictEqual(isRotationComplete({ versionIdsToStages: { a: ['AWSCURRENT'] } }, T), false);
});

test('a rotation older than since is not complete', () => {
  assert.strictEqual(
    isRotationComplete({ lastRotatedDate: new Date(T - 1), versionIdsToStages: { a: ['AWSCURRENT', 'AWSPENDING'] } }, T),
    false,
  );
});

test('a version staged AWSPENDING only is not complete', () => {
  assert.strictEqual(
    isRotationComplete({ lastRotatedDate: new Date(T), versionIdsToStages: { a: ['AWSCURRENT'], b: ['AWSPENDING'] } }, T),
    false,
  );
});

test('AWSPENDING on the AWSCURRENT version is complete', () => {
  const state: SecretRotationState = {
    lastRotatedDate: new Date(T),
    versionIdsToStages: { a: ['AWSPREVIOUS'], b: ['AWSCURRENT', 'AWSPENDING'] },
  };
  assert.strictEqual(isRotationComplete(state, T), true);
});

test('AWSPENDING on no version is complete', () => {
  assert.strictEqual(
    isRotationComplete({ lastRotatedDate: new Date(T), versionIdsToStages: { a: ['AWSPREVIOUS'], b: ['AWSCURRENT'] } }, T),
    true,
  );
});

test('waitForRotation polls until complete', async () => {
  const states: SecretRotationState[] = [
    { versionIdsToStages: { a: ['AWSCURRENT'] } },
    { versionIdsToStages: { a: ['AWSCURRENT'], b: ['AWSPENDING'] } },
    { lastRotatedDate: new Date(T), versionIdsToStages: { a: ['AWSPREVIOUS'], b: ['AWSCURRENT', 'AWSPENDING'] } },
  ];
  let calls = 0;
  const slept: number[] = [];
  const done = await waitForRotation(async () => states[calls++], {
    maxWaitMs: 60_000,
    pollIntervalMs: 5,
    recentMs: 10,
    now: () => T,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.strictEqual(done, true);
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(slept, [5, 5]);
});

test('waitForRotation resolves false instead of throwing once maxWaitMs elapses', async () => {
  let t = 0;
  const done = await waitForRotation(async () => ({ versionIdsToStages: { a: ['AWSCURRENT'], b: ['AWSPENDING'] } }), {
    maxWaitMs: 10,
    pollIntervalMs: 5,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  assert.strictEqual(done, false);
});

test('waitForRotation keeps polling when a read fails', async () => {
  // A throttle or a transient AccessDenied must not escape: it would fail the
  // deploy this wait exists to protect.
  let calls = 0;
  const done = await waitForRotation(
    async () => {
      calls++;
      if (calls === 1) throw new Error('Rate exceeded');
      return { lastRotatedDate: new Date(T), versionIdsToStages: { a: ['AWSCURRENT', 'AWSPENDING'] } };
    },
    { maxWaitMs: 60_000, pollIntervalMs: 5, recentMs: 10, now: () => T, sleep: async () => {} },
  );
  assert.strictEqual(done, true);
  assert.strictEqual(calls, 2);
});

test('waitForRotation resolves false when every read fails', async () => {
  let t = 0;
  const done = await waitForRotation(
    async () => {
      throw new Error('AccessDeniedException');
    },
    {
      maxWaitMs: 10,
      pollIntervalMs: 5,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    },
  );
  assert.strictEqual(done, false);
});

test('rotationOutcome reports the rotation as resource attributes', () => {
  const rotatedAt = new Date('2026-11-10T12:00:00.000Z');
  assert.deepStrictEqual(rotationOutcome('true', rotatedAt), {
    Rotated: 'true',
    LastRotatedDate: rotatedAt.toISOString(),
  });
  assert.deepStrictEqual(rotationOutcome('false'), { Rotated: 'false', LastRotatedDate: '' });
});

test("waitForRotation waits for this deploy's rotation, not an earlier one", async () => {
  // The reason identity is not left to a time window: an earlier rotation that
  // finished just outside it must not satisfy this wait.
  const stale = new Date(T - 60_000);
  let polls = 0;
  let t = T;
  const done = await waitForRotation(
    async (): Promise<SecretRotationState> => {
      polls++;
      // An earlier rotation left v1 current; this deploy's rotation stages v2
      // and promotes it on the third read.
      if (polls < 3) return { lastRotatedDate: stale, versionIdsToStages: { v1: ['AWSCURRENT'] } };
      return { lastRotatedDate: new Date(t), versionIdsToStages: { v2: ['AWSCURRENT'] } };
    },
    {
      maxWaitMs: 60_000,
      pollIntervalMs: 5,
      recentMs: 20_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    },
  );
  assert.strictEqual(done, true);
  assert.strictEqual(polls, 3, 'returned on the version change, not on the first read');
});

test('the recency window is the wait\'s own budget', () => {
  // Tied to the budget, not a measurement: too small and the wait misses the
  // deploy's own rotation and reports `Rotated: false` on a healthy deploy.
  assert.strictEqual(RECENT_MS, ROTATION_WAIT_MAX_MS);
});

test('waitForRotation needs the current version to move, not just a fresh date', async () => {
  // Once a baseline exists, a recent last-rotation date on a version that never
  // changed is somebody else's rotation. Accepting it is what let a second
  // deploy return on the first one's rotation.
  let polls = 0;
  let t = T;
  const done = await waitForRotation(
    async (): Promise<SecretRotationState> => {
      polls++;
      // First read: a rotation is in flight, so v1 is the baseline.
      if (polls === 1) {
        return {
          lastRotatedDate: new Date(T - 60_000),
          versionIdsToStages: { v1: ['AWSCURRENT'], v2: ['AWSPENDING'] },
        };
      }
      // Then: nothing pending and a fresh date, but v1 is still current.
      return { lastRotatedDate: new Date(t), versionIdsToStages: { v1: ['AWSCURRENT'] } };
    },
    {
      maxWaitMs: 30,
      pollIntervalMs: 10,
      recentMs: 20_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    },
  );
  assert.strictEqual(done, false, "an unchanged current version is not this deploy's rotation");
});

test('waitForRotation does not take an unstaged first read as a baseline', async () => {
  // A read that stages no version gives nothing to move off, so the version
  // that was always current would otherwise look like it had just appeared and
  // report a rotation nobody ran.
  let polls = 0;
  let t = T;
  const done = await waitForRotation(
    async (): Promise<SecretRotationState> => {
      polls++;
      if (polls === 1) return {};
      return { lastRotatedDate: new Date(0), versionIdsToStages: { v1: ['AWSCURRENT'] } };
    },
    {
      maxWaitMs: 30,
      pollIntervalMs: 10,
      recentMs: 20_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    },
  );
  assert.strictEqual(done, false, 'a version appearing after an unstaged read is not a rotation');
});

test('waitForRotation still accepts a real rotation after an unstaged first read', async () => {
  // The other direction: once a rotation genuinely lands, its fresh date has to
  // carry it, since the unstaged read left no baseline to compare against.
  let polls = 0;
  let t = T;
  const done = await waitForRotation(
    async (): Promise<SecretRotationState> => {
      polls++;
      if (polls === 1) return {};
      return { lastRotatedDate: new Date(T - 1_000), versionIdsToStages: { v2: ['AWSCURRENT'] } };
    },
    {
      maxWaitMs: 30,
      pollIntervalMs: 10,
      recentMs: 20_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    },
  );
  assert.strictEqual(done, true, 'a rotation inside the window counts without a baseline');
});

test('waitForRotation accepts a rotation that finished just before the first read', async () => {
  // The one case the version check cannot see, so `recentMs` places it.
  const done = await waitForRotation(
    async () => ({ lastRotatedDate: new Date(T - 2000), versionIdsToStages: { v2: ['AWSCURRENT'] } }),
    { maxWaitMs: 60_000, pollIntervalMs: 5, recentMs: 20_000, now: () => T, sleep: async () => {} },
  );
  assert.strictEqual(done, true);
});

test('waitForRotation keeps waiting while a version is still AWSPENDING', async () => {
  let polls = 0;
  let t = T;
  const done = await waitForRotation(
    async (): Promise<SecretRotationState> => {
      polls++;
      if (polls < 3) {
        return {
          lastRotatedDate: new Date(T - 60_000),
          versionIdsToStages: { v1: ['AWSCURRENT'], v2: ['AWSPENDING'] },
        };
      }
      return { lastRotatedDate: new Date(t), versionIdsToStages: { v2: ['AWSCURRENT'] } };
    },
    {
      maxWaitMs: 60_000,
      pollIntervalMs: 5,
      recentMs: 20_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    },
  );
  assert.strictEqual(done, true);
  assert.strictEqual(polls, 3);
});
