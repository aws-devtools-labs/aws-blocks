 // Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL, URL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import httpProxy from 'http-proxy';
import { writeClientCode } from './generate-client.js';
import { ApiError } from '../errors.js';
import { BLOCKS_RPC_PREFIX, BLOCKS_SANDBOX_PREFIX } from '../constants.js';
import { matchRoute, lockRouteRegistry } from '../raw-route.js';
import { registerBuiltinRoutes } from '../builtin-routes.js';
import {
  parseRpcRequest,
  successResponse,
  errorResponseFromCatch,
  methodNotFoundResponse,
} from '../rpc.js';
import { redactToJson } from '../redact.js';
import { buildAndSendEvent } from '../telemetry/client.js';
import { applyDevMigrations } from './external-migrations-step.js';

function toBodyStream(text: string): ReadableStream<Uint8Array> | null {
  if (!text) return null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

export const LOCALHOST_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Resolve the CORS origin for the dev server.
 * Reflects back origins matching localhost/127.0.0.1; otherwise returns the fallback.
 */
export function resolveDevCorsOrigin(origin: string): string {
  return LOCALHOST_PATTERN.test(origin) ? origin : 'http://localhost:3000';
}

/** Shape of the client runtime config the browser fetches to discover the API URL. */
export interface BlocksRuntimeConfig {
  apiUrl: string;
  environment: 'local' | 'sandbox';
}

/**
 * Build the runtime config the browser fetches at `${BLOCKS_SANDBOX_PREFIX}/config.json`.
 * In sandbox mode the browser still targets the localhost front door (the dev
 * server proxies `/aws-blocks/api` to the deployed API), so the shape is the
 * same in both modes — only `environment` differs.
 */
export function buildBlocksConfig(port: number, isSandbox: boolean): BlocksRuntimeConfig {
  return {
    apiUrl: `http://localhost:${port}${BLOCKS_RPC_PREFIX}`,
    environment: isSandbox ? 'sandbox' : 'local',
  };
}

/**
 * True for the reserved runtime-config request the dev server answers itself
 * (mirroring production, where CloudFront serves `${BLOCKS_SANDBOX_PREFIX}/*`
 * statically) instead of proxying it to the framework dev server — which only
 * serves its own static dir (Next.js `public/`, etc.) and would 404.
 */
export function isBlocksConfigRequest(method: string, pathname: string): boolean {
  return method === 'GET' && pathname === `${BLOCKS_SANDBOX_PREFIX}/config.json`;
}

export interface DevServerOptions {
  /** Customer-facing port. Default: 3000. */
  port?: number;
  /** Path to the backend index.ts. */
  backendPath: string;
  /**
   * Command to start the frontend dev server (e.g., 'npx vite --port 3100 --strictPort').
   * Omit to run backend-only (no frontend proxy).
   */
  frontendCommand?: string;
  /** Port the frontend dev server listens on. Default: 3100. */
  frontendPort?: number;
}

/**
 * Initialize all building blocks that have an initialize() method.
 * This is the "local deploy" phase - mirrors CDK deploy.
 */
async function deployLocal(backend: Record<string, any>): Promise<void> {
  const initPromises: Promise<void>[] = [];
  for (const [name, value] of Object.entries(backend)) {
    if (value && typeof value.initialize === 'function') {
      console.log(`  Initializing ${name}...`);
      initPromises.push(value.initialize());
    }
  }
  await Promise.all(initPromises);
}

/** Wait for a port to accept TCP connections. */
async function waitForPort(port: number, maxAttempts = 60): Promise<void> {
  const { setTimeout: sleep } = await import('node:timers/promises');
  for (let i = 0; i < maxAttempts; i++) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: 'localhost' }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.setTimeout(300, () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await sleep(500);
  }
  throw new Error(`Frontend server on port ${port} did not start within ${maxAttempts * 500}ms`);
}

