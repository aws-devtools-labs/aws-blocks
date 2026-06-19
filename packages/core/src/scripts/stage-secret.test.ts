// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { stageConnectionString, STAGING_PARAM_PREFIX, STAGING_ENV_VAR } from './stage-secret.js';

const CONN_VARS = ['SUPABASE_DB_URL', 'DATABASE_URL', 'MY_DB_CONNECTION_STRING'];

describe('stageConnectionString', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of CONN_VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of CONN_VARS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  // No connection string in the environment → no-op, returns null without
  // touching SSM (returns before importing the SDK).
  it('returns null when there is no connection string in the environment', async () => {
    const result = await stageConnectionString();
    assert.strictEqual(result, null);
  });

  it('exposes a sweepable staging prefix and the env var the CDK app reads', () => {
    assert.ok(STAGING_PARAM_PREFIX.startsWith('/'), 'prefix must be an SSM path');
    assert.strictEqual(STAGING_ENV_VAR, 'BLOCKS_DB_STAGING_PARAM');
  });
});
