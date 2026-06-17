// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { spawn, ChildProcess, execSync, execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { api as apiType } from 'aws-blocks';
import { installCookieJar } from './cookie-jar.js';
import { kvStoreTests } from './kv-store.test.js';
import { distributedTableTests } from './distributed-table.test.js';
import { realtimeTests } from './realtime.test.js';
import { basicAuthTests } from './basic-auth.test.js';
import { authCookieAttrsTests } from './auth-cookie-attrs.test.js';
import { authCognitoTests } from './auth-cognito.test.js';
import { authCognitoSandboxTests } from './auth-cognito-sandbox.test.js';
import { oidcAuthTests } from './oidc-auth.test.js';
import { databaseTests } from './database.test.js';
import { dsqlTests } from './dsql.test.js';
import { asyncJobTests } from './async-job.test.js';
import { agentTests } from './agent.test.js';
import { cronJobTests } from './cron-job.test.js';
import { fileBucketTests } from './file-bucket.test.js';
import { appSettingTests } from './app-setting.test.js';
import { knowledgeBaseTests } from './knowledge-base.test.js';
import { emailClientTests } from './email-client.test.js';
import { rawRouteTests } from './raw-route.test.js';
import { consoleShortcutTests } from './console-shortcuts.test.js';
import { cliClientTests } from './cli-client.test.js';
import { tracerTests } from './tracer.test.js';
import { metricsTests } from './metrics.test.js';
import { loggingTests } from './logging.test.js';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const __dirname = dirname(fileURLToPath(import.meta.url));
const backendPath = join(__dirname, '..', 'aws-blocks', 'index.cdk.ts');

let server: ChildProcess | null = null;
let api: typeof apiType;

async function waitForServer(maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await api.kvGet('test');
      return;
    } catch {}
    await setTimeout(1000);
  }
  throw new Error('Server not ready');
}

