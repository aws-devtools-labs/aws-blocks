// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-synth secret staging for the `copyFrom` deploy mechanism.
 *
 * The database connection string cannot be passed to CloudFormation as a literal
 * (it would be readable via `GetTemplate`), and the final, stack-scoped parameter
 * name is only known during synth. So the orchestrator writes the value to a
 * **throwaway staging parameter** whose name it fully controls, and passes that
 * name into the CDK app. An in-stack copy custom resource then reads the staging
 * parameter and writes the value into the final parameter during deployment, and
 * deletes the staging parameter afterwards (see `registerCopyFrom` in
 * `@aws-blocks/bb-app-setting`).
 *
 * The staging name is minted **once** here (a random UUID) and passed explicitly
 * via `process.env.BLOCKS_DB_STAGING_PARAM`. It is never derived from the value,
 * so the write side and the read side cannot diverge.
 */
import { randomUUID } from 'node:crypto';
import { findConnectionString, withRetry } from './ensure-secrets.js';

/** Path prefix for staging parameters. Sweepable so orphans can be reaped. */
export const STAGING_PARAM_PREFIX = '/awsBlocksStagingSecret/';

/** Env var the CDK app reads to discover the staging parameter at synth. */
export const STAGING_ENV_VAR = 'BLOCKS_DB_STAGING_PARAM';

/** Default orphan age before the sweep reaps a leftover staging parameter. */
const DEFAULT_ORPHAN_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export interface StagedSecret {
  /** The staging SSM parameter name the value was written to. */
  stagingParameterName: string;
}

/**
 * Mint a unique staging parameter name and write the connection string found in
 * the environment to it as a SecureString. Returns the staging name, or `null`
 * when there is no connection string in the environment (a no-op for apps with
 * no external DB).
 *
 * The name is unique per call (UUID), so the write uses `Overwrite: false`.
 * Transient SSM errors are retried with backoff.
 */
export async function stageConnectionString(): Promise<StagedSecret | null> {
  const conn = findConnectionString();
  if (!conn) return null;

  const stagingParameterName = `${STAGING_PARAM_PREFIX}${randomUUID()}`;

  const { SSMClient, PutParameterCommand } = await import('@aws-sdk/client-ssm');
  const client = new SSMClient();

  await withRetry(() => client.send(new PutParameterCommand({
    Name: stagingParameterName,
    Value: conn.value,
    Type: 'SecureString',
    Overwrite: false,
    Tags: [{ Key: 'aws-blocks-staging', Value: 'db-connection-string' }],
  })));

  return { stagingParameterName };
}

/**
 * Best-effort reaping of orphaned staging parameters from prior failed deploys.
 *
 * On a successful deploy the copy custom resource deletes the staging parameter.
 * A deploy that fails or rolls back before the copy runs can leave one behind.
 * This sweep deletes staging parameters older than `maxAgeMs`. It never throws —
 * a failure here must not block a deploy — and returns the count deleted.
 */
export async function sweepOrphanStagingParams(maxAgeMs = DEFAULT_ORPHAN_MAX_AGE_MS): Promise<number> {
  try {
    const { SSMClient, GetParametersByPathCommand, DeleteParameterCommand } =
      await import('@aws-sdk/client-ssm');
    const client = new SSMClient();
    const cutoff = Date.now() - maxAgeMs;

    let nextToken: string | undefined;
    let deleted = 0;
    do {
      const res = await client.send(new GetParametersByPathCommand({
        Path: STAGING_PARAM_PREFIX,
        Recursive: true,
        NextToken: nextToken,
      }));
      for (const p of res.Parameters ?? []) {
        const modified = p.LastModifiedDate ? p.LastModifiedDate.getTime() : Date.now();
        if (p.Name && modified < cutoff) {
          try {
            await client.send(new DeleteParameterCommand({ Name: p.Name }));
            deleted++;
          } catch { /* best-effort */ }
        }
      }
      nextToken = res.NextToken;
    } while (nextToken);
    return deleted;
  } catch {
    return 0; // best-effort — never block a deploy
  }
}
