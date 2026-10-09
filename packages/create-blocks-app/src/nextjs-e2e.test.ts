import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { TestEvent } from 'node:test/reporters';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const templateDir = join(dirname(fileURLToPath(import.meta.url)), '../templates/nextjs');
const templateTest = join(templateDir, 'test/e2e.test.ts');
let compiledDir: string;

const requiredTests = ['home page loads', 'app: server serves its Blocks config', 'greet returns message and timestamp'];

function assertTemplateTestsRan(report: string) {
  const events: TestEvent[] = report.split('\n').flatMap((line, index) => {
    if (!line) return [];
    try {
      return [JSON.parse(line)];
    } catch (cause) {
      throw new Error(`Invalid completion event JSON on line ${index + 1}: ${line}\nFull report:\n${report}`, { cause });
    }
  });
  const completed = events.filter((event) => event.type === 'test:pass' || event.type === 'test:fail');
  for (const name of requiredTests) {
    const results = completed.filter((event) => event.data.name === name);
    assert.strictEqual(results.length, 1, `Expected one completed result for ${name}\n${report}`);
    assert.ok(!results[0].data.skip && !results[0].data.todo, `Expected ${name} to run without skip or TODO\n${report}`);
  }
}

describe('Next.js template execution guard', () => {
  const completed = requiredTests.map((name) => ({ type: 'test:pass', data: { name } }));
  const report = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n');

  it('allows unrelated skipped tests', () => {
    assertTemplateTestsRan(report([...completed, { type: 'test:pass', data: { name: 'unrelated', skip: 'optional' } }]));
  });

  it('includes the line, full report, and parse cause for malformed JSON', () => {
    const malformed = '{"type":';
    const output = `${report(completed)}\n\n${malformed}\n`;
    assert.throws(() => assertTemplateTestsRan(output), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid completion event JSON on line 5/);
      assert.ok(error.message.includes(malformed));
      assert.ok(error.message.includes(output));
      assert.ok(error.cause instanceof SyntaxError);
      assert.ok(!Object.keys(error).includes('cause'));
      return true;
    });
  });

  for (const name of requiredTests) {
    it(`rejects skipped, TODO, missing, or duplicate results for ${name}`, () => {
      const otherTests = completed.filter((event) => event.data.name !== name);
      assert.throws(() => assertTemplateTestsRan(report([...otherTests, { type: 'test:pass', data: { name, skip: 'customized' } }])), /to run without skip or TODO/);
      assert.throws(() => assertTemplateTestsRan(report([...otherTests, { type: 'test:pass', data: { name, todo: true } }])), /to run without skip or TODO/);
      assert.throws(() => assertTemplateTestsRan(report(otherTests)), /Expected one completed result/);
      assert.throws(() => assertTemplateTestsRan(report([...completed, { type: 'test:pass', data: { name } }])), /Expected one completed result/);
    });
  }
});

function readExecFileFailure(error: unknown) {
  const failure = typeof error === 'object' && error !== null ? error : {};
  return {
    message: 'message' in failure && typeof failure.message === 'string' ? failure.message : String(error),
    code: 'code' in failure && (typeof failure.code === 'number' || typeof failure.code === 'string') ? failure.code : undefined,
    signal: 'signal' in failure && typeof failure.signal === 'string' ? failure.signal : undefined,
    killed: 'killed' in failure && typeof failure.killed === 'boolean' ? failure.killed : undefined,
    stdout: 'stdout' in failure && typeof failure.stdout === 'string' ? failure.stdout : '',
    stderr: 'stderr' in failure && typeof failure.stderr === 'string' ? failure.stderr : '',
  };
}

