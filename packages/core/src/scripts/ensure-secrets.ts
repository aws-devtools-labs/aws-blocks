// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Connection-string discovery and shared SSM helpers.
 *
 * `findConnectionString` locates the external-database connection string in the
 * environment; `withRetry` wraps SSM calls with transient-error backoff. Both are
 * shared by the `copyFrom` staging path (`stage-secret.ts`). This module also
 * owns `.env` loading for deploy/sandbox.
 */
import { existsSync, readFileSync } from 'node:fs';

const CONNECTION_STRING_PATTERN = /_(DB_URL|CONNECTION_STRING)$/;

export function findConnectionString(): { name: string; value: string } | null {
  for (const [name, value] of Object.entries(process.env)) {
    if (CONNECTION_STRING_PATTERN.test(name) && value) {
      return { name, value };
    }
  }
  return null;
}

/**
 * Retry an SSM operation on transient failures (throttling, 5xx, timeouts) with
 * exponential backoff. Non-transient errors (e.g. ParameterNotFound,
 * AccessDenied) are thrown immediately so callers can handle them.
 */
export async function withRetry<T>(op: () => Promise<T>, delaysMs: number[] = [200, 600, 1500]): Promise<T> {
  const TRANSIENT = new Set([
    'ThrottlingException', 'Throttling', 'TooManyUpdates',
    'RequestLimitExceeded', 'InternalServerError', 'ServiceUnavailable',
    'TimeoutError', 'RequestTimeout',
  ]);
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e: any) {
      const transient =
        TRANSIENT.has(e?.name) ||
        (typeof e?.$metadata?.httpStatusCode === 'number' && e.$metadata.httpStatusCode >= 500) ||
        e?.$retryable != null;
      if (!transient || attempt >= delaysMs.length) throw e;
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}

/**
 * Load environment for production deployment.
 *
 * Loads `.env.production` into `process.env` when present, then returns.
 * If the file is absent this is a no-op — a missing `.env.production` is
 * valid for templates that need no production-only configuration (e.g. the
 * default DynamoDB template, Next.js, auth-cognito).
 *
 * Note: this function intentionally does NOT require any specific connection
 * string. A Building Block that connects to an external database (e.g. via
 * `fromExisting()`) is responsible for asserting its own configuration during
 * synth/deploy, where the requirement can be checked against the construct
 * tree rather than guessed at by the generic deploy script.
 */
export function loadProductionEnv(): void {
  if (existsSync('.env.production')) {
    loadEnvFile('.env.production');
  }
}

/** Load a .env file into process.env. Uses Node 21.7+ API with fallback. */
export function loadEnvFile(filePath: string): void {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(filePath);
  } else {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  }
}
