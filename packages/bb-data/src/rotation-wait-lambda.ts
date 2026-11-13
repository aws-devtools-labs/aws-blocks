// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DescribeSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { ROTATION_WAIT_MAX_MS } from './constants.js';

// Bound on the wait: a rotation that cannot reach Secrets Manager never finishes
// (see the `blocks:vpc:endpoint-client-unadmitted` warning) and must not fail the
// deploy. Shared with the CDK layer, which sizes this function's own timeout from
// it, so the function cannot be killed mid-poll.
const MAX_WAIT_MS = ROTATION_WAIT_MAX_MS;
const POLL_INTERVAL_MS = 5000;
// The wait's own budget, because the two ways of being wrong are not symmetric:
// too small misses the deploy's own rotation and reports `Rotated: false` on a
// healthy deploy, while too large lets a second deploy return on the first one's
// rotation, which leaves only the transient the engine retries.
export const RECENT_MS = ROTATION_WAIT_MAX_MS;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface SecretRotationState {
  lastRotatedDate?: Date;
  versionIdsToStages?: Record<string, string[]>;
}

/** The version id staged `AWSCURRENT`, which a finished rotation replaces. */
const currentVersionId = (state: SecretRotationState): string | undefined =>
  Object.entries(state.versionIdsToStages ?? {}).find(([, s]) => s.includes('AWSCURRENT'))?.[0];

/** True while a version other than `AWSCURRENT` is staged `AWSPENDING`. */
const rotationInFlight = (state: SecretRotationState): boolean =>
  Object.values(state.versionIdsToStages ?? {}).some(
    (stages) => stages.includes('AWSPENDING') && !stages.includes('AWSCURRENT'),
  );

/**
 * True once a rotation has finished after `since`: the secret's last rotation
 * is no older than `since` and no version is staged `AWSPENDING` without also
 * being `AWSCURRENT`. After a successful rotation `AWSPENDING` is either on the
 * `AWSCURRENT` version or on no version; on any other version it marks a
 * rotation still in progress (Secrets Manager's documented contract).
 */
export const isRotationComplete = (state: SecretRotationState, since: number): boolean => {
  if (!state.lastRotatedDate || state.lastRotatedDate.getTime() < since) return false;
  return !rotationInFlight(state);
};

/**
 * Poll `describe` until this deploy's rotation has finished or `maxWaitMs`
 * elapses. Resolves `true` when it finished, `false` on timeout; never throws
 * for a slow rotation, so the deploy outcome is decided by the stack, not the
 * wait.
 *
 * Identity comes from the `AWSCURRENT` version id moving off the one seen on
 * the first read, which no earlier rotation can satisfy. `recentMs` covers only
 * the case that check cannot see, a rotation that finished before the first
 * read; returning early there leaves a first query that can hit the password
 * gap, which `DataApiEngine` retries.
 */
export const waitForRotation = async (
  describe: () => Promise<SecretRotationState>,
  {
    maxWaitMs = MAX_WAIT_MS,
    pollIntervalMs = POLL_INTERVAL_MS,
    recentMs = RECENT_MS,
    now = Date.now,
    sleep = defaultSleep,
  } = {},
): Promise<boolean> => {
  const since = now() - recentMs;
  const deadline = now() + maxWaitMs;
  let startVersion: string | undefined;
  let first = true;
  for (;;) {
    // A failed read is not a failed rotation: a throttle, a transient
    // AccessDenied while the role's policy settles, or a read that lags the
    // write would otherwise escape and fail the deploy this wait exists to
    // protect. Log it and keep polling until the deadline.
    try {
      const state = await describe();
      if (first) {
        first = false;
        startVersion = currentVersionId(state);
        // Finished before this read, so only `recentMs` can place it.
        if (isRotationComplete(state, since)) return true;
      } else if (startVersion === undefined) {
        // With no baseline to move off, the version that was always current
        // would otherwise read as movement, so recency decides until a version
        // id appears to adopt.
        if (isRotationComplete(state, since)) return true;
        startVersion = currentVersionId(state);
      } else if (
        !rotationInFlight(state) &&
        currentVersionId(state) !== undefined &&
        currentVersionId(state) !== startVersion
      ) {
        return true;
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(`[rotation-wait-lambda] DescribeSecret failed; still waiting: ${reason}`);
    }
    if (now() >= deadline) return false;
    await sleep(pollIntervalMs);
  }
};

/**
 * The resource's attributes. Reported rather than only logged so a test can
 * assert a rotation finished; the deploy succeeds either way, so this is
 * evidence, not a gate.
 */
export const rotationOutcome = (
  rotated: 'true' | 'false',
  lastRotatedDate?: Date,
): { Rotated: string; LastRotatedDate: string } => ({
  Rotated: rotated,
  LastRotatedDate: lastRotatedDate?.toISOString() ?? '',
});

/**
 * CloudFormation custom resource handler that holds the deploy until the rotation
 * started by creating the RotationSchedule (or changing its interval) has made the
 * new password the secret's current version. Without it `cdk deploy` returns while
 * the cluster already accepts the new password and the secret still holds the old
 * one, and a first query in that window fails.
 */
export const handler = async (
  event: CloudFormationCustomResourceEvent,
): Promise<{ PhysicalResourceId: string; Data?: { Rotated: string; LastRotatedDate: string } }> => {
  console.log('[rotation-wait-lambda] Event:', JSON.stringify({
    RequestType: event.RequestType,
    intervalDays: event.ResourceProperties?.intervalDays,
  }));

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId || 'rotation-wait' };
  }

  const secretArn = process.env.SECRET_ARN;
  if (!secretArn) throw new Error('Missing env: SECRET_ARN is required');
  // Bounded so one slow `DescribeSecret` cannot spend the poll budget before the
  // loop re-checks its deadline. `maxAttempts: 2` because the poll loop is
  // already the retry: stacking the SDK's backoff on top of it would make a
  // single slow call cost several polls.
  const client = new SecretsManagerClient({
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, requestTimeout: 3000 },
  });
  const startedAt = Date.now();
  let lastRotatedDate: Date | undefined;
  const complete = await waitForRotation(async () => {
    const out = await client.send(new DescribeSecretCommand({ SecretId: secretArn }));
    lastRotatedDate = out.LastRotatedDate;
    return { lastRotatedDate: out.LastRotatedDate, versionIdsToStages: out.VersionIdsToStages };
  });
  console.log(
    '[rotation-wait-lambda] Result:',
    JSON.stringify({
      rotated: complete,
      lastRotatedDate: lastRotatedDate?.toISOString(),
      waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
      budgetSeconds: MAX_WAIT_MS / 1000,
    }),
  );
  return {
    PhysicalResourceId: 'rotation-wait',
    Data: rotationOutcome(complete ? 'true' : 'false', lastRotatedDate),
  };
};
