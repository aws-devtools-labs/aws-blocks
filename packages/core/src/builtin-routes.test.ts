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

async function getSettings(
  headers: Record<string, string> = {},
  url = 'http://localhost:3000/aws-blocks/settings',
): Promise<Sent> {
  const match = matchRoute('GET', '/aws-blocks/settings');
  assert.ok(match, 'settings route registered');
  const sent: Sent = { status: 0, body: '' };
  const ctx = {
    request: { headers: new Headers(headers), url: new URL(url), params: {} },
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

  it(
    'local dev server: escapes the working directory it shows in the page',
    { skip: process.platform === 'win32' && 'markup characters are not valid in Windows file names' },
    async (t) => {
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
    },
  );

  // A page on another site can make the browser send a GET to the dev server
  // (`<img src="http://localhost:3000/aws-blocks/settings">`). Opening the editor
  // needs the local-dev signal on the request itself, not only at registration.
  it('local dev server: refuses a cross-site request without opening the editor', async () => {
    registerBuiltinRoutes({ localDev: true });
    const res = await getSettings({ 'Sec-Fetch-Site': 'cross-site' });
    assert.strictEqual(res.status, 403);
    assert.ok(!res.body.includes(process.cwd()), 'a refused request must not disclose the working directory');
    assert.deepStrictEqual(opened, [], 'a cross-site request must never open the editor');
  });

  // The app's frontend on its own port (`localhost:5173` -> `localhost:3000`) is
  // same-site, not same-origin. Both ends are loopback, so a link or fetch from
  // it is still the developer's own app.
  it('local dev server: opens the editor for a same-site request from a loopback frontend', async () => {
    registerBuiltinRoutes({ localDev: true });
    const link = await getSettings({ 'Sec-Fetch-Site': 'same-site' });
    assert.strictEqual(link.status, 200, 'a link from localhost:5173 (no Origin on a navigation)');
    const fetched = await getSettings({ 'Sec-Fetch-Site': 'same-site', Origin: 'http://localhost:5173' });
    assert.strictEqual(fetched.status, 200, 'a fetch from localhost:5173');
    const byIp = await getSettings(
      { 'Sec-Fetch-Site': 'same-site', Origin: 'http://127.0.0.1:5173' },
      'http://127.0.0.1:3000/aws-blocks/settings',
    );
    assert.strictEqual(byIp.status, 200, 'a fetch from 127.0.0.1:5173');
    assert.strictEqual(opened.length, 3);
  });

  it('local dev server: refuses same-site when either end is not loopback', async () => {
    registerBuiltinRoutes({ localDev: true });
    const foreignOrigin = await getSettings(
      { 'Sec-Fetch-Site': 'same-site', Origin: 'http://other.example.com' },
      'http://mybox.example.com:3000/aws-blocks/settings',
    );
    assert.strictEqual(foreignOrigin.status, 403, 'a sibling subdomain of a configured dev host');
    const namedHost = await getSettings(
      { 'Sec-Fetch-Site': 'same-site' },
      'http://mybox.example.com:3000/aws-blocks/settings',
    );
    assert.strictEqual(namedHost.status, 403, 'same-site against a non-loopback dev host');
    const nonLoopbackOrigin = await getSettings({ 'Sec-Fetch-Site': 'same-site', Origin: 'http://192.168.1.10:5173' });
    assert.strictEqual(nonLoopbackOrigin.status, 403, 'a non-loopback Origin');
    assert.deepStrictEqual(opened, []);
  });

  it('local dev server: refuses a request whose Origin is another origin', async () => {
    registerBuiltinRoutes({ localDev: true });
    for (const origin of ['https://evil.example', 'null', 'http://192.168.1.10:3000']) {
      const res = await getSettings({ Origin: origin });
      assert.strictEqual(res.status, 403, `Origin: ${origin}`);
    }
    assert.deepStrictEqual(opened, []);
  });

  it('local dev server: opens the editor for a typed-in URL or a same-origin link', async () => {
    registerBuiltinRoutes({ localDev: true });
    for (const site of ['none', 'same-origin']) {
      const res = await getSettings({ 'Sec-Fetch-Site': site });
      assert.strictEqual(res.status, 200, `Sec-Fetch-Site: ${site}`);
    }
    const sameOrigin = await getSettings({ Origin: 'http://localhost:3000' });
    assert.strictEqual(sameOrigin.status, 200, 'a same-origin Origin is the dev server itself');
    assert.strictEqual(opened.length, 3);
  });

  it('deployed (default): a cross-site request still gets the plain page, never the editor', async () => {
    registerBuiltinRoutes();
    const res = await getSettings({ 'Sec-Fetch-Site': 'cross-site' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(opened, []);
  });
});
