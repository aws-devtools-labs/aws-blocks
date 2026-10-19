import { afterEach, beforeEach, describe, it } from 'node:test';
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
  let tempDir = '';
  let output = { stdout: '', stderr: '' };

  beforeEach(() => {
    devProcess = null;
    output = { stdout: '', stderr: '' };
    tempDir = join(tmpdir(), `dev-rpc-test-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'backend.ts'), `
export const testApi = {
  pingVoid: async () => undefined,
};
`);
  });

  function startDevProcess(port: number, options: { frontendPort?: number; env?: NodeJS.ProcessEnv } = {}) {
    writeFileSync(join(tempDir, 'run-dev.ts'), `
import { startDevServer } from ${JSON.stringify(join(__dirname, 'dev-server.js'))};
startDevServer(${JSON.stringify({
      backendPath: join(tempDir, 'backend.ts'),
      port,
      frontendPort: options.frontendPort,
      frontendCommand: options.frontendPort === undefined
        ? undefined : `'${process.execPath.replace(/'/g, "'\\''")}' frontend.mjs`,
      typegen: false,
    })});
`);
    const tsxBin = join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
    devProcess = spawn(tsxBin, [join(tempDir, 'run-dev.ts')], {
      cwd: tempDir,
      env: {
        ...process.env,
        AWS_BLOCKS_DISABLE_TELEMETRY: '1',
        BLOCKS_DEV_QUIET: '1',
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Return a live object so assertions see output received after startup.
    const processOutput = output;
    devProcess.stdout?.on('data', chunk => { processOutput.stdout += chunk.toString(); });
    devProcess.stderr?.on('data', chunk => { processOutput.stderr += chunk.toString(); });
    return processOutput;
  }

  async function fetchWhenReady(
    url: string,
    init: RequestInit = {},
    isReady?: (response: Response) => Promise<boolean>,
  ): Promise<Response> {
    const deadline = Date.now() + 15_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(1_000) });
        // Ordinary requests return any HTTP status with their body untouched.
        // Only frontend startup needs to wait for a specific readiness response.
        if (!isReady || await isReady(response)) return response;
        if (!response.bodyUsed) await response.arrayBuffer();
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`Dev server did not become ready at ${url}: ${String(lastError)}\nstdout: ${output.stdout}\nstderr: ${output.stderr}`);
  }

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

  it('reuses frontend upstream connections for sequential asset requests', async (t) => {
    const [port, frontendPort] = await Promise.all([getAvailablePort(), getAvailablePort()]);
    // Count only sockets serving assets; startup/readiness connections do not
    // contribute to the regression's bounded upstream connection budget.
    writeFileSync(join(tempDir, 'frontend.mjs'), `
import { createServer } from 'node:http';
const socketIds = new WeakMap();
let nextSocketId = 0;
createServer((request, response) => {
  if (request.url === '/ready') {
    response.end('ready');
    return;
  }
  if (request.url !== '/asset.js') {
    response.writeHead(404).end();
    return;
  }
  let socketId = socketIds.get(request.socket);
  if (socketId === undefined) {
    socketId = ++nextSocketId;
    socketIds.set(request.socket, socketId);
  }
  response.writeHead(200, { 'Content-Type': 'text/javascript', 'X-Upstream-Socket': String(socketId) });
  response.end('export const asset = true;');
}).listen(${frontendPort});
`);
    startDevProcess(port, { frontendPort, env: { BLOCKS_API_URL: '' } });
    await fetchWhenReady(`http://127.0.0.1:${port}/ready`, {}, async response =>
      response.status === 200 && await response.text() === 'ready');

    const socketIds = new Set<string>();
    for (let request = 1; request <= 24; request++) {
      const response = await fetch(`http://127.0.0.1:${port}/asset.js`, { signal: AbortSignal.timeout(2_000) });
      const body = await response.text();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(body, 'export const asset = true;');
      const socketId = response.headers.get('x-upstream-socket');
      assert.ok(socketId && /^\d+$/.test(socketId), `Missing upstream socket identity on asset request ${request}`);
      socketIds.add(socketId);
      assert.ok(socketIds.size <= 4,
        `${request} sequential asset requests opened ${socketIds.size} upstream sockets; expected at most 4 (IDs: ${[...socketIds].join(', ')})`);
    }
    t.diagnostic(`24 sequential asset requests used ${socketIds.size} upstream sockets`);
  });

  it('returns success for a void handler in verbose mode', async () => {
    const port = await getAvailablePort();
    // Empty is falsy, keeping verbose logging on even if the parent sets quiet mode.
    const output = startDevProcess(port, { env: { BLOCKS_DEV_QUIET: '' } });

    const response = await fetchWhenReady(`http://127.0.0.1:${port}/aws-blocks/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'testApi.pingVoid', params: [], id: 1 }),
    });
    assert.strictEqual(response.status, 200);
    const payload = await response.json() as Record<string, unknown>;
    assert.strictEqual(payload.jsonrpc, '2.0');
    assert.strictEqual(payload.id, 1);
    assert.ok(!('error' in payload), `Unexpected RPC error: ${JSON.stringify(payload.error)}`);

    const logDeadline = Date.now() + 1_000;
    while (!output.stdout.includes('[rpc-ok] testApi.pingVoid') && Date.now() < logDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(output.stdout.includes('[rpc-ok] testApi.pingVoid'), `Missing verbose success log. stdout: ${output.stdout}`);
    assert.ok(!output.stdout.includes('[rpc-err]'), `Unexpected RPC error log. stdout: ${output.stdout}`);
  });

  it('returns a JSON usage hint (not an empty body) for a GET on the API path', async () => {
    const port = await getAvailablePort();
    startDevProcess(port);

    // A GET on the API path (e.g. opening it in a browser) hits the API handler
    // but not the POST branch — the exact case that used to return an empty 404.
    const response = await fetchWhenReady(`http://127.0.0.1:${port}/aws-blocks/api`, { method: 'GET' });
    assert.strictEqual(response.status, 404);
    assert.strictEqual(response.headers.get('content-type'), 'application/json');
    const payload = await response.json() as { error?: string; expected?: { method?: string; path?: string } };
    assert.match(payload.error ?? '', /POST/, `404 body should hint at the POST requirement: ${JSON.stringify(payload)}`);
    assert.strictEqual(payload.expected?.method, 'POST');
    assert.strictEqual(payload.expected?.path, '/aws-blocks/api');
  });

  it('sanitizes an uncaught RawRoute exception to a generic 500 while preserving a handler-set header', async () => {
    const port = await getAvailablePort();
    // A RawRoute whose handler sets a CORS header on ctx.response and THEN throws
    // a raw driver/SDK-style error carrying identifying text. The error path must
    // (a) collapse to a generic 500 { error: 'Internal error' } with no leaked
    // name/message, and (b) still emit the handler-set header — matching the
    // production lambda-handler error path, which reuses responseHeaders.
    writeFileSync(join(tempDir, 'backend.ts'), `
import { RawRoute } from '${join(__dirname, '..', 'index.js').replace(/\\\\/g, '/')}';
new RawRoute({ id: 'test' }, 'boom', {
  method: 'GET',
  path: '/boom',
  handler: async (ctx) => {
    ctx.response.headers.set('Access-Control-Allow-Origin', 'https://app.example.com');
    const err = new Error('connect ECONNREFUSED 10.0.0.5:5432 secret-cluster.internal');
    err.name = 'SequelizeConnectionRefusedError';
    throw err;
  },
});
export const testApi = { pingVoid: async () => undefined };
`);
    // Quiet mode: the sanitized error path must NOT spam the full error+stack to
    // stderr when BLOCKS_DEV_QUIET is set (it gates logging like the RPC catch).
    const output = startDevProcess(port);

    const response = await fetchWhenReady(`http://127.0.0.1:${port}/boom`, { method: 'GET' });
    assert.strictEqual(response.status, 500);
    assert.strictEqual(response.headers.get('content-type'), 'application/json');
    // The handler-set CORS header survives the error response.
    assert.strictEqual(response.headers.get('access-control-allow-origin'), 'https://app.example.com');

    const raw = await response.text();
    const payload = JSON.parse(raw) as { error?: string; name?: string };
    assert.strictEqual(payload.error, 'Internal error');
    // No raw driver name/message/host leaks anywhere in the serialized body.
    assert.ok(!raw.includes('ECONNREFUSED'), `Leaked raw driver message: ${raw}`);
    assert.ok(!raw.includes('secret-cluster.internal'), `Leaked raw host: ${raw}`);
    assert.ok(!raw.includes('SequelizeConnectionRefusedError'), `Leaked raw error name: ${raw}`);

    // Quiet mode suppresses the error log and never leaks the raw text to stderr.
    const logDeadline = Date.now() + 500;
    while (Date.now() < logDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(!output.stderr.includes('ECONNREFUSED'), `Quiet mode leaked raw text to stderr: ${output.stderr}`);
    assert.ok(!output.stderr.includes('RawRoute Error'), `Quiet mode should suppress the RawRoute error log: ${output.stderr}`);
  });
});
