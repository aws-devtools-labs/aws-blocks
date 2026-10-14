// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * cli-test backend — deliberately exercises the inputs each `blocks` command
 * acts on, so running a command here produces a visible, meaningful result:
 *
 *   - `ApiNamespace` export    → `blocks generate-client` emits a real typed client
 *   - `config()` / `secret()`  → `blocks typegen` generates a key type augmentation
 *   - `RawRoute` + `KVStore`   → `blocks dev` / `sandbox` / `deploy` serve/provision
 *   - `getSecret` / `getConfig`→ handlers read the declared values at runtime
 *
 * See README.md for the per-command walkthrough.
 */

import { ApiNamespace, Scope, RawRoute, KVStore } from '@aws-blocks/blocks';
import { secret, config, getSecret, getConfig } from '@aws-blocks/hosting';
import { z } from 'zod';

const scope = new Scope('cli-test');

// ── Declared values ─────────────────────────────────────────────────────────
// These declarations are what `blocks typegen` statically scans for. After
// `blocks typegen`, getSecret('STRIPE_KEY') / getConfig('FEATURE_FLAGS') are
// typed to exactly these keys (autocomplete + typo errors), and the schema
// below makes getConfig('FEATURE_FLAGS') return the inferred object type.
secret('STRIPE_KEY');
config('FEATURE_FLAGS', { schema: z.object({ beta: z.boolean(), maxItems: z.number() }) });

// ── KV store ──────────────────────────────────────────────────────────────
// A provisioned resource so `blocks deploy` / `sandbox` create something real,
// and `blocks dev` stands up a local emulation.
const store = new KVStore(scope, 'cache');

// ── A raw HTTP route ────────────────────────────────────────────────────────
// Gives `blocks dev` an endpoint to hit (GET /health) and reads a config value
// so the getSecret/getConfig path is live.
new RawRoute(scope, 'health', {
  method: 'GET',
  path: '/health',
  handler: async (context) => {
    // `getConfig` returns `string` until `blocks typegen` generates the key
    // augmentation that narrows it to the schema type. Parse defensively so
    // this app typechecks before typegen has run; after typegen the value is
    // already the inferred object type.
    const raw = await getConfig('FEATURE_FLAGS').catch(() => undefined);
    const beta = Boolean(raw && JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)).beta);
    context.response.send({ ok: true, beta });
  },
});

// ── An API namespace ──────────────────────────────────────────────────────
// This is what `blocks generate-client` turns into a typed browser client:
// `client.api.echo(...)` / `client.api.cachedCount()` become callable methods.
export const api = new ApiNamespace(scope, 'api', (context) => ({
  echo: async (message: string): Promise<{ message: string }> => {
    return { message };
  },
  cachedCount: async (): Promise<{ count: number }> => {
    const current = Number((await store.get('count')) ?? '0');
    const next = current + 1;
    await store.put('count', String(next));
    return { count: next };
  },
  // Reads a declared secret at runtime (local dev reads it from a .env file,
  // so no AWS is needed to exercise this path under `blocks dev`).
  hasStripeKey: async (): Promise<{ configured: boolean }> => {
    const key = await getSecret('STRIPE_KEY').catch(() => '');
    return { configured: Boolean(key) };
  },
}));