// Setup - start server and import API after it's ready
test.before(async () => {
  // Type check the backend
  console.log('🔍 Type checking backend...');
  try {
    execSync('npx tsc --noEmit', {
      cwd: process.cwd(),
      stdio: 'pipe'
    });
    console.log('✅ Type check passed\n');
  } catch (error: any) {
    console.error('❌ Type check failed:');
    console.error(error.stdout?.toString() || error.stderr?.toString());
    throw new Error('TypeScript compilation failed');
  }
  
  if (ENV === 'local') {
    console.log('🚀 Starting local dev server...');
    
    server = spawn('npm', ['run', 'dev:server'], {
      cwd: process.cwd(),
      stdio: 'pipe',
      detached: true,
      env: { ...process.env, NODE_OPTIONS: '' }
    });
    
    // Wait for the server to signal it's fully ready (client.js generated,
    // HTTP listening) by watching for the "running on" line in stdout.
    await new Promise<void>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        reject(new Error('Dev server did not become ready within 60s'));
      }, 60_000);

      server!.stdout?.on('data', (d: Buffer) => {
        process.stdout.write(d);
        if (d.toString().includes('local server running on')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      server!.on('error', (err) => { clearTimeout(timeout); reject(err); });
      server!.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Dev server exited with code ${code} before becoming ready`));
      });
    });
  } else if (ENV === 'sandbox') {
    console.log('🚀 Deploying sandbox...\n');
    
    // Run startSandbox in a clean subprocess (no -C browser) so that
    // codegen imports resolve to server-side modules correctly.
    // Invoke via `node --import tsx` (not `npx`) so it works on Windows, where
    // npx is a .cmd shim that execFileSync can't resolve (spawnSync npx ENOENT).
    execFileSync('node', ['--import', 'tsx', 'test/sandbox-deploy.ts', backendPath], {
      cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' }
    });
    
    console.log('\n✅ Sandbox deployed\n');
  } else if (ENV === 'production') {
    console.log('🚀 Deploying production (no sandboxMode)...\n');
    
    execFileSync('node', ['--import', 'tsx', 'test/production-deploy.ts', backendPath], {
      cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' }
    });
    
    console.log('\n✅ Production deployed\n');
  } else {
    console.log(`🌐 Testing against ${ENV}...`);
  }
  
  // Install a cookie jar on global.fetch so Set-Cookie headers from the
  // server persist across requests — Node's fetch doesn't do this natively.
  installCookieJar();

  // Import API after config is written
  const module = await import('aws-blocks');
  api = module.api;
  
  await waitForServer();
  console.log('✅ Server ready\n');
});

test.after(async (t) => {
  if (server) {
    console.log('\n🛑 Stopping local server...');
    // Kill the entire process group (npm + tsx grandchild)
    try { process.kill(-server.pid!, 'SIGTERM'); } catch {}
    server.kill('SIGKILL');
  }
  
  if ((ENV === 'sandbox' || ENV === 'production') && !process.env.BLOCKS_SANDBOX_KEEP) {
    const destroyScript = ENV === 'sandbox' ? 'test/sandbox-destroy.ts' : 'test/production-destroy.ts';
    console.log(`\n🗑️  Destroying ${ENV} stack...`);
    execFileSync('node', ['--import', 'tsx', destroyScript, backendPath], {
      cwd: process.cwd(), stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' }
    });
    console.log(`✅ ${ENV} stack destroyed`);
  }

  // Backstop: if open handles prevent node:test from exiting, force-exit
  // after a grace period. This timer is unref'd so it does NOT keep the
  // event loop alive — if all handles close, node:test exits naturally
  // with the correct process.exitCode and this timer never fires.
  //
  // Exit 1 because if we reach this point, a test is leaking a handle
  // (WebSocket, DB client, fetch stream, etc.) — fix the leak rather than
  // extending the timeout.
  const backstop = globalThis.setTimeout(() => {
    console.error('\n⚠️  Open handles prevented clean exit after 15s — forcing exit with code 1');
    console.error('Some test is leaking a handle (WebSocket, DB client, fetch stream). Fix the leak.');
    process.exit(1);
  }, 15000);
  backstop.unref();
});

test('Sanity check - API calls use HTTP not direct imports', { timeout: 10_000 }, async () => {
  // Spy on global fetch to verify network calls are being made
  const originalFetch = global.fetch;
  let fetchCalled = false;
  
  global.fetch = (async (...args) => {
    fetchCalled = true;
    return originalFetch(...args);
  }) as typeof fetch;
  
  try {
    await api.kvGet('sanity-check');
    assert.ok(fetchCalled, 'API call should use fetch() not direct import');
  } finally {
    global.fetch = originalFetch;
  }
});

// KVStore tests (separate file)
kvStoreTests(() => api);

// DistributedTable tests (separate file)
distributedTableTests(() => api);

// Database tests (separate file)
databaseTests(() => api);

// DSQL Database tests (separate file)
dsqlTests(() => api);

// AppSetting tests (separate file)
appSettingTests(() => api);

// Realtime tests (separate file)
realtimeTests(() => api);

// AuthBasic tests (separate file)
basicAuthTests(() => api);

// AuthBasic cookie-attribute convergence tests (separate file)
authCookieAttrsTests(() => api);

// AuthCognito tests (separate file)
authCognitoTests(() => api);

// AuthCognito Sandbox tests (separate file)
authCognitoSandboxTests(() => api);

// AuthOIDC tests (separate file)
oidcAuthTests(() => api);

// Database tests (separate file)
databaseTests(() => api);

// AsyncJob tests (separate file)
asyncJobTests(() => api);

// CronJob tests (separate file)
cronJobTests(() => api);

// FileBucket tests (separate file)
fileBucketTests(() => api);

// KnowledgeBase tests (separate file)
knowledgeBaseTests(() => api);

// Logging BB tests (separate file)
loggingTests(() => api);

// EmailClient tests (separate file)
emailClientTests(() => api);

// Metrics tests (separate file)
metricsTests(() => api);

// RawRoute tests (separate file)
rawRouteTests();

// Console shortcut tests (separate file)
consoleShortcutTests();

// CLI client tests (separate file)
cliClientTests();

// Tracer tests (separate file)
tracerTests(() => api);

// Agent BB tests last — uses Realtime internally, may affect WS server state
agentTests(() => api);

test('Context - access headers', { timeout: 10_000 }, async () => {
  const headers = await api.echoHeaders();
  assert.ok(headers['content-type']);
  assert.strictEqual(headers['content-type'], 'application/json');
});

test('Error handling - propagates errors', { timeout: 10_000 }, async () => {
  await assert.rejects(() => api.throwError('test error'), /test error/);
});

test('Data types - serialization', { timeout: 10_000 }, async () => {
  assert.strictEqual(await api.echoData('string'), 'string');
  assert.strictEqual(await api.echoData(42), 42);
  assert.strictEqual(await api.echoData(true), true);
  assert.deepStrictEqual(await api.echoData({ key: 'value' }), { key: 'value' });
  assert.deepStrictEqual(await api.echoData([1, 2, 3]), [1, 2, 3]);
  assert.strictEqual(await api.echoData(null), null);
});
