// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');
const clientUrl = pathToFileURL(join(projectRoot, 'aws-blocks', 'client.js')).href;

interface CliResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * CLI client tests — verifies generateClient() works for out-of-context
 * consumers (CLIs, micro-frontends, cross-repo packages) that can't rely
 * on automatic config.json discovery.
 *
 * Each test spawns a Node subprocess to simulate a real CLI. The script
 * imports the generated JavaScript client by URL (so module resolution works),
 * but runs from a chosen CWD (which controls whether config.json is discoverable).
 */
export function cliClientTests() {
  describe('CLI Client (generateClient)', () => {
    let outsideCwd: string;
    before(() => { outsideCwd = mkdtempSync(join(tmpdir(), 'blocks-cli-client-')); });
    after(() => { rmSync(outsideCwd, { recursive: true, force: true }); });

    test('keeps the parent event loop responsive while a CLI subprocess runs', async () => {
      let timerRan = false;
      const timer = setTimeout(() => { timerRan = true; }, 20);
      try {
        const result = await runCli('await new Promise((resolve) => setTimeout(resolve, 100));');
        assertCompleted(result);
        assert.strictEqual(result.exitCode, 0, result.stderr);
        assert.ok(timerRan, 'CLI subprocesses must not block the parent event loop and delay socket cleanup');
      } finally {
        clearTimeout(timer);
      }
    });

    test('default export fails when CWD has no config.json', { timeout: 15_000 }, async () => {
      // A fresh directory has no .blocks-sandbox/config.json.
      // The client's auto-discovery reads config.json relative to CWD, so it fails.
      const result = await runCli(`
        const { api } = await import(clientUrl);
        await api.echoData('ping');
      `, { cwd: outsideCwd });

      assertCompleted(result);
      assert.notStrictEqual(result.exitCode, 0, 'Should have failed');
      assert.match(result.stderr, /Blocks API URL not configured/);
    });

    test('generateClient with incorrect URL fails', { timeout: 15_000 }, async () => {
      const result = await runCli(`
        const { generateClient } = await import(clientUrl);
        const { api } = generateClient({ url: 'http://localhost:19999/api' });
        await api.echoData('ping');
      `);

      assertCompleted(result);
      assert.notStrictEqual(result.exitCode, 0, 'Should have failed');
      assert.match(result.stderr, /ECONNREFUSED|fetch failed/);
    });

    test('generateClient with correct URL succeeds', { timeout: 15_000 }, async () => {
      const config = JSON.parse(readFileSync(join(projectRoot, '.blocks-sandbox', 'config.json'), 'utf-8'));

      // CWD has no config.json, but generateClient bypasses discovery entirely.
      const result = await runCli(`
        const { generateClient } = await import(clientUrl);
        const { api } = generateClient({ url: ${JSON.stringify(config.apiUrl)} });
        const result = await api.echoData('hello from CLI');
        if (result !== 'hello from CLI') throw new Error('Expected echo, got: ' + JSON.stringify(result));
        console.log('OK');
      `, { cwd: outsideCwd });

      assertCompleted(result);
      assert.strictEqual(result.exitCode, 0, `Should succeed, stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('OK'));
    });
  });
}

/**
 * Run an inline ES module as a Node subprocess simulating a CLI consumer.
 *
 * The script receives the client URL as `clientUrl`; CWD affects only
 * config.json discovery. Awaiting the child keeps the parent event loop
 * responsive.
 */
function runCli(script: string, opts?: { cwd?: string }): Promise<CliResult> {
  const env = { ...process.env };
  for (const name of ['NODE_OPTIONS', 'BLOCKS_API_URL', 'BLOCKS_CONFIG']) delete env[name];
  const moduleSource = `const clientUrl = process.argv[1];\n${script}`;

  return new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '--eval', moduleSource, clientUrl], {
      cwd: opts?.cwd ?? projectRoot,
      encoding: 'utf-8',
      env,
      timeout: 12_000,
    }, (error, stdout, stderr) => {
      const failure = error as (Error & { code?: unknown; signal?: NodeJS.Signals | null }) | null;
      resolve({
        exitCode: failure ? (typeof failure.code === 'number' ? failure.code : null) : 0,
        signal: failure?.signal ?? null,
        stdout,
        stderr: stderr || failure?.message || '',
      });
    });
  });
}

function assertCompleted(result: CliResult): void {
  assert.strictEqual(result.signal, null, `CLI subprocess was terminated: ${result.stderr}`);
  assert.notStrictEqual(result.exitCode, null, `CLI subprocess did not exit normally: ${result.stderr}`);
}
