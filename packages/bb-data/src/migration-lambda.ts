// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { runMigrations, loadMigrationsFromDir } from '@aws-blocks/data-common';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { DataApiEngine } from './engines/data-api-engine.js';
import { DatabaseErrors, TRANSIENT_DATA_API_ERROR_NAMES } from './errors.js';

// Set by the CDK construct's environment config. Default is the Lambda deployment root
// where CDK's afterBundling hook copies the .sql files.
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || '/var/task/migrations';
const MAX_RETRIES = 8;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

/**
 * True when the error means "the cluster isn't accepting statements yet" rather
 * than "the statement is wrong" — i.e. waiting and retrying may succeed.
 *
 * Covers both a freshly created cluster whose writer isn't up and a
 * `minCapacity: 0` (scale-to-zero) cluster resuming from auto-pause.
 *
 * `DataApiEngine` re-tags the error to a `DatabaseErrors` name (a branded error
 * with a stable BB message so no raw driver text crosses the RPC wire), keeping
 * the raw SDK error as `cause`. So `ConnectionFailed` matches on the re-tagged
 * name, while the raw SDK name / message — needed for the writer-not-ready and
 * `BadRequestException` cases the translator maps to `QueryFailed` — is read off
 * that `cause`. Errors raised outside the engine carry their raw name/message
 * directly and are matched on the top-level error.
 */
export const isRetryableMigrationError = (e: unknown): boolean => {
  if (!(e instanceof Error)) return false;
  // Inspect both the (possibly re-tagged) error and the raw driver error kept as
  // its cause — the re-tag path replaces name/message but preserves the original
  // as cause (server-side only, so raw text never reaches the wire).
  const raw = e.cause instanceof Error ? e.cause : undefined;
  const matches = (err: Error): boolean =>
    err.name === DatabaseErrors.ConnectionFailed ||
    TRANSIENT_DATA_API_ERROR_NAMES.has(err.name) ||
    err.name === 'BadRequestException' ||
    // JDBC-style but load-bearing: a not-yet-ready writer's message.
    err.message.includes('Communications link failure');
  return matches(e) || (raw !== undefined && matches(raw));
};

/**
 * Execute a function with exponential backoff while Aurora is unreachable.
 * Aurora Serverless v2 can take time to become available after cluster creation
 * (the writer instance may not be ready when the migration Lambda first fires),
 * and a scale-to-zero cluster needs to resume from auto-pause before it accepts
 * the first statement of a deploy.
 *
 * @throws the last underlying error once MAX_RETRIES retryable attempts are
 *         exhausted, unwrapped, so the caller sees the real failure.
 */
export const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryableMigrationError(e) || attempt === MAX_RETRIES) throw e;
      const delay = Math.min(INITIAL_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      const name = e instanceof Error ? e.name : 'unknown';
      console.log(`[migration-lambda] Aurora not ready (${name}), retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
};

/**
 * CloudFormation custom resource handler that runs database migrations on deploy.
 *
 * Migrations are bundled as `.sql` files in the Lambda deployment package
 * (at MIGRATIONS_DIR). The CFN resource property `migrationsHash` triggers
 * re-invocation when migration files change.
 *
 * Retries with exponential backoff (1s → 30s, up to 8 attempts) while Aurora is
 * unreachable — the writer instance isn't ready yet after initial cluster
 * creation, or a `minCapacity: 0` cluster is resuming from auto-pause.
 */
export const handler = async (event: CloudFormationCustomResourceEvent): Promise<{ PhysicalResourceId: string }> => {
  console.log('[migration-lambda] Event:', JSON.stringify({
    RequestType: event.RequestType,
    migrationsHash: event.ResourceProperties?.migrationsHash,
  }));

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId || 'migrations' };
  }

  const engine = new DataApiEngine({
    resourceArn: process.env.CLUSTER_ARN!,
    secretArn: process.env.SECRET_ARN!,
    database: process.env.DATABASE_NAME!,
  });

  try {
    const migrations = await loadMigrationsFromDir(MIGRATIONS_DIR);
    const applied = await withRetry(() => runMigrations(engine, migrations));
    console.log('[migration-lambda] Applied:', applied.length ? applied : '(none pending)');

    return {
      PhysicalResourceId: `migrations-${event.ResourceProperties?.migrationsHash || 'unknown'}`,
    };
  } finally {
    await engine.destroy();
  }
};