export async function startDevServer(options: DevServerOptions) {
  const {
    port = 3000,
    backendPath,
    frontendCommand,
    frontendPort = 3100,
  } = options;
  const devStartTime = Date.now();

  // Load .env.local if present (connection strings, project refs, etc.)
  try { process.loadEnvFile('.env.local'); } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }

  // Apply pending external-database migrations to the dev database so the schema
  // change is live locally and the generated types are refreshed from it.
  // No-op for managed/PGlite apps; refuses if .env.local points at production.
  await applyDevMigrations();

  // Resolve path and convert to file URL for dynamic import
  const resolvedPath = resolve(backendPath);
  const backendUrl = pathToFileURL(resolvedPath).href;

  // Detect sandbox: if BLOCKS_API_URL env var is set (by sandbox.ts), proxy to it.
  const isSandbox = !!process.env.BLOCKS_API_URL;
  const apiTarget = isSandbox ? process.env.BLOCKS_API_URL!.replace(/\/aws-blocks\/api$/, '') : null;

  // Write config for client-side JS — always reflects the current mode.
  // In sandbox, point the browser at the localhost front door (not the raw
  // execute-api URL) so the data-plane RPC is same-origin with the page and the
  // session cookie — set host-scoped to localhost during the auth callback — is
  // sent on every request. The dev server proxies `/aws-blocks/api` to
  // BLOCKS_API_URL server-side, so the request still reaches the deployed Lambda.
  // This makes sandbox single-origin, matching `npm run dev` and the prod
  // CloudFront proxy; `crossDomain` stays unnecessary.
  const blocksConfig = buildBlocksConfig(port, isSandbox);
  mkdirSync('.blocks-sandbox', { recursive: true });
  writeFileSync('.blocks-sandbox/config.json', JSON.stringify(blocksConfig, null, 2));

  // 1. Set up global collectors for plugin discovery
  (globalThis as any).__BLOCKS_CLIENT_MIDDLEWARE__ = [];
  (globalThis as any).__BLOCKS_DEV_ATTACHMENTS__ = [];

  // 2. Import backend (sync construction phase — BBs register plugins via globals)
  console.log('Loading backend...');
  const backend = await import(backendUrl);

  // 3. Read collected dev attachments and clean up
  const devAttachments: string[] = (globalThis as any).__BLOCKS_DEV_ATTACHMENTS__;
  delete (globalThis as any).__BLOCKS_DEV_ATTACHMENTS__;

  // 4. Deploy local (async initialization phase) — skip in sandbox mode
  if (!isSandbox) {
    console.log('Deploying local resources...');
    await deployLocal(backend);
  }

  // 5. Collect APIs for runtime
  const apis = new Map<string, any>();
  for (const [exportName, exportValue] of Object.entries(backend)) {
    if (typeof exportValue === 'function' || typeof exportValue === 'object') {
      apis.set(exportName, exportValue);
    }
  }

  registerBuiltinRoutes();
  lockRouteRegistry();

  // ── Frontend proxy ─────────────────────────────────────────────────────
  let frontendProcess: ChildProcess | null = null;
  const frontendProxy = frontendCommand
    ? httpProxy.createProxyServer({ target: `http://localhost:${frontendPort}`, ws: true })
    : null;

  frontendProxy?.on('error', (_err, _req, res) => {
    if (!res || typeof (res as any).writeHead !== 'function') return;
    if ((res as ServerResponse).headersSent) return;
    (res as ServerResponse).writeHead(502);
    (res as ServerResponse).end('Frontend server unavailable');
  });

  // ── API Gateway proxy (sandbox mode) ───────────────────────────────────
  // `changeOrigin: true` rewrites the outgoing `Host` to the execute-api target
  // (required for API Gateway's TLS SNI / host-based routing). That would make
  // the backend compute absolute URLs (OIDC redirect_uri, stub issuer URLs)
  // against the execute-api host instead of this localhost front door, breaking
  // redirect-based auth in sandbox. We forward the real front-door host via
  // `X-Forwarded-Host`; the Lambda honors it only because it is loopback (see
  // `isLoopbackForwardedHost` in lambda-handler.ts).
  const apiProxy = apiTarget
    ? httpProxy.createProxyServer({
        target: apiTarget,
        changeOrigin: true,
        headers: { 'X-Forwarded-Host': `localhost:${port}` },
      })
    : null;

  apiProxy?.on('error', (err, _req, res) => {
    if ((res as ServerResponse).headersSent) return;
    (res as ServerResponse).writeHead(502);
    (res as ServerResponse).end(JSON.stringify({ error: 'API Gateway unavailable', details: err.message }));
  });

  // ── Request handler ────────────────────────────────────────────────────
  function isApiRequest(method: string, pathname: string): boolean {
    if (pathname === BLOCKS_RPC_PREFIX || pathname.startsWith(BLOCKS_RPC_PREFIX + '/')) return true;
    if (matchRoute(method, pathname)) return true;
    return false;
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const method = req.method || 'GET';

    // CORS headers
    const requestOrigin = req.headers.origin || '';
    const allowedOrigin = resolveDevCorsOrigin(requestOrigin);
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // ── Blocks runtime config ──────────────────────────────────────────
    // Reserved path: serve it from the front door so it works for every
    // framework (Next/Nuxt/Astro/SPA all proxy through this :3000 server),
    // mirroring production where CloudFront serves `${BLOCKS_SANDBOX_PREFIX}/*`
    // statically. Otherwise the request is proxied to the framework dev
    // server, which can't serve this project-root file and 404s.
    if (isBlocksConfigRequest(method, url.pathname)) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(blocksConfig));
      return;
    }

    // ── API/RawRoute requests ──────────────────────────────────────────
    if (isApiRequest(method, url.pathname)) {
      if (isSandbox && apiProxy) {
        apiProxy.web(req, res);
        return;
      }
      handleApiRequest(req, res, url, method, apis);
      return;
    }

    // ── Frontend requests ──────────────────────────────────────────────
    if (frontendProxy) {
      frontendProxy.web(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // WebSocket upgrade — route to frontend (HMR) or dev attachments
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/realtime') return; // handled by dev attachment (noServer mode)
    if (frontendProxy) {
      frontendProxy.ws(req, socket, head);
    } else {
      socket.destroy();
    }
  });

  // ── Attach dev servers ─────────────────────────────────────────────────
  for (const specifier of devAttachments) {
    console.log(`  🔌 Attaching dev server (from ${specifier})`);
    const mod = await import(specifier);
    if (typeof mod.attach !== 'function') {
      throw new Error(`Dev attachment '${specifier}' does not export an attach() function`);
    }
    await mod.attach(server);
  }

  (globalThis as any).__BLOCKS_REALTIME_WS_URL__ = `ws://localhost:${port}/realtime`;
  (globalThis as any).__BLOCKS_DEV_SERVER_PORT__ = port;

  // Config already written during startup (local mode overwrites, sandbox mode preserves).

  // Generate client code — skip in sandbox mode because sandbox.ts already
  // generated it with --conditions=aws-runtime (correct aws-middleware).
  // Re-generating here without that condition would overwrite with mock-middleware.
  if (!isSandbox) {
    const awsBlocksDir = dirname(resolvedPath);
    const clientPath = join(awsBlocksDir, 'client.js');
    console.log('📝 Generating client code...');
    await writeClientCode(resolvedPath, clientPath);
  }

  // ── Start listening ────────────────────────────────────────────────────
  server.listen(port, async () => {
    console.log(`AWS Blocks local server running on http://localhost:${port}`);
    buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: Date.now() - devStartTime });

    // Spawn frontend dev server after Blocks server is ready
    if (frontendCommand) {
      frontendProcess = spawn(frontendCommand, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      // Suppress frontend output — only show errors
      frontendProcess.stderr?.on('data', (d: Buffer) => {
        const msg = d.toString();
        if (!msg.includes('DeprecationWarning')) process.stderr.write(msg);
      });
      frontendProcess.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`⚠️  Frontend process exited with code ${code}`);
        }
      });

      try {
        await waitForPort(frontendPort);
        console.log(`\n  ➜  http://localhost:${port}/\n`);
      } catch (e) {
        console.error(`⚠️  Frontend did not start: ${(e as Error).message}`);
        console.log(`\n  ➜  http://localhost:${port}/  (API only — frontend unavailable)\n`);
      }
    } else {
      console.log(`\n  ➜  http://localhost:${port}/\n`);
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    const errorCode = err.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'UNKNOWN';
    buildAndSendEvent({ command: 'dev', state: 'FAIL', duration: Date.now() - devStartTime, error: { code: errorCode, phase: 'startup' } });
  });

  // ── Cleanup ────────────────────────────────────────────────────────────
  const cleanup = async () => {
    console.log('\nShutting down...');
    if (frontendProcess) frontendProcess.kill('SIGTERM');
    if (typeof backend.__cleanup === 'function') {
      try { await backend.__cleanup(); } catch {}
    }
    frontendProxy?.close();
    apiProxy?.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

// ── Local API handler ────────────────────────────────────────────────────────

function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  apis: Map<string, any>,
): void {
  if (method === 'POST' && url.pathname === BLOCKS_RPC_PREFIX) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      const rpcHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      // Verbose request/response logging — useful when debugging cross-stack
      // wire format mismatches (e.g. native client codegen vs server). Set
      // BLOCKS_DEV_QUIET=1 to suppress. Sensitive fields (passwords, session
      // tokens, OTP codes) are redacted so they never reach the log stream.
      if (!process.env.BLOCKS_DEV_QUIET) {
        let inLog: string;
        try {
          inLog = redactToJson(JSON.parse(body || '{}'));
        } catch {
          // Body isn't valid JSON (parse error surfaced below) — fall back to
          // the raw text. A malformed body can't carry a structured secret,
          // but truncate it like before to keep logs readable.
          inLog = body;
        }
        console.log('[rpc-in]', inLog.length > 800 ? inLog.slice(0, 800) + '…' : inLog);
      }
      const parsed = parseRpcRequest(body);

      if (!parsed.ok) {
        if (!process.env.BLOCKS_DEV_QUIET) console.log('[rpc-out parse-error]', parsed.response);
        res.writeHead(200, rpcHeaders);
        res.end(parsed.response);
        return;
      }

      const { apiNamespace, method: rpcMethod, args, id: rpcId } = parsed.request;
      if (!process.env.BLOCKS_DEV_QUIET) {
        // redactToJson handles circulars and serialization failures itself.
        console.log('[rpc-call]', `${apiNamespace}.${rpcMethod}`, redactToJson(args));
      }

      try {
        const headers = new Headers();
        Object.entries(req.headers).forEach(([k, v]) => {
          headers.set(k, Array.isArray(v) ? v[0] : v || '');
        });

        let responseStatus = 200;
        const responseHeaders = new Headers({ 'Content-Type': 'application/json' });
        let responseBody: any;

        const context = {
          request: {
            headers,
            body: toBodyStream(body),
            json: async () => JSON.parse(body),
            text: async () => body,
            url: new URL(req.url || BLOCKS_RPC_PREFIX, `http://${req.headers.host}`),
            params: {},
          },
          response: {
            headers: responseHeaders,
            get status() { return responseStatus; },
            set status(code: number) { responseStatus = code; },
            send: (b: any) => { responseBody = b; },
          },
        };

        const apiHandler = apis.get(apiNamespace);
        if (!apiHandler) {
          res.writeHead(200, rpcHeaders);
          res.end(methodNotFoundResponse(`API '${apiNamespace}' not found. Available: ${Array.from(apis.keys()).join(', ')}`, rpcId));
          return;
        }

        const apiMethods = typeof apiHandler === 'function' ? apiHandler(context) : apiHandler;

        if (!apiMethods[rpcMethod]) {
          res.writeHead(200, rpcHeaders);
          res.end(methodNotFoundResponse(`'${rpcMethod}' on API '${apiNamespace}'`, rpcId));
          return;
        }

        const result = await apiMethods[rpcMethod](...args);

        const headerObj: Record<string, string | string[]> = {};
        for (const [key, value] of responseHeaders.entries()) {
          if (key === 'set-cookie') continue;
          headerObj[key] = value;
        }
        const setCookies = responseHeaders.getSetCookie?.() ?? [];
        if (setCookies.length > 0) headerObj['set-cookie'] = setCookies;

        const successPayload = successResponse(responseBody ?? result, rpcId);
        if (!process.env.BLOCKS_DEV_QUIET) {
          // Log a redacted copy of the response value — never the raw
          // payload, which can carry challenge `session` tokens, MFA shared
          // secrets, etc. that the client legitimately round-trips.
          const okLog = redactToJson(responseBody ?? result);
          console.log('[rpc-ok]', `${apiNamespace}.${rpcMethod}`,
            okLog.length > 800 ? okLog.slice(0, 800) + '…' : okLog);
        }
        res.writeHead(responseStatus, headerObj);
        res.end(successPayload);
      } catch (error: any) {
        const errPayload = errorResponseFromCatch(error, rpcId);
        if (!process.env.BLOCKS_DEV_QUIET) {
          console.log('[rpc-err]', `${apiNamespace}.${rpcMethod}`, error?.name ?? 'Error', '-', error?.message);
          if (error?.stack) console.log(error.stack);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(errPayload);
      }
    });
    return;
  }

  // RawRoute dispatch
  const matched = matchRoute(method, url.pathname);
  if (matched) {
    let body = '';
    req.on('data', (chunk: string) => body += chunk);
    req.on('end', async () => {
      try {
        const headers = new Headers();
        Object.entries(req.headers).forEach(([k, v]) => {
          headers.set(k, Array.isArray(v) ? v[0] : v || '');
        });

        let responseStatus = 200;
        const responseHeaders = new Headers({ 'Content-Type': 'application/json' });
        let responseBody: any;

        const context = {
          request: {
            headers,
            body: toBodyStream(body),
            json: async () => JSON.parse(body),
            text: async () => body,
            url,
            params: matched.params,
          },
          response: {
            headers: responseHeaders,
            get status() { return responseStatus; },
            set status(code: number) { responseStatus = code; },
            send: (b: any) => { responseBody = b; },
          },
        };

        await matched.route.handler(context);

        const headerObj: Record<string, string | string[]> = {};
        for (const [key, value] of responseHeaders.entries()) {
          if (key === 'set-cookie') continue;
          headerObj[key] = value;
        }
        const setCookies = responseHeaders.getSetCookie?.() ?? [];
        if (setCookies.length > 0) headerObj['set-cookie'] = setCookies;

        res.writeHead(responseStatus, headerObj);
        res.end(responseBody !== undefined ? (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)) : '');
      } catch (error: any) {
        const status = error instanceof ApiError ? error.status : 500;
        const errBody: Record<string, any> = { error: error.message };
        if (error.name && error.name !== 'Error') errBody.name = error.name;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errBody));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
}
