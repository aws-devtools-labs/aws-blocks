// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProductionEnv, withRetry } from './ensure-secrets.js';

describe('loadProductionEnv', () => {
  let workDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    workDir = mkdtempSync(join(tmpdir(), 'load-prod-env-'));
    process.chdir(workDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  // Regression for bug bash item #2: deploy of a non-Supabase template
  // (no .env.production, no SUPABASE_DB_URL) must not throw.
  it('does not throw when .env.production is absent and no connection string is set', () => {
    delete process.env.SUPABASE_DB_URL;
    assert.doesNotThrow(() => loadProductionEnv());
  });

  it('does not throw when .env.production is absent even without any DB env var', () => {
    delete process.env.SUPABASE_DB_URL;
    delete process.env.DATABASE_URL;
    assert.doesNotThrow(() => loadProductionEnv());
  });

  it('loads variables from .env.production when present', () => {
    const key = 'LOAD_PROD_ENV_TEST_VAR';
    delete process.env[key];
    writeFileSync(join(workDir, '.env.production'), `${key}=hello-prod\n`);
    try {
      loadProductionEnv();
      assert.strictEqual(process.env[key], 'hello-prod');
    } finally {
      delete process.env[key];
    }
  });
});


describe('withRetry', () => {
  const NO_DELAY = [0, 0, 0];

  it('returns the result without retrying on success', async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 'ok'; }, NO_DELAY);
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 1);
  });

  it('retries a transient error then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) {
        const e: any = new Error('throttled');
        e.name = 'ThrottlingException';
        throw e;
      }
      return 'ok';
    }, NO_DELAY);
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 3);
  });

  it('does not retry a non-transient error (throws immediately)', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => {
        calls++;
        const e: any = new Error('missing');
        e.name = 'ParameterNotFound';
        throw e;
      }, NO_DELAY),
      /missing/,
    );
    assert.strictEqual(calls, 1);
  });

  it('treats 5xx responses as transient', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 2) {
        const e: any = new Error('server error');
        e.$metadata = { httpStatusCode: 500 };
        throw e;
      }
      return 'ok';
    }, NO_DELAY);
    assert.strictEqual(result, 'ok');
    assert.strictEqual(calls, 2);
  });

  it('gives up after exhausting retries on a persistent transient error', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(async () => {
        calls++;
        const e: any = new Error('still throttled');
        e.name = 'ThrottlingException';
        throw e;
      }, NO_DELAY),
      /still throttled/,
    );
    // initial attempt + one per delay entry
    assert.strictEqual(calls, NO_DELAY.length + 1);
  });
});
