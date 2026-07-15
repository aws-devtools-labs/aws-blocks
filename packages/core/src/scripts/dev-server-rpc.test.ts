import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  // TOCTOU: brief window between closing this probe and the dev server binding
  // the port; port: 0 would require the dev server to expose its assigned port.
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

describe('dev-server RPC integration', () => {
  let devProcess: ChildProcess | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (devProcess && devProcess.exitCode === null) {
      devProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          devProcess?.kill('SIGKILL');
          resolve();
        }, 2_000);
        devProcess?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns success for a void handler in verbose mode', async () => {
    const port = await getAvailablePort();
    tempDir = join(tmpdir(), `dev-rpc-test-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'backend.ts'), `
export const testApi = {
  pingVoid: async () => undefined,
};
`);
    // Polyfill process.loadEnvFile for Node <20.6; ENOENT means no .env file.
    writeFileSync(join(tempDir, 'preload.mjs'), `
if (!process.loadEnvFile) {
  process.loadEnvFile = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
}
`);
    writeFileSync(join(tempDir, 'run-dev.ts'), `
import { startDevServer } from '${join(__dirname, 'dev-server.js').replace(/\\/g, '/')}';
startDevServer({ backendPath: '${join(tempDir, 'backend.ts').replace(/\\/g, '/')}', port: ${port} });
`);

    const tsxBin = join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
    devProcess = spawn(tsxBin, ['--import', join(tempDir, 'preload.mjs'), join(tempDir, 'run-dev.ts')], {
      cwd: tempDir,
      env: {
        ...process.env,
        AWS_BLOCKS_DISABLE_TELEMETRY: '1',
        // Empty is falsy, keeping verbose logging on even if the parent sets quiet mode.
        BLOCKS_DEV_QUIET: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    devProcess.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    devProcess.stderr?.on('data', chunk => { stderr += chunk.toString(); });

    const deadline = Date.now() + 15_000;
    let response: Response | undefined;
    let lastError: unknown;
    while (!response && Date.now() < deadline) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/aws-blocks/api`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'testApi.pingVoid', params: [], id: 1 }),
        });
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    assert.ok(response, `Dev server did not respond: ${String(lastError)}\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.strictEqual(response.status, 200);
    const payload = await response.json() as Record<string, unknown>;
    assert.strictEqual(payload.jsonrpc, '2.0');
    assert.strictEqual(payload.id, 1);
    assert.ok(!('error' in payload), `Unexpected RPC error: ${JSON.stringify(payload.error)}`);

    const logDeadline = Date.now() + 1_000;
    while (!stdout.includes('[rpc-ok] testApi.pingVoid') && Date.now() < logDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(stdout.includes('[rpc-ok] testApi.pingVoid'), `Missing verbose success log. stdout: ${stdout}`);
    assert.ok(!stdout.includes('[rpc-err]'), `Unexpected RPC error log. stdout: ${stdout}`);
  });
});
