// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Detect, from the CLI, whether the app in the working directory targets an
 * external (`fromExisting()`) database.
 *
 * Only real signals count, the same ones `npm run dev` acts on:
 *   - a `*_DB_URL` / `*_CONNECTION_STRING` variable in the environment or in
 *     `.env.local` (the dev server loads that file; core's dev and deploy
 *     migration steps key off the same pattern),
 *   - a connection string stored for the `db pull` wiring's `db-url` setting in
 *     `.bb-data/settings.json`.
 *
 * The setting is read straight from the file, never through the `AppSetting`
 * mock: the mock invents (and saves) a random placeholder for an unset secret,
 * which would make every app look external.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { Scope, computeScopeFullId } from '@aws-blocks/core';
import { SUPABASE } from './db-pull/supabase.js';

const CONNECTION_STRING_VAR = /_(DB_URL|CONNECTION_STRING)$/;
const POSTGRES_URL = /^postgres(ql)?:\/\//i;

/** Returns the connection string the app is configured with, or null for a local (PGlite) app. */
export function detectExternalDb(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | null {
  const fromEnv = connectionStringVar(env);
  if (fromEnv) return fromEnv;

  const envLocal = join(cwd, '.env.local');
  if (existsSync(envLocal)) {
    const fromFile = connectionStringVar(parseEnv(readFileSync(envLocal, 'utf8')));
    if (fromFile) return fromFile;
  }

  const settingsFile = join(cwd, '.bb-data', 'settings.json');
  if (existsSync(settingsFile)) {
    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    } catch {
      return null;
    }
    // The fullId of the `db-url` AppSetting that the `db pull` wiring declares.
    const key = computeScopeFullId({ id: 'db-url', parent: new Scope(SUPABASE.scopeName) });
    const value = settings[key];
    if (typeof value === 'string' && POSTGRES_URL.test(value)) return value;
  }
  return null;
}

function connectionStringVar(vars: Record<string, string | undefined>): string | null {
  for (const [name, value] of Object.entries(vars)) {
    if (CONNECTION_STRING_VAR.test(name) && value) return value;
  }
  return null;
}
