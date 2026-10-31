// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectExternalDb } from './detect-external-db.js';

const CONN = 'postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres';

function withApp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bb-data-detect-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSettings(dir: string, settings: Record<string, unknown>): void {
  mkdirSync(join(dir, '.bb-data'), { recursive: true });
  writeFileSync(join(dir, '.bb-data', 'settings.json'), JSON.stringify(settings));
}

test('a local app (nothing configured) is not external, and detection writes nothing', () => {
  withApp((dir) => {
    assert.strictEqual(detectExternalDb({}, dir), null);
    assert.strictEqual(existsSync(join(dir, '.bb-data')), false);
  });
});

test('a connection-string variable in the environment marks the app external', () => {
  withApp((dir) => {
    assert.strictEqual(detectExternalDb({ SUPABASE_DB_URL: CONN }, dir), CONN);
    assert.strictEqual(detectExternalDb({ MY_CONNECTION_STRING: CONN }, dir), CONN);
    assert.strictEqual(detectExternalDb({ SUPABASE_DB_URL: '' }, dir), null);
  });
});

test('a connection-string variable in .env.local (which npm run dev loads) marks the app external', () => {
  withApp((dir) => {
    writeFileSync(join(dir, '.env.local'), `AWS_PROFILE=dev\nSUPABASE_DB_URL="${CONN}"\n`);
    assert.strictEqual(detectExternalDb({}, dir), CONN);
  });
});

test('a connection string seeded for the db-url setting (by db pull) marks the app external', () => {
  withApp((dir) => {
    writeSettings(dir, { 'supabase-db-url': CONN });
    assert.strictEqual(detectExternalDb({}, dir), CONN);
  });
});

test('the AppSetting mock placeholder for an unset db-url secret does not mark the app external', () => {
  withApp((dir) => {
    // What the AppSetting mock persists for a secret nobody set (43 base64url chars).
    writeSettings(dir, { 'supabase-db-url': 'r9um4Uzg_FVjRkmJWJEfHsF7hYuzaR6VB58Gio-BdFE', 'my-app-auth-jwt-secret': 'x' });
    assert.strictEqual(detectExternalDb({}, dir), null);
  });
});

test('an unreadable settings.json is not a signal', () => {
  withApp((dir) => {
    mkdirSync(join(dir, '.bb-data'));
    writeFileSync(join(dir, '.bb-data', 'settings.json'), '{not json');
    assert.strictEqual(detectExternalDb({}, dir), null);
  });
});
