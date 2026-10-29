// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { api as apiType } from 'aws-blocks';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');
const clientUrl = pathToFileURL(join(projectRoot, 'aws-blocks', 'client.js')).href;

/**
 * How long the keep-alive regression test idles the main test process's HTTP pool
 * while a CLI subprocess runs. It must exceed the dev server's keep-alive socket
 * lifetime: Node's `server.keepAliveTimeout` (5 s, advertised to clients as
 * `Keep-Alive: timeout=5`) plus `server.keepAliveTimeoutBuffer` (1 s).
 */
const IDLE_GAP_MS = 7_000;

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
export function cliClientTests(getApi: () => typeof apiType) {
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

    // The generated client's `generateClient` passes its options straight to every
    // namespace client, so `retryStaleConnection` reaches the resend logic. The script
    // runs the real generated client.js against an in-process server that drops the
    // second request on a reused keep-alive socket without answering (an idle close
    // crossing the next call), and reports how many copies of that call arrived.
    for (const retry of [undefined, false] as const) {
      test(`generateClient({ retryStaleConnection: ${String(retry)} }) ${retry === false ? 'surfaces a dropped connection without resending' : 'resends a dropped connection once'}`, { timeout: 20_000 }, async () => {
        const result = await runCli(`
          import('node:http').then(async ({ createServer }) => {
            const arrived = [];
            const perSocket = new WeakMap();
            const server = createServer((req, res) => {
              const n = (perSocket.get(req.socket) ?? 0) + 1;
              perSocket.set(req.socket, n);
              let body = '';
              req.on('data', (c) => { body += c; });
              req.on('end', () => {
                const rpc = JSON.parse(body);
                arrived.push(String(rpc.params[0]));
                if (n > 1) { req.socket.end(); return; }
                res.setHeader('content-type', 'application/json');
                res.setHeader('keep-alive', 'timeout=60');
                res.end(JSON.stringify({ jsonrpc: '2.0', result: rpc.params[0], id: rpc.id }));
              });
            });
            server.keepAliveTimeout = 60_000;
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            const url = 'http://127.0.0.1:' + server.address().port + '/aws-blocks/api';
            const { generateClient } = await import(clientUrl);
            const { api } = generateClient(${retry === undefined ? '{ url }' : '{ url, retryStaleConnection: false }'});
            const first = await api.echoData('first');
            await new Promise((resolve) => setTimeout(resolve, 50));
            let second;
            try { second = await api.echoData('second'); } catch (e) { second = 'error:' + e.message; }
            server.closeAllConnections();
            server.close();
            console.log(JSON.stringify({ first, second, arrived }));
          });
        `, { cwd: outsideCwd });

        assertCompleted(result);
        assert.strictEqual(result.exitCode, 0, result.stderr);
        const out = JSON.parse(result.stdout.trim().split('\n').pop() ?? '{}') as {
          first: unknown;
          second: unknown;
          arrived: string[];
        };
        assert.strictEqual(out.first, 'first');
        if (retry === false) {
          assert.strictEqual(out.second, 'error:fetch failed', 'the dropped call fails instead of being resent');
          assert.deepStrictEqual(out.arrived, ['first', 'second'], 'exactly one copy of the dropped call was sent');
        } else {
          assert.strictEqual(out.second, 'second', 'the dropped call is resent on a new connection');
          assert.deepStrictEqual(out.arrived, ['first', 'second', 'second'], 'one resend, no more');
        }
      });
    }

    // Regression (L8): these tests shell out to `npx tsx` for several seconds. When that
    // blocked this process's event loop (execFileSync), undici could not run the idle
    // timer that retires a pooled keep-alive socket after the server's advertised
    // `Keep-Alive: timeout=5`. The dev server closed the socket meanwhile, so the next
    // suite's first API call (Tracer › startSegment) reused it and failed with a bare
    // `TypeError: fetch failed` (cause: ECONNRESET) whenever this suite took longer than ~6 s.
    //
    // Since FX54 the core client resends a call once when its pooled socket turns out to be
    // closed before any response byte. A deployed API Gateway closes idle sockets without
    // advertising a timeout, and that race failed this test's first `Promise.all` on a sandbox.
    // The resend would also hide a blocked loop here, so the `ticks` assertion is what pins L8;
    // `afterGap` pins the customer-visible result against both local and deployed targets.
    test('API calls still succeed after a CLI subprocess outlives the server keep-alive timeout', { timeout: 40_000 }, async () => {
      const api = getApi();
      // Pool several keep-alive connections in this process's global fetch dispatcher.
      await Promise.all([api.echoData('a'), api.echoData('b'), api.echoData('c')]);

      let ticks = 0;
      const ticker = setInterval(() => { ticks++; }, 100);
      try {
        const result = await runCli(`
          await new Promise((resolve) => setTimeout(resolve, ${IDLE_GAP_MS}));
          console.log('OK');
        `, { timeoutMs: IDLE_GAP_MS + 20_000 });
        assert.strictEqual(result.exitCode, 0, `Idle subprocess should succeed, stderr: ${result.stderr}`);
      } finally {
        clearInterval(ticker);
      }

      let afterGap: unknown;
      try {
        afterGap = await api.echoData('after idle gap');
      } catch (e) {
        afterGap = e;
      }
      assert.ok(ticks >= 10, `runCli must not block the event loop: only ${ticks} 100 ms timer ticks fired during a ${IDLE_GAP_MS} ms subprocess`);
      assert.strictEqual(
        afterGap,
        'after idle gap',
        `API call after a ${IDLE_GAP_MS} ms idle gap failed: ${describeError(afterGap)}`,
      );
    });
  });
}

/**
 * Run an inline ES module as a Node subprocess simulating a CLI consumer.
 *
 * The script receives the client URL as `clientUrl`; CWD affects only
 * config.json discovery. Awaiting the child keeps the parent event loop
 * responsive. Never use `execFileSync` here: blocking this process's event loop
 * stops undici from retiring idle keep-alive sockets on time, so the next API call
 * reuses a socket the dev server has already closed and fails with `fetch failed`.
 */
function runCli(script: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<CliResult> {
  const env = { ...process.env };
  for (const name of ['NODE_OPTIONS', 'BLOCKS_API_URL', 'BLOCKS_CONFIG']) delete env[name];
  const moduleSource = `const clientUrl = process.argv[1];\n${script}`;

  return new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '--eval', moduleSource, clientUrl], {
      cwd: opts?.cwd ?? projectRoot,
      encoding: 'utf-8',
      env,
      timeout: opts?.timeoutMs ?? 12_000,
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

/** Render a thrown value with its `cause` — undici's bare `fetch failed` hides the socket error there. */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return JSON.stringify(e);
  return e.cause === undefined ? String(e) : `${String(e)} (cause: ${String(e.cause)})`;
}
