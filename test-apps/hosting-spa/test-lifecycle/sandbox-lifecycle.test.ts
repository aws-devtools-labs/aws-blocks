// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Guards how the hosting test apps deploy their sandbox (see test/sandbox-lifecycle.ts).
 *
 * A CloudFront deploy takes ~10 minutes. Run from a Playwright `beforeAll` it blew the
 * 60s test timeout and was redeployed from scratch on every retry. The fixtures here
 * reproduce that with a deploy that blocks for longer than the test timeout, and show
 * that `globalSetup` / `globalTeardown` deploys once, survives a retry, and always
 * tears down. The structural checks keep all six hosting apps on that pattern.
 *
 * No fixture touches AWS: the stand-in deploy only sleeps.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runSandboxScript } from '../test/sandbox-lifecycle.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const testApps = join(here, '..', '..');
const HOSTING_APPS = [
  'hosting-spa',
  'hosting-ssr',
  'hosting-ssr-nuxt',
  'hosting-ssr-astro',
  'hosting-ssr-astro-default404',
  'hosting-ssr-sveltekit',
];
const LIFECYCLE_FILES = ['sandbox-lifecycle.ts', 'global-setup.ts', 'global-teardown.ts'];

function eventsFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'blocks-lifecycle-')), 'events.log');
}

function events(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean) : [];
}

/** Run one fixture project with Playwright; return its exit status and output. */
function playwright(fixture: string, file: string, env: Record<string, string> = {}) {
  const out = spawnSync(
    'npx',
    ['playwright', 'test', '--config', join(fixtures, fixture, 'playwright.config.ts'), '--output', join(dirname(file), 'results')],
    { cwd: join(fixtures, fixture), encoding: 'utf-8', env: { ...process.env, ...env, LIFECYCLE_EVENTS: file } },
  );
  return { status: out.status, output: `${out.stdout}${out.stderr}` };
}

test('deploying in beforeAll: the hook times out and every retry redeploys', () => {
  const file = eventsFile();
  const run = playwright('hook-deploy', file);
  assert.notStrictEqual(run.status, 0, run.output);
  assert.match(run.output, /"beforeAll" hook timeout of \d+ms exceeded/);
  assert.deepStrictEqual(events(file), ['deploy', 'destroy', 'deploy', 'destroy']);
});

test('deploying in globalSetup: one deploy, the retry reuses it, one teardown', () => {
  const file = eventsFile();
  const run = playwright('global-deploy', file);
  assert.strictEqual(run.status, 0, run.output);
  assert.deepStrictEqual(events(file), ['deploy', 'test retry=0', 'test retry=1', 'destroy']);
});

test('deploying in globalSetup: teardown still runs when the deploy fails', () => {
  const file = eventsFile();
  const run = playwright('global-deploy', file, { LIFECYCLE_DEPLOY_FAILS: '1' });
  assert.notStrictEqual(run.status, 0, run.output);
  assert.deepStrictEqual(events(file), ['deploy', 'destroy']);
});

test('runSandboxScript stops a script that overruns its timeout', async () => {
  const file = eventsFile();
  process.env.LIFECYCLE_EVENTS = file;
  try {
    await assert.rejects(
      () => runSandboxScript(join(fixtures, 'stub-slow.ts'), 500),
      /stub-slow\.ts did not finish within 0\.5s and was stopped/,
    );
    await sleep(4_000); // the script would record after 3s if it were still running
    assert.deepStrictEqual(events(file), []);
  } finally {
    delete process.env.LIFECYCLE_EVENTS;
  }
});

test('every hosting app deploys in globalSetup and tears down in globalTeardown', async () => {
  for (const app of HOSTING_APPS) {
    const configPath = join(testApps, app, 'playwright.config.ts');
    const { default: config } = await import(configPath);
    assert.strictEqual(config.globalSetup, './test/global-setup.ts', app);
    assert.strictEqual(config.globalTeardown, './test/global-teardown.ts', app);
    for (const name of LIFECYCLE_FILES) {
      assert.strictEqual(
        readFileSync(join(testApps, app, 'test', name), 'utf-8'),
        readFileSync(join(testApps, 'hosting-spa', 'test', name), 'utf-8'),
        `${app}/test/${name} must match hosting-spa's copy`,
      );
    }
    for (const spec of readdirSync(join(testApps, app, 'test')).filter((f) => f.endsWith('.test.ts'))) {
      const source = readFileSync(join(testApps, app, 'test', spec), 'utf-8');
      assert.doesNotMatch(source, /sandbox-(deploy|destroy)\.ts/, `${app}/test/${spec} must not deploy in a hook`);
    }
  }
});
