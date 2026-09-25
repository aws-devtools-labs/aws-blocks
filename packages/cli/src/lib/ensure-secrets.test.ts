// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadProductionEnv } from './ensure-secrets.js';

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
