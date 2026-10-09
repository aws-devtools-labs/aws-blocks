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

  it('returns a JSON usage hint (not an empty body) for a GET on the API path', async () => {
    const port = await getAvailablePort();
    tempDir = join(tmpdir(), `dev-404-test-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'backend.ts'), `
export const testApi = {
  pingVoid: async () => undefined,
};
`);
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
      env: { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1', BLOCKS_DEV_QUIET: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    devProcess.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    devProcess.stderr?.on('data', chunk => { stderr += chunk.toString(); });

    // A GET on the API path (e.g. opening it in a browser) hits the API handler
    // but not the POST branch — the exact case that used to return an empty 404.
    const deadline = Date.now() + 15_000;
    let response: Response | undefined;
    let lastError: unknown;
    while (!response && Date.now() < deadline) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/aws-blocks/api`, { method: 'GET' });
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    assert.ok(response, `Dev server did not respond: ${String(lastError)}\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.strictEqual(response.status, 404);
    assert.strictEqual(response.headers.get('content-type'), 'application/json');
    const payload = await response.json() as { error?: string; expected?: { method?: string; path?: string } };
    assert.match(payload.error ?? '', /POST/, `404 body should hint at the POST requirement: ${JSON.stringify(payload)}`);
    assert.strictEqual(payload.expected?.method, 'POST');
    assert.strictEqual(payload.expected?.path, '/aws-blocks/api');
  });

  it('sanitizes an uncaught RawRoute exception to a generic 500 while preserving a handler-set header', async () => {
    const port = await getAvailablePort();
    tempDir = join(tmpdir(), `dev-rawroute-err-test-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
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
    writeFileSync(join(tempDir, 'preload.mjs'), `
if (!process.loadEnvFile) {
  process.loadEnvFile = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
}
`);
    writeFileSync(join(tempDir, 'run-dev.ts'), `
import { startDevServer } from '${join(__dirname, 'dev-server.js').replace(/\\\\/g, '/')}';
startDevServer({ backendPath: '${join(tempDir, 'backend.ts').replace(/\\\\/g, '/')}', port: ${port} });
`);

    const tsxBin = join(__dirname, '..', '..', '..', '..', 'node_modules', '.bin', 'tsx');
    // Quiet mode: the sanitized error path must NOT spam the full error+stack to
    // stderr when BLOCKS_DEV_QUIET is set (it gates logging like the RPC catch).
    devProcess = spawn(tsxBin, ['--import', join(tempDir, 'preload.mjs'), join(tempDir, 'run-dev.ts')], {
      cwd: tempDir,
      env: { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1', BLOCKS_DEV_QUIET: '1' },
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
        response = await fetch(`http://127.0.0.1:${port}/boom`, { method: 'GET' });
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    assert.ok(response, `Dev server did not respond: ${String(lastError)}\nstdout: ${stdout}\nstderr: ${stderr}`);
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
    assert.ok(!stderr.includes('ECONNREFUSED'), `Quiet mode leaked raw text to stderr: ${stderr}`);
    assert.ok(!stderr.includes('RawRoute Error'), `Quiet mode should suppress the RawRoute error log: ${stderr}`);
  });

  it('delivers only cookie deletions on an RPC error response; an error without cookies is unchanged', async () => {
    const port = await getAvailablePort();
    tempDir = join(tmpdir(), `dev-rpc-err-cookie-test-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const errorsModule = join(__dirname, '..', 'errors.js').replace(/\\/g, '/');
    // A method that clears the session cookie and then throws 401 (the
    // `requireAuth`-on-a-deleted-user case), and one that throws with no cookies.
    writeFileSync(join(tempDir, 'backend.ts'), `
import { ApiError } from '${errorsModule}';
export const testApi = (ctx: any) => ({
  clearThenThrow: async () => {
    ctx.response.headers.set('set-cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
    ctx.response.headers.set('x-not-forwarded', 'yes');
    throw new ApiError('Authentication required', 401, { name: 'NotAuthenticated' });
  },
  plainThrow: async () => {
    throw new ApiError('Conflict', 409, { name: 'AlreadyExists' });
  },
  // Sign in, then a post-sign-in check rejects the user: no live session may leak.
  signInThenThrow: async () => {
    ctx.response.headers.set('set-cookie', 'session=s3cr3t; Path=/; HttpOnly; Max-Age=3600');
    throw new ApiError('forbidden', 403, { name: 'Forbidden' });
  },
  liveAndClearThenThrow: async () => {
    ctx.response.headers.append('set-cookie', 'session=s3cr3t; Path=/; HttpOnly; Max-Age=3600');
    ctx.response.headers.append('set-cookie', 'bridge=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    throw new ApiError('forbidden', 403, { name: 'Forbidden' });
  },
  signInOk: async () => {
    ctx.response.headers.set('set-cookie', 'session=s3cr3t; Path=/; HttpOnly; Max-Age=3600');
    return 'ok';
  },
});
`);
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
      env: { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1', BLOCKS_DEV_QUIET: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    devProcess.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    devProcess.stderr?.on('data', chunk => { stderr += chunk.toString(); });

    const call = (method: string) => fetch(`http://127.0.0.1:${port}/aws-blocks/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: `testApi.${method}`, params: [], id: 1 }),
    });

    const deadline = Date.now() + 15_000;
    let response: Response | undefined;
    let lastError: unknown;
    while (!response && Date.now() < deadline) {
      try {
        response = await call('clearThenThrow');
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    assert.ok(response, `Dev server did not respond: ${String(lastError)}\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.headers.getSetCookie(), ['session=; Path=/; HttpOnly; Max-Age=0']);
    assert.strictEqual(response.headers.get('x-not-forwarded'), null, 'only cookies carry over to the error response');
    const errPayload = await response.json() as { error?: { code?: number; data?: { name?: string } } };
    assert.strictEqual(errPayload.error?.code, 401);
    assert.strictEqual(errPayload.error?.data?.name, 'NotAuthenticated');

    const plain = await call('plainThrow');
    assert.strictEqual(plain.status, 200);
    assert.deepStrictEqual(plain.headers.getSetCookie(), []);
    assert.strictEqual(plain.headers.get('content-type'), 'application/json');
    const plainPayload = await plain.json() as { error?: { code?: number; data?: { name?: string } } };
    assert.strictEqual(plainPayload.error?.code, 409);
    assert.strictEqual(plainPayload.error?.data?.name, 'AlreadyExists');

    // Only cookie deletions survive an error response.
    const signInThrow = await call('signInThenThrow');
    assert.deepStrictEqual(signInThrow.headers.getSetCookie(), [], 'a live session cookie must not ride an error');
    assert.strictEqual((await signInThrow.json() as { error?: { code?: number } }).error?.code, 403);

    const mixed = await call('liveAndClearThenThrow');
    assert.deepStrictEqual(mixed.headers.getSetCookie(), ['bridge=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']);
    assert.strictEqual((await mixed.json() as { error?: { code?: number } }).error?.code, 403);

    // Success responses still carry live cookies.
    const ok = await call('signInOk');
    assert.deepStrictEqual(ok.headers.getSetCookie(), ['session=s3cr3t; Path=/; HttpOnly; Max-Age=3600']);
  });
  it('dispatches only to the methods an API defines — never inherited members or exported blocks', async () => {
    const port = await getAvailablePort();
    tempDir = join(tmpdir(), `dev-rpc-dispatch-test-${process.pid}-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const apiModule = join(__dirname, '..', 'api.js').replace(/\\/g, '/');
    writeFileSync(join(tempDir, 'backend.ts'), `
import { ApiNamespace } from '${apiModule}';
const shared = { async composed() { return 'composed'; } };
export const api = new ApiNamespace({ id: 'app' }, 'api', (_ctx: any) => ({
  async echo(msg: string) { return msg; },
  async viaThis() { return this.echo('bound'); },
  ...shared,
  async toString() { return 'app-defined toString'; },
}));
export const auth = new ApiNamespace({ id: 'app' }, 'auth', (_ctx: any) => ({
  getAuthState: async () => ({ state: 'signedOut' }),
  setAuthState: async (input: { action: string }) => ({ state: 'signedOut', action: input.action }),
}));
export const plainApi = { async ping() { return 'pong'; } };
class FakeBlock {
  readonly id = 'notes';
  readonly fullId = 'app-notes';
  async get(_key: string) { return 'stored-secret'; }
}
export const notes = new FakeBlock();
`);
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
      env: { ...process.env, AWS_BLOCKS_DISABLE_TELEMETRY: '1', BLOCKS_DEV_QUIET: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    devProcess.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    devProcess.stderr?.on('data', chunk => { stderr += chunk.toString(); });

    const call = async (method: string, params: unknown[] = []) => {
      const res = await fetch(`http://127.0.0.1:${port}/aws-blocks/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      });
      return { status: res.status, body: await res.json() as Record<string, any> };
    };

    const deadline = Date.now() + 15_000;
    let first: Awaited<ReturnType<typeof call>> | undefined;
    let lastError: unknown;
    while (!first && Date.now() < deadline) {
      try {
        first = await call('api.echo', ['hi']);
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert.ok(first, `Dev server did not respond: ${String(lastError)}\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.strictEqual(first.body.result, 'hi');

    const unknownMethod = (method: string, ns: string) =>
      ({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: '${method}' on API '${ns}'` }, id: 1 });

    // Every Object.prototype member is "method not found" — exactly like an unknown name.
    const inherited = [
      'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
      'toLocaleString', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', '__proto__',
    ];
    for (const name of inherited) {
      const r = await call(`auth.${name}`, [{ action: 'x' }]);
      assert.strictEqual(r.status, 200, name);
      assert.deepStrictEqual(r.body, unknownMethod(name, 'auth'), name);
    }
    const unknown = await call('auth.doesNotExist');
    assert.deepStrictEqual(unknown.body, unknownMethod('doesNotExist', 'auth'));

    // Crafted paths can't walk the prototype chain.
    for (const [wire, method] of [['api.__proto__.toString', '__proto__.toString'], ['api.constructor.constructor', 'constructor.constructor'], ['api.echo.call', 'echo.call']]) {
      assert.deepStrictEqual((await call(wire, ['x'])).body, unknownMethod(method, 'api'), wire);
    }
    // Unknown / inherited / exported-block namespaces are all "API not found", listing only real APIs.
    for (const ns of ['constructor', '__proto__', 'toString', 'notes', 'nope']) {
      const r = await call(`${ns}.get`, ['k']);
      assert.strictEqual(r.body.error?.code, -32601, ns);
      assert.strictEqual(r.body.error?.message, `Method not found: API '${ns}' not found. Available: api, auth, plainApi`, ns);
      assert.strictEqual('data' in r.body.error, false, ns);
    }

    // Legitimate methods still dispatch.
    const legit: Array<[string, unknown[], unknown]> = [
      ['api.composed', [], 'composed'],
      ['api.viaThis', [], 'bound'],
      ['api.toString', [], 'app-defined toString'],
      ['plainApi.ping', [], 'pong'],
      ['auth.getAuthState', [], { state: 'signedOut' }],
      ['auth.setAuthState', [{ action: 'signOut' }], { state: 'signedOut', action: 'signOut' }],
    ];
    for (const [wire, params, expected] of legit) {
      const r = await call(wire, params);
      assert.ok(!r.body.error, `${wire} errored: ${JSON.stringify(r.body.error)}`);
      assert.deepStrictEqual(r.body.result, expected, wire);
    }
  });
});
