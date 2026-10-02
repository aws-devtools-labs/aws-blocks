import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const templateTest = join(dirname(fileURLToPath(import.meta.url)), '../templates/nextjs/test/e2e.test.ts');
let compiledDir: string;

describe('Next.js template E2E assertions', () => {
  before(() => {
    compiledDir = mkdtempSync(join(tmpdir(), 'blocks-nextjs-e2e-'));
    writeFileSync(join(compiledDir, 'package.json'), '{"type":"module"}');
    execFileSync(process.execPath, [
      require.resolve('typescript/bin/tsc'),
      templateTest,
      '--target', 'es2022',
      '--module', 'nodenext',
      '--moduleResolution', 'nodenext',
      '--skipLibCheck',
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
  ];

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      let homeRequests = 0;
      let configRequests = 0;
      const server = createServer((req, res) => {
        if (req.url === '/.blocks-sandbox/config.json') {
          configRequests++;
          res.writeHead(scenario.configStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ apiUrl: 'http://localhost/aws-blocks/api' }));
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
        // The child runs its own test runner rather than joining this runner.
        delete env.NODE_TEST_CONTEXT;
        let exitCode = 0;
        let stdout = '';
        try {
          const result = await run(process.execPath, ['--test', '--test-reporter=tap', join(compiledDir, 'e2e.test.js')], {
            env,
            timeout: 15000,
          });
          stdout = result.stdout;
        } catch (error) {
          const failure = error as Error & { code: number; stdout: string };
          exitCode = failure.code;
          stdout = failure.stdout;
        }
        assert.strictEqual(exitCode, scenario.exitCode, stdout);
        assert.match(stdout, /# skipped 0\b/, stdout);
        assert.ok(configRequests > 0, 'E2E must request the Blocks config even when the page is customized');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    });
  }
});
