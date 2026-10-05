import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const templateDir = join(dirname(fileURLToPath(import.meta.url)), '../templates/nextjs');
const templateTest = join(templateDir, 'test/e2e.test.ts');
let compiledDir: string;

async function runTemplateTests(env: NodeJS.ProcessEnv, timeout = 15000, killSignal: NodeJS.Signals = 'SIGTERM') {
  const childEnv = { ...env };
  // The child runs its own test runner rather than joining this runner.
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    // One test file needs no worker isolation; killing the runner must not orphan a worker.
    const result = await run(process.execPath, ['--test', '--experimental-test-isolation=none', '--test-reporter=tap', join(compiledDir, 'test/e2e.test.js')], {
      env: childEnv, timeout, killSignal,
    });
    return { exitCode: 0, stdout: result.stdout, diagnostic: result.stdout };
  } catch (error) {
    const failure = error as Error & {
      code?: number | string | null; signal?: string | null; killed?: boolean; stdout?: string; stderr?: string;
    };
    const stdout = failure.stdout ?? '';
    return {
      exitCode: !failure.killed && !failure.signal && typeof failure.code === 'number' ? failure.code : -1,
      stdout,
      diagnostic: [
        failure.killed || failure.signal ? 'Child process was terminated (timeout or signal)' : 'Child process failed',
        failure.message,
        `code: ${failure.code ?? 'none'}, signal: ${failure.signal ?? 'none'}, killed: ${failure.killed ?? false}`,
        stdout, failure.stderr ?? '',
      ].join('\n'),
    };
  }
}

describe('Next.js template E2E assertions', () => {
  before(() => {
    compiledDir = mkdtempSync(join(tmpdir(), 'blocks-nextjs-e2e-'));
    writeFileSync(join(compiledDir, 'package.json'), '{"type":"module"}');
    symlinkSync(join(dirname(fileURLToPath(import.meta.url)), '../../../node_modules'), join(compiledDir, 'node_modules'), 'dir');
    execFileSync(process.execPath, [
      require.resolve('typescript/bin/tsc'),
      templateTest,
      '--target', 'es2022',
      '--module', 'nodenext',
      '--moduleResolution', 'nodenext',
      '--skipLibCheck',
      '--rootDir', templateDir,
      '--outDir', compiledDir,
    ], { timeout: 30000 });
  });

  after(() => {
    if (compiledDir) rmSync(compiledDir, { recursive: true, force: true });
  });

  const scenarios = [
    { name: 'starter page with config', html: 'Blocks + Next.js', configStatus: 200, exitCode: 0 },
    { name: 'customized page with config', html: 'My application', configStatus: 200, exitCode: 0 },
    { name: 'customized page with a trailing slash in TEST_URL', html: 'My application', configStatus: 200, exitCode: 0, trailingSlash: true },
    { name: 'customized page without config', html: 'My application', configStatus: 404, exitCode: 1 },
    { name: 'starter page with failing config', html: 'Blocks + Next.js', configStatus: 500, exitCode: 1 },
    { name: 'home page fails after readiness', html: 'My application', configStatus: 200, exitCode: 1, homeFails: true },
    { name: 'sample API returns the wrong message', html: 'My application', configStatus: 200, exitCode: 1, message: 'Wrong greeting' },
    { name: 'sample API returns an invalid timestamp', html: 'My application', configStatus: 200, exitCode: 1, timestamp: 'not a timestamp' },
    { name: 'sample API returns an RPC error', html: 'My application', configStatus: 200, exitCode: 1, rpcError: true },
    { name: 'config uses a relative API URL', html: 'My application', configStatus: 200, exitCode: 0, relativeApiUrl: true },
  ];

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      let homeRequests = 0;
      let configRequests = 0;
      const apiRequests: unknown[] = [];
      const server = createServer(async (req, res) => {
        if (req.url === '/.blocks-sandbox/config.json') {
          configRequests++;
          res.writeHead(scenario.configStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ apiUrl: scenario.relativeApiUrl ? '/aws-blocks/api' : `http://${req.headers.host}/aws-blocks/api` }));
        } else if (req.url === '/aws-blocks/api' && req.method === 'POST') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const request = JSON.parse(body);
          apiRequests.push({ method: request.method, params: request.params });
          res.writeHead(scenario.rpcError ? 500 : 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0', id: request.id,
            ...(scenario.rpcError
              ? { error: { code: 500, message: 'Sample API failed' } }
              : { result: { message: scenario.message ?? 'Hello, World!', timestamp: scenario.timestamp ?? Date.now() } }),
          }));
        } else {
          homeRequests++;
          res.writeHead(scenario.homeFails && homeRequests > 1 ? 500 : 200, { 'Content-Type': 'text/html' });
          res.end(scenario.html);
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          TEST_URL: `http://127.0.0.1:${address.port}${scenario.trailingSlash ? '/' : ''}`,
          NODE_OPTIONS: '',
        };
        const { exitCode, stdout, diagnostic } = await runTemplateTests(env);
        assert.strictEqual(exitCode, scenario.exitCode, diagnostic);
        assert.match(stdout, /# skipped 0\b/, stdout);
        assert.ok(configRequests > 0, 'E2E must request the Blocks config even when the page is customized');
        if (scenario.configStatus === 200) {
          assert.deepStrictEqual(apiRequests, [{ method: 'api.greet', params: ['World'] }], 'E2E must call the sample API');
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  }

  it('distinguishes a timeout from a normal test failure', async () => {
    const result = await runTemplateTests({ ...process.env, TEST_URL: 'http://127.0.0.1:0', NODE_OPTIONS: '' }, 250);
    assert.strictEqual(result.exitCode, -1, result.diagnostic);
    assert.match(result.diagnostic, /Child process was terminated \(timeout or signal\)/, result.diagnostic);
    assert.match(result.diagnostic, /killed: true/, result.diagnostic);
  });

  it('includes the termination signal when the child exits by signal', async () => {
    const result = await runTemplateTests({ ...process.env, TEST_URL: 'http://127.0.0.1:0', NODE_OPTIONS: '' }, 250, 'SIGKILL');
    assert.strictEqual(result.exitCode, -1, result.diagnostic);
    assert.match(result.diagnostic, /signal: SIGKILL/, result.diagnostic);
  });
});
