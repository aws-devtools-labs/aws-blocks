// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /aws-blocks/settings` with no BB_SETTINGS_GROUP_URL used to shell out to
 * open an editor and echo the working directory in the page — and the built-in
 * routes are registered by the deployed Lambda too, so an anonymous GET could
 * trigger a process spawn there. Opening an editor is now opt-in by the dev
 * server only, and the deployed page never discloses a filesystem path.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBuiltinRoutes, _setEditorOpenerForTest } from './builtin-routes.js';
import { clearRouteRegistry, matchRoute } from './raw-route.js';

type Sent = { status: number; body: string };

async function getSettings(): Promise<Sent> {
  const match = matchRoute('GET', '/aws-blocks/settings');
  assert.ok(match, 'settings route registered');
  const sent: Sent = { status: 0, body: '' };
  const ctx = {
    request: { headers: new Headers(), url: 'http://x/aws-blocks/settings', params: {} },
    response: {
      headers: new Headers(),
      set status(code: number) { sent.status = code; },
      get status() { return sent.status; },
      send: (b: string) => { sent.body = b; },
    },
  };
  await match.route.handler(ctx as never);
  return sent;
}

describe('built-in /aws-blocks/settings route', () => {
  let opened: string[];
  beforeEach(() => {
    clearRouteRegistry();
    opened = [];
    _setEditorOpenerForTest((p) => opened.push(p));
    delete process.env.BB_SETTINGS_GROUP_URL;
  });

  it('deployed (default): never opens an editor and never echoes a filesystem path', async () => {
    registerBuiltinRoutes();
    const res = await getSettings();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(opened, [], 'no process may be spawned outside the local dev server');
    assert.ok(!res.body.includes(process.cwd()), 'the working directory must not be disclosed');
  });

  it('local dev server opt-in: opens .bb-data/settings.json in the editor', async () => {
    registerBuiltinRoutes({ localDev: true });
    const res = await getSettings();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(opened.length, 1);
    assert.match(opened[0], /\.bb-data[\\/]settings\.json$/);
  });

  it('local dev server: escapes the working directory it shows in the page', async (t) => {
    const parent = mkdtempSync(join(tmpdir(), 'settings-route-'));
    const cwd = join(parent, 'app<img src=x onerror="alert(1)">');
    mkdirSync(cwd);
    const previous = process.cwd();
    process.chdir(cwd);
    t.after(() => {
      process.chdir(previous);
      rmSync(parent, { recursive: true, force: true });
    });
    registerBuiltinRoutes({ localDev: true });
    const res = await getSettings();
    assert.ok(!res.body.includes('<img'), 'a directory name must not inject markup');
    assert.ok(res.body.includes('app&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), res.body);
  });
});