describe('Next.js E2E child failure narrowing', () => {
  it('preserves valid execFile error fields', () => {
    const error = Object.assign(new Error('Child timed out'), {
      code: 1, signal: 'SIGTERM', killed: true, stdout: 'partial TAP', stderr: 'child stderr',
    });
    assert.deepStrictEqual(readExecFileFailure(error), {
      message: 'Child timed out', code: 1, signal: 'SIGTERM', killed: true, stdout: 'partial TAP', stderr: 'child stderr',
    });
    assert.strictEqual(readExecFileFailure({ code: 'ENOENT' }).code, 'ENOENT');
  });

  it('handles primitive rejections without reading properties', () => {
    for (const error of [null, undefined, 'unexpected rejection', 42]) {
      assert.deepStrictEqual(readExecFileFailure(error), {
        message: String(error), code: undefined, signal: undefined, killed: undefined, stdout: '', stderr: '',
      });
    }
  });

  it('ignores fields with unexpected types', () => {
    const error = { message: 42, code: {}, signal: 9, killed: 'true', stdout: [], stderr: false };
    assert.deepStrictEqual(readExecFileFailure(error), {
      message: String(error), code: undefined, signal: undefined, killed: undefined, stdout: '', stderr: '',
    });
  });
});

async function runTemplateTests(env: NodeJS.ProcessEnv, timeout = 15000, killSignal: NodeJS.Signals = 'SIGTERM') {
  const childEnv = { ...env };
  // The child runs its own test runner rather than joining this runner.
  delete childEnv.NODE_TEST_CONTEXT;
  const reportDir = mkdtempSync(join(compiledDir, 'results-'));
  const reportFile = join(reportDir, 'events.jsonl');
  const readReport = () => existsSync(reportFile) ? readFileSync(reportFile, 'utf8') : '';
  try {
    // One test file needs no worker isolation; killing the runner must not orphan a worker.
    const result = await run(process.execPath, [
      '--conditions=browser', '--test', '--experimental-test-isolation=none',
      '--test-reporter=tap', '--test-reporter-destination=stdout',
      `--test-reporter=${join(dirname(fileURLToPath(import.meta.url)), 'nextjs-e2e-reporter.js')}`,
      `--test-reporter-destination=${reportFile}`, join(compiledDir, 'test/e2e.test.js'),
    ], {
      env: childEnv, timeout, killSignal,
    });
    return { exitCode: 0, report: readReport(), diagnostic: [result.stdout, result.stderr].join('\n') };
  } catch (error) {
    const failure = readExecFileFailure(error);
    return {
      exitCode: !failure.killed && !failure.signal && typeof failure.code === 'number' ? failure.code : -1,
      report: readReport(),
      diagnostic: [
        failure.killed || failure.signal ? 'Child process was terminated (timeout or signal)' : 'Child process failed',
        failure.message,
        `code: ${failure.code ?? 'none'}, signal: ${failure.signal ?? 'none'}, killed: ${failure.killed ?? false}`,
        failure.stdout, failure.stderr,
      ].join('\n'),
    };
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

describe('Next.js template E2E assertions', () => {
  before(() => {
    compiledDir = mkdtempSync(join(tmpdir(), 'blocks-nextjs-e2e-'));
    writeFileSync(join(compiledDir, 'package.json'), '{"type":"module"}');
    symlinkSync(join(dirname(fileURLToPath(import.meta.url)), '../../../node_modules'), join(compiledDir, 'node_modules'), 'dir');
    const projectFile = join(compiledDir, 'tsconfig.json');
    // Inherit the scaffold's resolution and checks; emit only the E2E and its imports for the Node child.
    writeFileSync(projectFile, JSON.stringify({
      extends: join(templateDir, 'tsconfig.json'),
      compilerOptions: { noEmit: false, incremental: false, rootDir: templateDir, outDir: compiledDir },
      files: [templateTest],
      include: [],
    }));
    execFileSync(process.execPath, [
      require.resolve('typescript/bin/tsc'),
      '--project', projectFile,
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
        const { exitCode, report, diagnostic } = await runTemplateTests(env);
        assert.strictEqual(exitCode, scenario.exitCode, diagnostic);
        assertTemplateTestsRan(report);
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
