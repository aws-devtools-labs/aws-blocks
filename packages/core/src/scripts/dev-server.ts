 // Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Agent, createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL, URL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { writeFileSync, mkdirSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import httpProxy from 'http-proxy';
import { writeClientCode } from './generate-client.js';
import { BLOCKS_RPC_PREFIX, BLOCKS_SANDBOX_PREFIX, CLIENT_USER_AGENT_HEADER, isRpcPath } from '../constants.js';
import { BLOCKS_SANDBOX_DIR } from '../common/constants.js';
import { matchRoute, lockRouteRegistry } from '../raw-route.js';
import { CORS_MAX_AGE } from '../cors.js';
import { registerBuiltinRoutes } from '../builtin-routes.js';
import { createDispatcher, rpcResponseHeaders, type Dispatcher } from '../dispatch.js';
import {
  clientGoneSignal,
  discardRemainingBody,
  readBody,
  toDispatchRequest,
  writeInternalServerError,
  writeResponse,
} from '../http-server.js';
import { MAX_RPC_BODY_BYTES, payloadTooLargeResponse } from '../rpc.js';
import { redactToJson } from '../redact.js';
import { isIpLiteral, isLoopbackHost, isWildcardHost } from '../common/loopback.js';
import { buildAndSendEvent } from '../telemetry/client.js';
import { applyDevMigrations } from './external-migrations-step.js';
import {
  claimDevPidfile,
  DEV_SESSION_ENV,
  type DevServerPidRecord,
  type FrontendListener,
  devPidfilePath,
  isPidAlive,
  isTsxWatcher,
  parsePidRecord,
  recordLiveness,
  pidCommand,
  reapDevPidfile,
  releaseDevPidfile,
  SANDBOX_SESSION_ENV,
} from './dev-pidfile.js';
export {
  type ClaimPidfileDeps,
  claimDevPidfile,
  type DevServerPidRecord,
  devPidfilePath,
  evaluateSingleton,
  isPidAlive,
  parsePidRecord,
  type PidfileClaim,
  type RecordLiveness,
  recordLiveness,
  type SingletonDecision,
} from './dev-pidfile.js';
import {
  descendsFrom,
  KILL_GRACE_MS,
  killFrontendTree,
  terminateProcessTree,
  findListenerPids,
  killListenerTree,
  waitForProcessGroupExit,
  type WindowsProcess,
  windowsProcesses,
  windowsProcessesAsync,
} from './process-tree.js';
import { ignoreClosedOutput, isCuratedLevel, log, resolveLogLevel } from './log.js';
import { installDevRejectionHandler, runDevRequest } from './dev-unhandled-rejection.js';

export const LOCALHOST_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Resolve the interface the dev server binds: an explicit `host` option, then
 * `BLOCKS_DEV_HOST`, else IPv4 loopback. Loopback by default — never every
 * interface — because the dev server exposes the full API with no auth.
 */
export function resolveDevHost(option: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const chosen = option?.trim() || env.BLOCKS_DEV_HOST?.trim();
  return chosen || '127.0.0.1';
}

/** Re-exported for callers/tests; the single definition lives in `common/loopback.ts`. */
export { isLoopbackHost } from '../common/loopback.js';

/** A `Host` header: a bracketed IPv6 literal or a name/IPv4, then an optional port (range-checked below). */
const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[^\s:/?#@[\]\\]+)(?::(\d{1,5}))?$/i;

/** Lowercase, and strip IPv6 brackets and a trailing root dot (`Mybox.` → `mybox`). */
function normalizeHostname(host: string): string {
  return host.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

/**
 * Whether the dev server should serve a request with this `Host` header. This is
 * the DNS-rebinding check: binding loopback keeps other machines out, but a page
 * on an attacker's origin can re-point its own DNS name at `127.0.0.1` and then
 * call the dev server as a same-origin page. The browser still sends the
 * attacker's name in `Host`, so only these are served:
 *
 * - a loopback host — `localhost`, `127.x.x.x`, `[::1]`, with or without a port
 *   (and in the FQDN form with a trailing root dot, `localhost.`);
 * - the concrete host the dev server was told to bind (`bindHost`, from
 *   `startDevServer({ host })` or `BLOCKS_DEV_HOST`), or the one in
 *   `BLOCKS_DEV_HOST` (`devHost`);
 * - with a wildcard bind (`0.0.0.0` / `::`), any IP address literal. A literal
 *   can't be re-pointed by DNS; a DNS name is refused, and opening the app by a
 *   name needs `BLOCKS_DEV_HOST` set to that name.
 *
 * A missing or malformed `Host`, or one with a port above 65535, is refused. Loopback, wildcard and IP
 * classification is the same one the realtime WebSocket's `Origin` check uses
 * (`common/loopback.ts`), so the two can't disagree.
 */
export function isAllowedDevRequestHost(
  hostHeader: string | undefined,
  bindHost: string,
  devHost: string | undefined = process.env.BLOCKS_DEV_HOST,
): boolean {
  const match = HOST_HEADER.exec(hostHeader?.trim() ?? '');
  if (!match) return false;
  if (match[2] !== undefined && Number(match[2]) > 65535) return false;
  const hostname = match[1];
  // `normalizeHostname` strips the FQDN root dot, so `localhost.` is loopback here
  // as it is for `BLOCKS_DEV_HOST=mybox` vs `Host: mybox.`.
  if (isLoopbackHost(normalizeHostname(hostname))) return true;
  for (const configured of [bindHost, devHost]) {
    const optIn = configured?.trim();
    if (!optIn) continue;
    if (isWildcardHost(optIn)) {
      if (isIpLiteral(hostname)) return true;
    } else if (normalizeHostname(optIn) === normalizeHostname(hostname)) {
      return true;
    }
  }
  return false;
}

/**
 * The host to put in the dev server's URLs for the interface it binds:
 * `localhost` for loopback and for all interfaces (`0.0.0.0`, `::`), else the
 * bound address or name itself, with brackets for an IPv6 address. A server
 * bound to `10.0.0.5` isn't reachable at `localhost`.
 */
export function devUrlHost(host: string): string {
  if (isLoopbackHost(host) || isWildcardHost(host)) return 'localhost';
  const bare = host.trim().replace(/^\[|\]$/g, '');
  return bare.includes(':') ? `[${bare}]` : bare;
}

/** The interface and port the dev server listens on, for {@link resolveDevCorsOrigin}. */
export interface DevServerAddress {
  host: string;
  port: number;
}

/**
 * Resolve the CORS origin for the dev server. Reflects back origins on
 * localhost/127.0.0.1, and — when the server binds one specific non-loopback
 * host — origins on that host (a page served from `http://10.0.0.5:5173` calling
 * the API on `10.0.0.5:3000`). It also reflects a same-origin request's Origin,
 * the one that equals `http://<requestHost>`: a page that a server bound to all
 * interfaces (`0.0.0.0`, `::`) served at one of the machine's addresses calls
 * the API at that address. A browser grants a same-origin page that access
 * whatever the header says, so reflecting it widens nothing. Otherwise returns
 * the server's own origin (`http://localhost:3000` when `bound` is not given).
 */
export function resolveDevCorsOrigin(origin: string, bound?: DevServerAddress, requestHost?: string): string {
  if (LOCALHOST_PATTERN.test(origin)) return origin;
  if (!bound) return 'http://localhost:3000';
  const urlHost = devUrlHost(bound.host);
  try {
    const url = new URL(origin);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin) {
      if (urlHost !== 'localhost' && url.hostname === urlHost.toLowerCase()) return origin;
      // The dev server speaks plain HTTP, so its own origin is http://<Host header>.
      if (requestHost && url.protocol === 'http:' && url.origin === new URL(`http://${requestHost}`).origin) return origin;
    }
  } catch {
    // Not a URL (`null`, empty), or a Host header that is none: fall back.
  }
  return `http://${urlHost}:${bound.port}`;
}

/**
 * Build the CORS response headers the dev server sets on every request.
 *
 * Mirrors the Lambda path's cache posture — same {@link CORS_MAX_AGE} and the
 * same `Vary: Origin` — so the reflected `Access-Control-Allow-Origin` can't be
 * served across origins by a shared cache, and so the two sites can't drift.
 */
export function buildDevCorsHeaders(
  requestOrigin: string,
  bound?: DevServerAddress,
  requestHost?: string,
): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': resolveDevCorsOrigin(requestOrigin, bound, requestHost),
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': `Content-Type, Authorization, ${CLIENT_USER_AGENT_HEADER}`,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': CORS_MAX_AGE,
  };
}

/** Shape of the client runtime config the browser fetches to discover the API URL. */
export interface BlocksRuntimeConfig {
  apiUrl: string;
  environment: 'local' | 'sandbox';
}

/**
 * Build the runtime config the browser fetches at `${BLOCKS_SANDBOX_PREFIX}/config.json`.
 * The browser targets the dev server's own front door on the host it binds
 * (see {@link devUrlHost}); in sandbox mode the dev server proxies
 * `/aws-blocks/api` to the deployed API, so the shape is the same in both
 * modes — only `environment` differs.
 */
export function buildBlocksConfig(port: number, isSandbox: boolean, host = '127.0.0.1'): BlocksRuntimeConfig {
  return {
    apiUrl: `http://${devUrlHost(host)}:${port}${BLOCKS_RPC_PREFIX}`,
    environment: isSandbox ? 'sandbox' : 'local',
  };
}

/**
 * The runtime config the dev server answers at `${BLOCKS_SANDBOX_PREFIX}/config.json`:
 * {@link buildBlocksConfig}, except that a server bound to all interfaces (`0.0.0.0`, `::`)
 * serves the same-origin `apiUrl` `/aws-blocks/api`. A browser can load the app at any of
 * the machine's addresses, and the absolute `http://localhost:<port>` would send it to
 * another origin, or to another machine. The `.blocks-sandbox/config.json` file keeps the
 * absolute URL: Node.js reads it, and a relative URL has no origin there.
 */
export function buildServedBlocksConfig(port: number, isSandbox: boolean, host = '127.0.0.1'): BlocksRuntimeConfig {
  const config = buildBlocksConfig(port, isSandbox, host);
  return isWildcardHost(host) ? { ...config, apiUrl: BLOCKS_RPC_PREFIX } : config;
}

/**
 * The environment the dev server runs its frontend command with: its own, with
 * `BLOCKS_API_URL` set to this server's front door. Server-side frontend code
 * (a Next.js Server Component, an SSR loader) resolves the API from
 * `BLOCKS_API_URL` first, so it calls this server, whatever a deploy recorded
 * meanwhile. In sandbox mode this replaces the deployed URL the sandbox gave
 * the dev server: the front door proxies to it, as it does for the browser.
 */
export function frontendEnv(env: NodeJS.ProcessEnv, config: BlocksRuntimeConfig): NodeJS.ProcessEnv {
  return { ...env, NODE_OPTIONS: '', BLOCKS_API_URL: config.apiUrl };
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
   * The proxy reuses HTTP connections to the frontend and releases its pool on shutdown.
   */
  frontendCommand?: string;
  /** Port the frontend dev server listens on. Default: 3100. */
  frontendPort?: number;
  /**
   * Interface the dev server binds. Default: `127.0.0.1` (loopback only). The dev
   * server proxies your whole Blocks API — with local mock auth, which
   * authenticates nothing — against the local mock datastore, so it must not be
   * reachable from other machines by default. Set a wider host (e.g. `0.0.0.0`)
   * only for container / remote-devbox setups where you control who can reach the
   * port. Overridable with the `BLOCKS_DEV_HOST` environment variable.
   */
  host?: string;
  /**
   * Watch `secret()` / `config()` calls and regenerate the type-safe key
   * augmentation (so `getSecret`/`getConfig` autocomplete and reject typos) as you
   * edit — all under this one `npm run dev`, no second command. Auto-detected: a
   * no-op unless the app actually declares a `secret()`/`config()`, and never fatal
   * (a failure only logs a warning). Set `false` to disable. Default: enabled.
   */
  typegen?: boolean;
  /**
   * Regenerate `aws-blocks/client.js` from the backend at startup (local mode
   * only; sandbox mode never does). Set `false` for an app that ships its own
   * client, such as the Amplify overlay, whose `client.js` reads
   * `amplify_outputs.json` and adds the Cognito token. When omitted, the dev
   * server reads `package.json#blocks.dev.generateClient` from the app root (the
   * working directory); default `true`. See {@link readDevGenerateClient}.
   */
  generateClient?: boolean;
}

/**
 * `package.json#blocks.dev.generateClient` in `root`: `false` keeps a
 * hand-written `aws-blocks/client.js`. `undefined` when the package.json, the
 * key or a boolean value is missing; a non-boolean value is warned about and
 * ignored, since it's an option the dev server can work without.
 */
export function readDevGenerateClient(root: string): boolean | undefined {
  let pkg: unknown;
  try {
    // A leading UTF-8 byte order mark is ignored, as npm ignores it.
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
  const blocks = pkg && typeof pkg === 'object' && 'blocks' in pkg ? pkg.blocks : undefined;
  const dev = blocks && typeof blocks === 'object' && 'dev' in blocks ? blocks.dev : undefined;
  const value = dev && typeof dev === 'object' && 'generateClient' in dev ? dev.generateClient : undefined;
  if (value === undefined || typeof value === 'boolean') return value;
  log.warn(`⚠️  Ignoring package.json "blocks.dev.generateClient": ${JSON.stringify(value)} is not true or false.`);
  return undefined;
}

/**
 * Bootstrap the type-safe `getSecret`/`getConfig` key generation for the dev
 * session. Auto-detected and non-fatal: scans the app for `secret()`/`config()`
 * calls and, only if it finds any, generates the augmentation `.d.ts` and starts a
 * watcher that regenerates on save — so a single `npm run dev` gives type-safe keys
 * with no second command. Returns a `stop()` (or `undefined` when the app declares
 * no secrets, typegen is unavailable, or it is disabled). The watcher is `unref`'d
 * so it can never block the dev server's shutdown.
 */
/**
 * Options for the dev session's typegen watcher. Regeneration notices are
 * `log.detail`: hidden once output is curated and routed by `BLOCKS_LOG_STREAM`;
 * unchanged (`console.log`) with neither variable set. Exported for tests.
 */
export function typegenWatchOptions(): { unref: true; log: (msg: string) => void } {
  return { unref: true, log: (msg) => log.detail(msg) };
}

async function startTypegenWatch(): Promise<(() => void) | undefined> {
  try {
    const { scanValueKeys, watchHostingValues } = await import('@aws-blocks/hosting/scripts');
    const scan = await scanValueKeys();
    if (scan.secretKeys.length === 0 && scan.configKeys.length === 0) {
      return undefined; // app doesn't use secret()/config() → nothing to type, skip silently
    }
    log.detail('🔑 Type-safe secret()/config() keys — watching for changes...');
    return await watchHostingValues(typegenWatchOptions());
  } catch (error) {
    // Never break the dev server over typegen (e.g. `typescript` not installed).
    log.warn(`⚠️  hosting-typegen skipped: ${error instanceof Error ? error.message : String(error)}`);
    log.debugError(error);
    return undefined;
  }
}

/**
 * Initialize all building blocks that have an initialize() method.
 * This is the "local deploy" phase - mirrors CDK deploy.
 */
async function deployLocal(backend: Record<string, any>): Promise<void> {
  const initPromises: Promise<void>[] = [];
  for (const [name, value] of Object.entries(backend)) {
    if (value && typeof value.initialize === 'function') {
      log.detail(`  Initializing ${name}...`);
      initPromises.push(value.initialize());
    }
  }
  await Promise.all(initPromises);
}

/**
 * Single-shot TCP probe: resolves `true` iff a connection to `port` succeeds
 * within `timeoutMs`, else `false` (connection error or timeout). Never rejects.
 *
 * When `host` is omitted the port is probed on BOTH loopback families —
 * `127.0.0.1` (IPv4) and `::1` (IPv6) — and reported open if EITHER answers.
 * This matters because an orphan dev server (or an older version of it, which
 * bound dual-stack on `::`) can hold the port on either loopback family. A single
 * `localhost` probe resolves to only one of `::1`/`127.0.0.1` on a given host, so
 * an orphan on the *other* family would be invisible — leaving the
 * startup/EADDRINUSE reclaim path blind to a port that is still contended. Probing both families keeps every "is the port bound" check in
 * agreement with what `listen` actually contends for. Pass an explicit `host`
 * to probe only that address.
 *
 * Shared by {@link waitForPort} (wait until open), {@link waitForPortFree} (wait
 * until closed) and the startup/EADDRINUSE reclaim path so all three agree on
 * exactly what "the port is bound" means.
 */
export async function isPortOpen(port: number, host?: string, timeoutMs = 200): Promise<boolean> {
  const probeOne = (h: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: h }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.setTimeout(timeoutMs, () => { socket.destroy(); resolve(false); });
    });
  if (host !== undefined) return probeOne(host);
  const [v4, v6] = await Promise.all([probeOne('127.0.0.1'), probeOne('::1')]);
  return v4 || v6;
}

/** Wait for a port to accept TCP connections. */
async function waitForPort(port: number, maxAttempts = 60): Promise<void> {
  const { setTimeout: sleep } = await import('node:timers/promises');
  for (let i = 0; i < maxAttempts; i++) {
    if (await isPortOpen(port, undefined, 300)) return;
    await sleep(500);
  }
  throw new Error(`Frontend server on port ${port} did not start within ${maxAttempts * 500}ms`);
}

/** Bounded auto-respawn policy for the frontend dev server. */
export interface FrontendRespawnPolicy {
  /** Max restarts allowed within `windowMs` before giving up (prevents hot loops). */
  maxRestarts: number;
  /** Sliding window (ms) over which restarts are counted. */
  windowMs: number;
  /** Base backoff (ms); doubles for each restart already in the window. */
  backoffMs: number;
  /** Upper bound (ms) on any single backoff delay. */
  maxBackoffMs: number;
}

/** Default frontend respawn budget: 5 restarts / 10s, 500ms→5s exponential backoff. */
export const DEFAULT_FRONTEND_RESPAWN_POLICY: FrontendRespawnPolicy = {
  maxRestarts: 5,
  windowMs: 10_000,
  backoffMs: 500,
  maxBackoffMs: 5_000,
};

/** Outcome of {@link evaluateFrontendRespawn}. */
export interface RespawnDecision {
  /** Whether the frontend should be respawned now. */
  restart: boolean;
  /** Delay (ms) to wait before respawning when `restart` is true. */
  delayMs: number;
  /**
   * Restart timestamps still inside the window — plus the new attempt when
   * restarting. The caller persists this for the next decision.
   */
  recent: number[];
}

/**
 * Decide whether to auto-respawn the frontend dev server after an unexpected
 * exit, given the timestamps of restarts not yet "forgiven".
 *
 * Semantics — the budget counts only *failing* restarts:
 * - Timestamps older than `windowMs` are dropped from the sliding window.
 * - If `maxRestarts` are still within the window, the budget is exhausted and
 *   the frontend is left down (no hot restart loop) — `restart: false`.
 * - Otherwise `restart: true` with an exponential backoff (`backoffMs` doubled
 *   per in-window restart, capped at `maxBackoffMs`) and the new attempt
 *   appended to `recent`.
 *
 * This function is pure; the *meaning* of the budget is enforced by the caller,
 * which **resets `recentRestarts` to `[]` once a respawn demonstrably succeeds**
 * (the frontend port becomes bound — see `announceFrontendReady`). As a result
 * only *consecutive failing* restarts accumulate toward `maxRestarts`: a
 * frontend that legitimately restarts many times in a burst (e.g.
 * editor-triggered Vite full reloads) refreshes its budget on each healthy bind
 * and is never permanently left down — only a genuine crash loop that never
 * rebinds the port trips the limit.
 */
export function evaluateFrontendRespawn(
  recentRestarts: number[],
  now: number,
  policy: FrontendRespawnPolicy = DEFAULT_FRONTEND_RESPAWN_POLICY,
): RespawnDecision {
  const recent = recentRestarts.filter((t) => now - t < policy.windowMs);
  if (recent.length >= policy.maxRestarts) {
    return { restart: false, delayMs: 0, recent };
  }
  const delayMs = Math.min(policy.backoffMs * 2 ** recent.length, policy.maxBackoffMs);
  return { restart: true, delayMs, recent: [...recent, now] };
}

/**
 * Wait (bounded) for a TCP port to STOP accepting connections, i.e. for the
 * listener to actually release the socket. Used after killing the frontend so a
 * `tsx watch` relaunch can rebind `:3100` cleanly instead of racing the kernel's
 * socket teardown and hitting `--strictPort` `EADDRINUSE`. Resolves as soon as
 * the port is free, or once `timeoutMs` elapses (never rejects).
 */
export async function waitForPortFree(port: number, timeoutMs = 2000): Promise<void> {
  const { setTimeout: sleep } = await import('node:timers/promises');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port, undefined, 200))) return;
    await sleep(100);
  }
}

/**
 * Decide whether a "frontend is listening" probe should be *credited* as a
 * successful (re)spawn — and thus reset the restart budget.
 *
 * `waitForPort` only proves *something* is listening on `:3100`; it cannot tell
 * our Vite apart from a foreign listener (a leftover Vite, or a second dev
 * server). Crediting any listener would let a foreign process on `:3100` make
 * every `--strictPort`-failing respawn look successful, neutralizing the
 * `maxRestarts` cap and hot-looping forever. So we credit the probe only when
 * **our** spawned child is still the live frontend process — same identity and
 * not yet exited. A child that already exited (e.g. it lost the `--strictPort`
 * bind race to the foreign listener) is no longer `current`, so it is not
 * credited and its failed attempt still counts toward the budget.
 */
export function shouldCreditFrontendReady(
  child: { exitCode: number | null; signalCode: NodeJS.Signals | null } | null,
  current: unknown,
): boolean {
  return (
    !!child &&
    child === current &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

// ── Startup / EADDRINUSE port reclaim ──────────────────────────────────────

/** A process holding a port that the dev server can't prove it started. */
export interface PortHolder {
  pid: number;
  /** Its command line; '' when it can't be read. */
  command: string;
}

/** Outcome of {@link reclaimPort}. */
export interface ReclaimResult {
  /** Whether the port was bound when reclaim started. */
  wasOpen: boolean;
  /** Whether the port is free once reclaim finishes (true when it was never open). */
  reclaimed: boolean;
  /** Listener PIDs signalled. Empty when the port was free, or nothing on it was ours. */
  pids: number[];
  /** Listeners left alone because they aren't this app's (see {@link ReclaimPortDeps.owned}). */
  foreign: PortHolder[];
}

/** Injectable seams for {@link reclaimPort} (real implementations by default). */
export interface ReclaimPortDeps {
  /** True iff the port is currently bound. */
  probe: (port: number) => Promise<boolean>;
  /** PIDs of the listener(s) holding the port. */
  listPids: (port: number) => number[];
  /**
   * True iff a listener is provably this app's leftover — in practice a process
   * in the frontend process group the app's previous dev server recorded.
   * Default: nothing is, so nothing is ever signalled.
   */
  owned: (pid: number) => boolean;
  /** A listener's command line, to name a foreign holder. */
  commandOf: (pid: number) => string;
  /** Terminate a listener PID's tree (POSIX group kill / Windows taskkill). */
  killTree: (pid: number, signal: NodeJS.Signals) => void;
  /** Wait (bounded) for the port to be released. */
  waitFree: (port: number, timeoutMs?: number) => Promise<void>;
}

/**
 * Free a port left bound by this app's crashed / SIGKILL'd previous dev server
 * (typically its detached Vite group on `:3100`), so a fresh start can bind the
 * front door or spawn its `--strictPort` frontend instead of colliding.
 *
 * Only listeners that {@link ReclaimPortDeps.owned} proves are ours are ever
 * signalled. If anything else holds the port — an unrelated process, another
 * app's dev server or frontend — nothing is signalled and the holders come
 * back in `foreign`, for the caller to report. A port held by a listener whose
 * pid can't be found is left alone too.
 *
 * Owned listeners get a SIGTERM ({@link killListenerTree}, the frontend
 * process-group kill), a bounded wait for release ({@link waitForPortFree}),
 * then a SIGKILL for whichever owned listeners still hold it. Dependencies are
 * injected for tests. Best-effort: never throws.
 *
 * Probe contract: the default `probe` is {@link isPortOpen} with no host, which
 * checks BOTH `127.0.0.1` and `::1`, so a listener on either loopback family is
 * detected — a single-family `localhost` probe could miss it.
 */
export async function reclaimPort(port: number, deps: Partial<ReclaimPortDeps> = {}): Promise<ReclaimResult> {
  const probe = deps.probe ?? ((p) => isPortOpen(p));
  const listPids = deps.listPids ?? ((p) => findListenerPids(p));
  const owned = deps.owned ?? (() => false);
  const commandOf = deps.commandOf ?? ((pid) => pidCommand(pid));
  const killTree = deps.killTree ?? ((pid, sig) => killListenerTree(pid, sig));
  const waitFree = deps.waitFree ?? ((p, t) => waitForPortFree(p, t));

  if (!(await probe(port))) return { wasOpen: false, reclaimed: true, pids: [], foreign: [] };

  const foreignOf = (pids: number[]): PortHolder[] =>
    pids.filter((pid) => !owned(pid)).map((pid) => ({ pid, command: commandOf(pid) }));
  const pids = listPids(port);
  const foreign = foreignOf(pids);
  if (pids.length === 0 || foreign.length > 0) return { wasOpen: true, reclaimed: false, pids: [], foreign };

  for (const pid of pids) killTree(pid, 'SIGTERM');
  await waitFree(port, 2000);

  if (await probe(port)) {
    // Still held after a graceful SIGTERM — escalate to SIGKILL. ALWAYS re-list
    // first: the original process may have exited and a NEW one grabbed the
    // port, which must be judged afresh, not killed on the old verdict.
    const holders = listPids(port);
    const now = foreignOf(holders);
    if (now.length > 0) return { wasOpen: true, reclaimed: false, pids, foreign: now };
    for (const pid of holders) killTree(pid, 'SIGKILL');
    await waitFree(port, 2000);
  }

  return { wasOpen: true, reclaimed: !(await probe(port)), pids, foreign: [] };
}

/** `pid 4242 (python3 -m http.server 3100), pid 4243` */
function formatHolders(holders: readonly PortHolder[]): string {
  return holders.map(({ pid, command }) => `pid ${pid}${command ? ` (${command})` : ''}`).join(', ');
}

/**
 * Describe who holds a port that {@link reclaimPort} could not free, for an
 * error: `port 3100 is in use by pid 4242 (python3 -m http.server 3100)`. Pure.
 */
export function describePortHolders(port: number, result: ReclaimResult): string {
  if (result.foreign.length > 0) return `port ${port} is in use by ${formatHolders(result.foreign)}`;
  if (result.pids.length > 0) return `port ${port} is still held by pid(s) ${result.pids.join(', ')} after SIGKILL`;
  return `port ${port} is in use (its owner could not be found)`;
}

/**
 * What to run next when `result`'s port stays taken, `option` being the flag
 * that picks another one (`--port` or `--frontend-port`): an exact command,
 * since an agent told only to "stop that process" reaches for `pkill`. Pure.
 */
export function portInUseHint(port: number, result: Pick<ReclaimResult, 'foreign' | 'pids'>, option: string): string {
  const pids = result.foreign.length > 0 ? result.foreign.map((h) => h.pid) : result.pids;
  const again = 'then run `npx --no -- blocks dev` again';
  if (pids.length > 0) return `Stop it with \`kill ${pids.join(' ')}\`, ${again}, or choose another port with ${option}.`;
  return `Find the process that holds it with \`lsof -i :${port}\` and stop it, ${again}, or choose another port with ${option}.`;
}

/**
 * The console line for a reclaim of a port that was in use: `♻️` when it was
 * freed, else a `⚠️` with {@link describePortHolders}. `subject` names what was
 * reclaimed (e.g. "this app's previous dev server"). Pure.
 */
export function reclaimMessage(port: number, result: ReclaimResult, subject: string): string {
  if (result.reclaimed) {
    return `♻️  Reclaimed port ${port} from ${subject} before startup.`;
  }
  return `⚠️  ${describePortHolders(port, result)}; not stopping it.`;
}

/** Bounded retry policy for binding the `:3000` front door under EADDRINUSE. */
export interface PortBindRetryPolicy {
  /** Total bind attempts tolerated before giving up (exit non-zero). */
  maxAttempts: number;
  /** Base backoff (ms); scaled by the attempt number between retries. */
  backoffMs: number;
}

/** Default front-door bind retry budget: 3 attempts, 250ms→750ms linear backoff. */
export const DEFAULT_PORT_BIND_RETRY_POLICY: PortBindRetryPolicy = {
  maxAttempts: 3,
  backoffMs: 250,
};

/**
 * Decide whether an EADDRINUSE on the `:3000` front door should trigger another
 * reclaim-and-rebind attempt. `attempt` is the number of failures so far
 * (1-based). Returns `retry: false` once the budget is exhausted so the caller
 * exits non-zero with a clear message rather than looping forever. Pure.
 */
export function evaluatePortBindRetry(
  attempt: number,
  policy: PortBindRetryPolicy = DEFAULT_PORT_BIND_RETRY_POLICY,
): { retry: boolean; delayMs: number } {
  if (attempt >= policy.maxAttempts) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs: policy.backoffMs * attempt };
}

/** Injectable seams for {@link createBindRetryController} (real implementations wired at the call site). */
export interface BindRetryDeps {
  /** Reclaim the contended port; its result drives the operator message. */
  reclaim: (port: number) => Promise<ReclaimResult>;
  /** Re-attempt the bind (`server.listen(port, host, onListening)` in prod). */
  relisten: () => void;
  /** Schedule the next attempt after a backoff (`setTimeout` in prod). */
  scheduleRetry: (fn: () => void, delayMs: number) => void;
  /** Called once the attempt budget is exhausted (`process.exit(1)` in prod). */
  onExhausted: () => void;
  /** Warning/error sink (`console.error` in prod). */
  warn: (msg: string) => void;
}

/** Schedule a front-door rebind retry; keep it refed so the retry deterministically fires. */
export function scheduleBindRetry(
  fn: () => void,
  delayMs: number,
  setTimer: (fn: () => void, delayMs: number) => NodeJS.Timeout = setTimeout,
): NodeJS.Timeout {
  return setTimer(fn, delayMs);
}

/**
 * Build the `:3000` front-door EADDRINUSE bind-retry handler. Extracted from the
 * `server.on('error')` closure so the retry *wiring* — the 1-based attempt
 * counter, the bounded {@link evaluatePortBindRetry} decision, reclaim-result
 * routing, and retry scheduling — is unit-testable without a real socket.
 *
 * Returns a function to invoke on each EADDRINUSE. Per invocation it:
 *  - increments the attempt counter and consults {@link evaluatePortBindRetry};
 *  - on exhaustion: warns with an actionable message and calls `onExhausted`
 *    (no further retry is scheduled);
 *  - otherwise: warns it is retrying, then (async) reclaims the port and — when
 *    reclaim did NOT free it — surfaces the {@link reclaimMessage} naming the
 *    holding pid(s) so the operator isn't left with only the generic banner,
 *    then schedules the next `relisten` after the decided backoff.
 * Never throws.
 */
export function createBindRetryController(
  port: number,
  deps: BindRetryDeps,
  policy: PortBindRetryPolicy = DEFAULT_PORT_BIND_RETRY_POLICY,
): () => void {
  let attempts = 0;
  return () => {
    attempts += 1;
    const decision = evaluatePortBindRetry(attempts, policy);
    if (!decision.retry) {
      deps.warn(`⚠️  Port ${port} is still in use after ${policy.maxAttempts} attempts to bind it.`);
      deps.onExhausted();
      return;
    }
    deps.warn(
      `⚠️  Port ${port} already in use (EADDRINUSE) — reclaiming the stale owner and retrying ` +
      `(attempt ${attempts}/${policy.maxAttempts})…`,
    );
    void (async () => {
      const result = await deps.reclaim(port);
      if (!result.reclaimed) deps.warn(reclaimMessage(port, result, 'a stale/orphaned listener'));
      deps.scheduleRetry(deps.relisten, decision.delayMs);
    })();
  };
}

// ── Singleton guard (pidfile) ──────────────────────────────────────────────

/** `pid`'s process group (`ps -o pgid=`), or undefined when it can't be read (or on Windows). */
function processGroupOf(pid: number): number | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const { stdout } = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf-8', timeout: 3000 });
    const pgid = Number((stdout ?? '').trim());
    return Number.isInteger(pgid) && pgid > 1 ? pgid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `pid` is a process of the frontend that a previous dev server of this
 * app recorded (see {@link DevServerPidRecord.frontend}): on POSIX a member of
 * its process group; on Windows one of its listeners, still with the creation
 * time it had, so a pid that Windows handed out again is not. Nothing is, with
 * no recorded frontend.
 */
export function ownsLeftoverFrontend(
  frontend: DevServerPidRecord['frontend'],
  groupOf: (pid: number) => number | undefined,
  processes: (pids: readonly number[]) => ReadonlyMap<number, WindowsProcess>,
): (pid: number) => boolean {
  return (pid) => {
    if (frontend?.pgid !== undefined) return groupOf(pid) === frontend.pgid;
    const listener = frontend?.listeners?.find((l) => l.pid === pid);
    return listener !== undefined && processes([pid]).get(pid)?.created === listener.created;
  };
}

/**
 * The script {@link watchPidfileHandoff} runs (`node --input-type=module -e`):
 * every 100 ms, while the pidfile still holds the exited dev server's record,
 * check its `tsx watch`; once that has exited too, the session is over, so reap
 * that record (see reapDevPidfile: a start that claimed the pidfile in between
 * keeps its record). It ends as soon as the pidfile holds another record (the
 * successor took over) or is gone, and after ten minutes at most.
 */
const PIDFILE_HANDOFF_WATCH = `
import { readFileSync } from 'node:fs';
const [file, watcher, url] = process.argv.slice(1);
const { reapDevPidfile } = await import(url);
const raw = () => { try { return readFileSync(file, 'utf-8'); } catch { return null; } };
const alive = (p) => { try { process.kill(Number(p), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const inspected = raw();
const deadline = Date.now() + 600000;
const timer = setInterval(() => {
  if (inspected === null || raw() !== inspected || Date.now() > deadline) return clearInterval(timer);
  if (alive(watcher)) return;
  clearInterval(timer);
  reapDevPidfile(file, inspected);
}, 100);
`;

/**
 * Leave the pidfile at `pidfilePath` to this dev server's `tsx watch`
 * successor, but remove it if there is none: a detached watcher
 * ({@link PIDFILE_HANDOFF_WATCH}) removes it once the `tsx watch` parent
 * exits while the pidfile still names this process. A reload keeps the
 * pidfile (the successor takes it over); a stop of the session does not.
 */
function watchPidfileHandoff(pidfilePath: string): void {
  try {
    const pidfileModule = new URL('./dev-pidfile.js', import.meta.url).href;
    const args = ['--input-type=module', '-e', PIDFILE_HANDOFF_WATCH, resolve(pidfilePath), String(process.ppid), pidfileModule];
    spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: '' },
    }).unref();
  } catch { /* best effort: a later start or `dev stop` still treats a dead owner as gone */ }
}

/**
 * The environment variable naming a file the dev server writes a one-line
 * reason to when it can't start (another dev server owns the port, the port is
 * taken, the bind fails). `blocks dev` sets it, so it can tell this failure
 * apart from a requested stop: both end its `tsx watch` with a signal.
 */
export const DEV_FAILURE_FILE_ENV = 'BLOCKS_DEV_FAILURE_FILE';

/** `npx --no -- blocks dev stop`, with `--port` when the port isn't the default: a command an app's shell runs as is. */
export function devStopCommand(port: number): string {
  return port === 3000 ? 'npx --no -- blocks dev stop' : `npx --no -- blocks dev stop --port ${port}`;
}

/** The `Symbol.for` key of the local data engines' pending closers (see `closeOnProcessExit` in `@aws-blocks/data-common`). */
const LOCAL_ENGINE_CLOSERS = Symbol.for('aws-blocks.local-engine-closers');

/** How long {@link closeLocalEngines} waits for the engines: within `tsx watch`'s 5 s, with the frontend's teardown. */
const ENGINE_CLOSE_TIMEOUT_MS = 3000;

/**
 * Close every local data engine of this process (PGlite for `bb-data` and the
 * DSQL mock), as their `beforeExit` hook would: the dev server ends with
 * `process.exit()`, which skips that hook. A closed engine shuts PostgreSQL
 * down and removes its `postmaster.pid`. Waits at most `timeoutMs`; never throws.
 */
export async function closeLocalEngines(timeoutMs = ENGINE_CLOSE_TIMEOUT_MS): Promise<void> {
  const closers = (globalThis as Record<symbol, unknown>)[LOCAL_ENGINE_CLOSERS];
  if (!(closers instanceof Set) || closers.size === 0) return;
  const pending = [...closers] as Array<() => Promise<void>>;
  closers.clear();
  const timeout = new AbortController();
  await Promise.race([
    // async: a close that throws synchronously rejects, so the rest still run.
    Promise.allSettled(pending.map(async (close) => close())),
    sleep(timeoutMs, undefined, { signal: timeout.signal }).catch(() => {}),
  ]);
  timeout.abort();
}

/** How long {@link failDevStartup} waits for `tsx watch` to relay its SIGTERM back before exiting anyway. */
const FAIL_RELAY_GRACE_MS = 2000;

/**
 * End the dev session on a startup failure that editing the backend can't fix.
 * Prints `reason`, records it in {@link DEV_FAILURE_FILE_ENV}'s file, and exits 1.
 *
 * A `tsx watch` parent would otherwise wait for a file change forever after we
 * exit, with nothing left running that `dev stop` could find, so it is stopped
 * too: it gets a SIGTERM, relays it back to us, and we exit 1 then — not
 * before — so that tsx exits with our code instead of reporting a stop.
 * Returns at once; the process ends shortly after.
 */
function failDevStartup(reason: string, hint?: string): void {
  console.error(`\n❌ ${reason}.${hint ? `\n   ${hint}` : ''}\n`);
  const file = process.env[DEV_FAILURE_FILE_ENV];
  if (file) {
    try { writeFileSync(file, `${reason}${hint ? `; ${hint}` : ''}`); } catch { /* best effort */ }
  }
  const exit = (): never => process.exit(1);
  const parent = process.ppid;
  if (!(parent > 1 && isTsxWatcher(pidCommand(parent)))) exit();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.removeAllListeners(signal); // no cleanup: nothing was started
    process.once(signal, exit);
  }
  setTimeout(exit, FAIL_RELAY_GRACE_MS);
  try { process.kill(parent, 'SIGTERM'); } catch { exit(); }
}

export async function startDevServer(options: DevServerOptions) {
  // A closed output pipe (`blocks dev | head`, a background job whose reader
  // went away) must not kill the server on its next log line (see ignoreClosedOutput).
  ignoreClosedOutput();
  // Bind loopback unless the developer explicitly opts into a wider interface.
  const host = resolveDevHost(options.host);
  if (!isLoopbackHost(host)) {
    console.warn(
      `\n⚠️  AWS Blocks dev server is binding ${host}, not loopback. Anyone who can reach this ` +
        'machine on that interface can call every API method against your local mock data ' +
        '(local auth authenticates nothing). Use this only in a container or devbox whose ' +
        'port you control.' +
        (isWildcardHost(host)
          ? ' Browsers must reach it by IP address for the realtime WebSocket to accept their Origin; ' +
            'to use a hostname instead, set BLOCKS_DEV_HOST to that hostname.\n'
          : '\n'),
    );
  }
  const {
    port = 3000,
    backendPath,
    frontendCommand,
    frontendPort = 3100,
  } = options;
  const devStartTime = Date.now();
  // A request's unhandled rejection (e.g. a guard called without `await`) is
  // logged with its method instead of ending the process (dev server only).
  installDevRejectionHandler();

  // ── Singleton guard ─────────────────────────────────────────────────────
  // One dev server per front-door port: a second `blocks dev` must not start a
  // supervisor that fights the first over :3000/:3100. The per-port pidfile is
  // created exclusively (see {@link claimDevPidfile}), so this holds even for
  // two starts at the same moment. The recorded `ppid` (the stable `tsx watch`
  // watcher) tells a hot-reload relaunch of OUR OWN script from a second
  // invocation, and the recorded command lines tell a live owner from a reused
  // pid. A stale pidfile (dead owner) never blocks startup. Under `blocks dev`,
  // the CLI claimed the session before it started us (see claimDevSession), and
  // we take its record over.
  const pidfilePath = devPidfilePath(port);
  // Never unlinks a record that a tsx-watch successor wrote in between (see releaseDevPidfile).
  const removeOwnPidfile = (): void => releaseDevPidfile(pidfilePath, process.pid);
  const selfRecord: DevServerPidRecord = {
    pid: process.pid,
    ppid: process.ppid,
    port,
    command: pidCommand(process.pid),
    parentCommand: pidCommand(process.ppid),
    token: randomUUID(),
  };
  const sandboxSession = Number(process.env[SANDBOX_SESSION_ENV]);
  delete process.env[SANDBOX_SESSION_ENV]; // not the frontend's to inherit
  if (Number.isInteger(sandboxSession) && sandboxSession > 1) selfRecord.sandbox = { pid: sandboxSession };
  const session = Number(process.env[DEV_SESSION_ENV]);
  delete process.env[DEV_SESSION_ENV]; // not the frontend's to inherit
  const sessionPid = Number.isInteger(session) && session > 1 ? session : undefined;
  // The top of the session, which `dev stop` ends on Windows (see DevServerPidRecord.session).
  if (sessionPid !== undefined) selfRecord.session = { pid: sessionPid };
  mkdirSync(BLOCKS_SANDBOX_DIR, { recursive: true });
  const claim = claimDevPidfile(pidfilePath, selfRecord, {}, sessionPid);
  if (!claim.acquired) {
    // One dev server per app, whatever its port: the claim names the port of the one that runs.
    failDevStartup(claim.reason, `Not starting a second one. Stop it with \`${devStopCommand(claim.port)}\`.`);
    return;
  }
  // `tsx watch` restarts us on a file change with a SIGTERM (and relays a
  // SIGTERM stop the same way). The session goes on across a restart, so the
  // pidfile stays: a `dev stop` run before the successor has booted must still
  // find it. The successor takes it over (see evaluateSingleton), and `dev stop`
  // removes it once the port is free. Every other signal ends the session.
  // A SIGTERM that was a stop looks the same to us (the `blocks` CLI SIGTERMs
  // this process, then its `tsx watch`), so a handoff watch removes the kept
  // pidfile once `tsx watch` exits without a successor (see watchPidfileHandoff).
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const underTsxWatch = isTsxWatcher(pidCommand(process.ppid));
  // Until the cleanup below is installed, once the server listens, a stop
  // still ends the session cleanly: it releases the record we now hold (or
  // hands it to a reload's successor), and closes any database the backend
  // opened. Without this, a group SIGTERM while the backend loaded killed us
  // by the default disposition and left a stale pidfile (JA-6).
  let stoppingAtStartup = false;
  const startupStop = (signal: NodeJS.Signals): void => {
    if (stoppingAtStartup) return;
    stoppingAtStartup = true;
    if (signal === 'SIGTERM' && underTsxWatch) watchPidfileHandoff(pidfilePath);
    else removeOwnPidfile();
    void closeLocalEngines().finally(() => process.exit(0));
  };
  for (const sig of signals) process.on(sig, startupStop);
  // The only processes this start may stop to free a port: those of the
  // frontend that the record it took over (a crashed predecessor, or its
  // own `tsx watch` predecessor) wrote down.
  const leftoverFrontend = claim.previous?.frontend;
  const ownedLeftover = ownsLeftoverFrontend(leftoverFrontend, processGroupOf, windowsProcesses);
  /** Rewrite our pidfile with the frontend we now run, while the pidfile is still ours. */
  const recordFrontend = (frontend: { pgid?: number; listeners?: FrontendListener[] }): void => {
    try {
      if (parsePidRecord(readFileSync(pidfilePath, 'utf-8'))?.pid !== process.pid) return;
      const tmp = `${pidfilePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...selfRecord, frontend: { ...frontend, port: frontendPort } }));
      renameSync(tmp, pidfilePath);
    } catch { /* best effort: only a later reclaim of this frontend's port depends on it */ }
  };

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
  const blocksConfig = buildBlocksConfig(port, isSandbox, host);
  const servedBlocksConfig = buildServedBlocksConfig(port, isSandbox, host);
  /** The front door's URL on the interface it binds (see {@link devUrlHost}). */
  const frontDoor = `http://${devUrlHost(host)}:${port}`;
  mkdirSync(BLOCKS_SANDBOX_DIR, { recursive: true });
  writeFileSync(join(BLOCKS_SANDBOX_DIR, 'config.json'), JSON.stringify(blocksConfig, null, 2));

  // 1. Set up global collectors for plugin discovery
  (globalThis as any).__BLOCKS_CLIENT_MIDDLEWARE__ = [];
  (globalThis as any).__BLOCKS_DEV_ATTACHMENTS__ = [];

  // 2. Import backend (sync construction phase — BBs register plugins via globals)
  log.detail('Loading backend...');
  const backend = await import(backendUrl);

  // 3. Read collected dev attachments and clean up
  const devAttachments: string[] = (globalThis as any).__BLOCKS_DEV_ATTACHMENTS__;
  delete (globalThis as any).__BLOCKS_DEV_ATTACHMENTS__;

  // 4. Deploy local (async initialization phase) — skip in sandbox mode
  if (!isSandbox) {
    log.detail('Deploying local resources...');
    await deployLocal(backend);
  }

  // 5. Create the request dispatcher. It resolves APIs with the same rule as the
  // Lambda handler: no Building Block instances or `_`-private exports.
  const bound: DevServerAddress = { host, port };
  const dispatch = createDevDispatcher(backend, bound);

  registerBuiltinRoutes({ localDev: true });
  lockRouteRegistry();

  // ── Frontend proxy ─────────────────────────────────────────────────────
  let frontendProcess: ChildProcess | null = null;
  // Reuse frontend sockets so repeated page loads do not exhaust ephemeral ports.
  const frontendAgent = frontendCommand ? new Agent({ keepAlive: true }) : undefined;
  const frontendProxy = frontendCommand
    ? httpProxy.createProxyServer({ target: `http://localhost:${frontendPort}`, ws: true, agent: frontendAgent })
    : null;

  frontendProxy?.on('error', (_err, _req, res) => {
    if (!res || typeof (res as any).writeHead !== 'function') return;
    if ((res as ServerResponse).headersSent) return;
    (res as ServerResponse).writeHead(502);
    (res as ServerResponse).end('Frontend server unavailable');
  });

  // ── Frontend supervisor ─────────────────────────────────────────────────
  // The frontend runs under `shell: true`, so the real dev server (Vite) is a
  // grandchild of this process. We spawn it `detached` (its own process group)
  // on POSIX so cleanup/restart can signal the *whole* tree and free the port;
  // otherwise the orphaned grandchild keeps `:3100` and every `/` request 502s
  // forever (the proxy target is hardcoded to `frontendPort`). We also bound-
  // respawn it on unexpected death and suppress all of this during shutdown.
  //
  // ── POST-EXIT GROUP-KILL POLICY ─────────────────────────────────────────
  // The exact bug this supervisor fixes is the shell *exiting* while the
  // detached grandchild survives, orphaned, still holding `:3100`. Reaping that
  // orphan REQUIRES a group kill (`process.kill(-pid, …)`) issued *after* the
  // shell has already exited — so all three post-exit kill sites below agree:
  // the respawn path, `terminateFrontend`, and the `process.on('exit')` net all
  // group-kill rather than skip when the shell is already gone.
  //
  // Why this is safe against the classic `-pid` PID-reuse hazard:
  //   1. A surviving grandchild keeps the process group non-empty, so POSIX
  //      keeps `pid` reserved as the group id — it cannot be recycled as a new
  //      process id while it is still a live group's id. Hence `-pid` is
  //      guaranteed to target *our* group precisely when it matters (an orphan
  //      is still alive in it).
  //   2. We only ever issue the kill synchronously, the instant we observe the
  //      shell's exit — there is no intervening `await` that could let the group
  //      drain and the pid be recycled — so the residual window is minimal.
  // Residual accepted risk: if the ENTIRE group is already gone *and* `pid` has
  // since been recycled into a brand-new group leader, `-pid` could signal an
  // unrelated group. This is an accepted best-effort trade-off — there is then
  // nothing of ours left to reap, whereas skipping the kill would otherwise
  // leave `:3100` wedged, which is the failure this PR exists to prevent.
  //
  // Where each post-exit kill site lands on this trade-off: the two sites *in
  // this file* — the respawn reap (in the child's `exit` handler) and the
  // `process.on('exit')` net — fire synchronously the instant we observe the
  // exit, so they lean on point (2) above and stay unconditional. The third
  // path, `terminateFrontend` → `terminateProcessTree` (process-tree.ts), can
  // run outside that minimal synchronous window, so it additionally PROBES group
  // liveness (POSIX signal 0) and skips the reap once the group has fully
  // drained — see its "POST-EXIT GROUP-KILL (scoped)" comment.
  const usePosixProcessGroups = process.platform !== 'win32';
  let isShuttingDown = false;
  let frontendRestarts: number[] = [];
  let respawnTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Windows has no process groups, and a frontend that a shell started outlives
   * a dev server that `tsx watch` restarted or that was killed: once `child`
   * listens, record the processes of its tree that hold the port, for a later
   * start's reclaim and `dev stop` (see {@link ownsLeftoverFrontend}).
   */
  const recordWindowsFrontend = async (child: ChildProcess): Promise<void> => {
    const root = child.pid;
    const listening = findListenerPids(frontendPort);
    if (root === undefined || listening.length === 0) return;
    const processes = await windowsProcessesAsync();
    const listeners = listening
      .filter((pid) => descendsFrom(processes, pid, root))
      .map((pid) => ({ pid, created: processes.get(pid)!.created }));
    if (listeners.length > 0 && child === frontendProcess && !isShuttingDown) recordFrontend({ listeners });
  };

  const announceFrontendReady = async (child: ChildProcess | null, suffix = ''): Promise<void> => {
    try {
      await waitForPort(frontendPort);
      // Reset the restart budget only when OUR child is the one now bound to
      // `:3100`. `waitForPort` is a liveness-only probe — it cannot tell our
      // Vite from a foreign listener (a leftover Vite or a second dev server),
      // and crediting a foreign listener would make every `--strictPort`-failing
      // respawn look successful, neutralizing the `maxRestarts` cap and
      // hot-looping forever (see {@link shouldCreditFrontendReady}). Only
      // *consecutive failing* restarts should count toward the give-up
      // threshold, so a frontend that legitimately restarts many times (e.g.
      // editor-triggered Vite full reloads) still never gets left down.
      if (shouldCreditFrontendReady(child, frontendProcess)) {
        frontendRestarts = [];
        if (!usePosixProcessGroups && child) void recordWindowsFrontend(child);
      }
      console.log(`\n  ➜  ${frontDoor}/${suffix}\n`);
    } catch (e) {
      console.error(`⚠️  Frontend did not start: ${(e as Error).message}`);
      console.log(`\n  ➜  ${frontDoor}/  (API only — frontend unavailable)\n`);
    }
  };

  const spawnFrontend = (command: string): ChildProcess => {
    const child = spawn(command, {
      shell: true,
      // Own process group on POSIX so we can reap the Vite grandchild too.
      detached: usePosixProcessGroups,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: frontendEnv(process.env, blocksConfig),
    });
    frontendProcess = child;
    // Detached on POSIX, so its pid is its group id: what a later start of this app may reclaim the port from.
    if (usePosixProcessGroups && child.pid) recordFrontend({ pgid: child.pid });

    // Suppress frontend output — only show errors.
    child.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString();
      if (!msg.includes('DeprecationWarning')) process.stderr.write(msg);
    });

    child.on('exit', (code, signal) => {
      // Ignore exits from a process we've already replaced or torn down.
      if (child !== frontendProcess) return;
      frontendProcess = null;
      if (isShuttingDown) return;
      // Reap any orphaned grandchild left in this child's group so `:3100` is
      // free before we respawn — otherwise `--strictPort` makes the new Vite
      // exit on bind and we'd spin until the restart budget is gone. The shell
      // has already exited here (we are inside its `exit` handler), so this is a
      // post-exit group kill; it is issued synchronously in this handler and is
      // safe against PID reuse — see POST-EXIT GROUP-KILL POLICY above.
      killFrontendTree(child, 'SIGKILL');

      const decision = evaluateFrontendRespawn(frontendRestarts, Date.now());
      frontendRestarts = decision.recent;
      const why = `code=${code ?? 'null'}, signal=${signal ?? 'null'}`;
      if (!decision.restart) {
        console.error(
          `⚠️  Frontend dev server exited (${why}) and exceeded ` +
          `${DEFAULT_FRONTEND_RESPAWN_POLICY.maxRestarts} restarts within ` +
          `${DEFAULT_FRONTEND_RESPAWN_POLICY.windowMs / 1000}s — leaving it down. ` +
          `Fix the error above, then restart \`npm run dev\`.`,
        );
        return;
      }
      console.error(`⚠️  Frontend dev server exited (${why}); restarting in ${decision.delayMs}ms…`);
      respawnTimer = setTimeout(() => {
        respawnTimer = null;
        if (isShuttingDown) return;
        // Before relaunching, wait (bounded) for `:3100` to actually free —
        // mirroring the graceful `terminateFrontend` path. The synchronous
        // post-exit SIGKILL above only *initiates* teardown of the orphaned
        // group; the kernel can still hold the listening socket for a beat, and a
        // relaunched `--strictPort` Vite would then hit `EADDRINUSE` and burn a
        // restart-budget slot on a race that isn't a real crash. The budget was
        // already debited above, so this never double-counts a restart; re-check
        // `isShuttingDown` after the await, since a shutdown signal can land while
        // we wait (`waitForPortFree` is bounded, so it can't deadlock shutdown).
        void (async () => {
          await waitForPortFree(frontendPort);
          if (isShuttingDown) return;
          const next = spawnFrontend(command);
          await announceFrontendReady(next, '  (frontend restarted)');
        })();
      }, decision.delayMs);
      // INTENTIONAL unref: the listening HTTP `server` (created below) owns this
      // process's lifetime — the backoff timer must NOT, by itself, keep the
      // event loop alive. Without unref a pending respawn timer would hold the
      // process up during shutdown (or after the server has closed), delaying or
      // blocking a clean exit. This never drops a legitimately-needed respawn:
      // `cleanup` explicitly clears this timer, and both the timer body and the
      // awaited relaunch re-check `isShuttingDown`. Do NOT remove the unref to
      // "fix" a perceived missed restart — it would reintroduce that shutdown hang.
      respawnTimer.unref?.();
    });

    return child;
  };

  /**
   * Gracefully terminate the frontend tree and wait (bounded) for the port to
   * actually free before this process exits, so a `tsx watch` relaunch can
   * rebind `:3100` cleanly. SIGTERM the group, escalate to SIGKILL if it lingers
   * (via the shared {@link terminateProcessTree}), wait for the rest of the
   * group, then poll until `:3100` is released. tsx-watch gives us ~5s before it
   * force-kills us, so this budget is safe. Crucially the port-free wait runs on
   * *both* paths — including when the shell has already exited — so the
   * post-exit branch no longer drops the "wait for the port to free" guarantee.
   */
  const terminateFrontend = async (child: ChildProcess | null): Promise<void> => {
    if (!child) return;
    const graceMs = 1500;
    const deadline = Date.now() + graceMs;
    // SIGTERM→SIGKILL the whole tree, reaping the detached Vite grandchild even
    // when the shell has already exited (post-exit group kill — see policy).
    await terminateProcessTree(child, graceMs);
    // The shell, or `npx`, exits before the dev server under it, which closes its
    // port first and can go on writing (Next's `.next`): stop only once the whole
    // group has exited, within the same grace, then SIGKILL what is left of it.
    // The group is alive when the wait gives up, so `-pid` is still ours.
    if (child.pid && !(await waitForProcessGroupExit(child.pid, Math.max(0, deadline - Date.now())))) {
      killFrontendTree(child, 'SIGKILL');
      await waitForProcessGroupExit(child.pid, KILL_GRACE_MS);
    }
    // Then wait (bounded) for `:3100` to be released. The old post-exit branch
    // returned right after SIGKILL with no port poll, so a relaunch could race
    // the kernel's socket teardown and hit `--strictPort` `EADDRINUSE`.
    await waitForPortFree(frontendPort);
  };

  // ── API Gateway proxy (sandbox mode) ───────────────────────────────────
  // `changeOrigin: true` rewrites the outgoing `Host` to the execute-api target
  // (required for API Gateway's TLS SNI / host-based routing). That would make
  // the backend compute absolute URLs (OIDC redirect_uri, stub issuer URLs)
  // against the execute-api host instead of this localhost front door, breaking
  // redirect-based auth in sandbox. We forward the real front-door host via
  // `X-Forwarded-Host`; the Lambda honors it only because it is loopback (see
  // `isLoopbackForwardedHost` in request-context.ts).
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
    if (isRpcPath(pathname)) return true;
    if (matchRoute(method, pathname)) return true;
    return false;
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // DNS-rebinding guard: refuse a Host that isn't loopback or the configured
    // dev host before anything is dispatched, proxied or given CORS headers
    // (see isAllowedDevRequestHost).
    if (!isAllowedDevRequestHost(req.headers.host, host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Connection': 'close' });
      res.end(
        'Forbidden: the AWS Blocks dev server only answers requests addressed to localhost, 127.0.0.1, [::1] ' +
          'or the host set in BLOCKS_DEV_HOST.\n',
      );
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const method = req.method || 'GET';

    // CORS headers
    const requestOrigin = req.headers.origin || '';
    for (const [name, value] of Object.entries(buildDevCorsHeaders(requestOrigin, { host, port }, req.headers.host))) {
      res.setHeader(name, value);
    }

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
      res.end(JSON.stringify(servedBlocksConfig));
      return;
    }

    // ── API/RawRoute requests ──────────────────────────────────────────
    if (isApiRequest(method, url.pathname)) {
      if (isSandbox && apiProxy) {
        apiProxy.web(req, res);
        return;
      }
      handleApiRequest(req, res, url, method, dispatch, bound);
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
    // A stale client can reset the connection mid-upgrade (ECONNRESET). The raw
    // socket has no 'error' listener at this point, so Node's default handler
    // would kill the dev server. Attach one before any parsing/routing.
    socket.on('error', () => socket.destroy());
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
    log.detail(`  🔌 Attaching dev server (from ${specifier})`);
    const mod = await import(specifier);
    if (typeof mod.attach !== 'function') {
      throw new Error(`Dev attachment '${specifier}' does not export an attach() function`);
    }
    await mod.attach(server);
  }

  (globalThis as any).__BLOCKS_REALTIME_WS_URL__ = `ws://${devUrlHost(host)}:${port}/realtime`;
  (globalThis as any).__BLOCKS_DEV_SERVER_PORT__ = port;

  // Config already written during startup (local mode overwrites, sandbox mode preserves).

  // Generate client code — skip in sandbox mode because sandbox.ts already
  // generated it with --conditions=aws-runtime (correct aws-middleware).
  // Re-generating here without that condition would overwrite with mock-middleware.
  // An app that ships its own client (the Amplify overlay) opts out.
  if (!isSandbox) {
    const clientPath = join(dirname(resolvedPath), 'client.js');
    if ((options.generateClient ?? readDevGenerateClient(process.cwd())) === false) {
      log.detail('📝 Keeping aws-blocks/client.js (generateClient is false).');
    } else {
      log.progress('📝 Generating client code...');
      await writeClientCode(resolvedPath, clientPath);
    }
  }

  // Type-safe getSecret/getConfig: generate + watch the key augmentation so the
  // getters autocomplete and reject typos, regenerating on save — all under this
  // one `npm run dev`. Auto-detected (no-op unless the app uses secret()/config())
  // and non-fatal.
  const stopTypegen = options.typegen === false ? undefined : await startTypegenWatch();

  // ── Startup reclaim ──────────────────────────────────────────────────────
  // Free a port left bound by this app's crashed / SIGKILL'd predecessor before
  // we bind the front door or spawn the `--strictPort` frontend: tsx watch gives
  // the previous process ~5s to run cleanup(), and if it was SIGKILL'd its
  // detached Vite group can still hold :3100. Only that recorded group is ever
  // stopped. Any other holder — an unrelated process, another app's dev server
  // or frontend on the same port — ends the start with its pid and command
  // (see {@link reclaimPort}).
  const reclaimDeps = {
    owned: ownedLeftover,
    // POSIX: the recorded group. Windows: the recorded listener's tree (taskkill /T).
    killTree: (pid: number, signal: NodeJS.Signals) => killListenerTree(leftoverFrontend?.pgid ?? pid, signal),
  };
  const ports: Array<[number, string]> = [[port, '--port']];
  if (frontendCommand) ports.push([frontendPort, '--frontend-port']);
  for (const [p, option] of ports) {
    const result = await reclaimPort(p, reclaimDeps);
    if (!result.wasOpen) continue;
    if (result.reclaimed) {
      log.progress(reclaimMessage(p, result, "this app's previous dev server"));
      continue;
    }
    removeOwnPidfile();
    failDevStartup(describePortHolders(p, result), portInUseHint(p, result, option));
    return;
  }

  // ── Start listening ────────────────────────────────────────────────────
  const onListening = async (): Promise<void> => {
    // Record again now that we hold the port. Two concurrent starts (`npm run dev`
    // and an e2e run that starts its own) can both pass the singleton guard before
    // either binds; the one that binds second does so only after the other exited
    // and removed its record, and would otherwise serve with no pidfile, so
    // `dev:stop` would report nothing to stop.
    try {
      writeFileSync(pidfilePath, JSON.stringify({ pid: process.pid, ppid: process.ppid, port }));
    } catch { /* best-effort, as at startup */ }
    console.log(`AWS Blocks local server running on ${frontDoor}`);
    buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: Date.now() - devStartTime });

    // Spawn frontend dev server after Blocks server is ready
    if (frontendCommand) {
      const child = spawnFrontend(frontendCommand);
      await announceFrontendReady(child);
    } else {
      console.log(`\n  ➜  ${frontDoor}/\n`);
    }
  };

  // Front-door EADDRINUSE robustness — mirror the treatment :3100 already gets:
  // emit a REAL console error (not just telemetry), reclaim the stale owner and
  // retry the bind (bounded), and on unrecoverable failure exit non-zero with a
  // clear message so a contended :3000 never silently fails to serve. Startup
  // reclaim above makes this a rare race (someone grabbed :3000 between reclaim
  // and listen); the retry closes that window. The retry wiring lives in the
  // testable {@link createBindRetryController}; telemetry stays here.
  const onEaddrinuse = createBindRetryController(port, {
    reclaim: (p) => reclaimPort(p, reclaimDeps),
    relisten: () => server.listen(port, host, onListening),
    scheduleRetry: (fn, delayMs) => { scheduleBindRetry(fn, delayMs); },
    onExhausted: () =>
      failDevStartup(`port ${port} is still in use`, portInUseHint(port, { foreign: [], pids: findListenerPids(port) }, '--port')),
    warn: (msg) => console.error(msg),
  });
  // Malformed/aborted requests must not become unhandled socket errors.
  server.on('clientError', (_err: Error, socket: Duplex) => {
    if ((socket as Socket).writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Keep the telemetry signal (unchanged) …
      buildAndSendEvent({
        command: 'dev',
        state: 'FAIL',
        duration: Date.now() - devStartTime,
        error: { code: 'PORT_IN_USE', phase: 'startup' },
      });
      onEaddrinuse();
      return;
    }
    // Non-EADDRINUSE startup error: telemetry + a real error, then exit non-zero.
    buildAndSendEvent({
      command: 'dev',
      state: 'FAIL',
      duration: Date.now() - devStartTime,
      error: { code: 'UNKNOWN', phase: 'startup' },
    });
    failDevStartup(`the dev server could not listen on ${host}:${port}: ${err.message}`);
  });

  server.listen(port, host, onListening);

  // ── Cleanup ────────────────────────────────────────────────────────────
  // (See `signals` and `underTsxWatch` above for what a SIGTERM keeps.)
  let keepPidfile = false;
  let cleaningUp = false;
  const cleanup = async (signal: NodeJS.Signals) => {
    if (cleaningUp) return; // idempotent — a second signal must not re-enter
    cleaningUp = true;
    keepPidfile = signal === 'SIGTERM' && underTsxWatch;
    isShuttingDown = true; // stop the supervisor from respawning the frontend
    log.progress('\nShutting down...');

    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
    stopTypegen?.(); // tear down the typegen watcher (unref'd, but close it cleanly)
    // Keep the listeners until we exit. A Ctrl-C or a group SIGTERM reaches us
    // directly and again as `tsx watch` relays it; tsx's preflight exits the
    // process on a signal that has no other listener, which would cut this
    // cleanup short and leave the frontend running.

    // Kill the frontend process *group* and wait for the port to free before
    // we exit, so a tsx-watch restart can rebind `:3100` cleanly. Meanwhile,
    // close the local data engines: `process.exit()` below skips the
    // `beforeExit` hook that would, so PGlite would leave its `postmaster.pid`
    // behind on every stop, and a leftover one would not mean a crash.
    const child = frontendProcess;
    frontendProcess = null;
    await Promise.all([terminateFrontend(child), closeLocalEngines()]);

    if (typeof backend.__cleanup === 'function') {
      try { await backend.__cleanup(); } catch {}
    }
    if (keepPidfile) watchPidfileHandoff(pidfilePath);
    else removeOwnPidfile();
    frontendProxy?.close();
    frontendAgent?.destroy();
    apiProxy?.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };

  for (const sig of signals) {
    process.off(sig, startupStop);
    process.on(sig, cleanup);
  }

  // Last-resort safety net for paths that bypass `cleanup` (e.g. an uncaught
  // exception terminating the process): synchronously reap the frontend tree so
  // a `detached` Vite is never left orphaned on `:3100`. Reuses
  // `killFrontendTree`, so unlike the old hand-rolled `process.kill(-pid)` it
  // also reaps on Windows (via `taskkill`) instead of early-returning and
  // leaking the Vite tree, and stays in lockstep with the other kill sites. Both
  // the POSIX group kill and the Windows `taskkill` are synchronous, so this is
  // legal in an `exit` handler; it reaps even when the shell has already exited
  // (a surviving grandchild keeps the group alive) — see POST-EXIT GROUP-KILL
  // POLICY above.
  process.once('exit', () => {
    frontendAgent?.destroy();
    // Release our singleton pidfile on any exit path (crash, uncaught exception)
    // that bypassed cleanup(), so it never lingers and blocks the next start.
    if (!keepPidfile) removeOwnPidfile();
    const child = frontendProcess;
    if (!child) return;
    killFrontendTree(child, 'SIGKILL');
  });
}

// ── Stop / status (`npm run dev:stop`) ──────────────────────────────────────
// A sanctioned way to stop a dev server started with `npm run dev` — so an
// operator (or an agent) never reaches for `pkill -f tsx`/`killall node`, which
// matches by process NAME and also kills the caller's own shell/agent process.
//
// Ownership is proven, never guessed. We act ONLY on the supervisor identity the
// dev server itself recorded in its per-port pidfile ({pid, ppid, port}) — we
// never scan a port and signal whatever happens to be listening, so a stale
// pidfile or a same-port process from an unrelated project is never touched. The
// `ppid` is the stable `tsx watch` watcher; SIGTERM-ing it is what actually stops
// `npm run dev` (tsx relays the signal to its child, whose own `cleanup()` drains
// the frontend and removes the pidfile). Killing only the listener child would
// leave the watcher alive to relaunch on the next file edit — so the watcher is
// the primary target, and the recorded child's listener tree is only a fallback
// when the watcher is already gone.

/** Outcome of {@link stopDevServer}. */
export interface StopResult {
  /** The front-door port acted on. */
  port: number;
  /** True when a recorded supervisor was found and signalled. */
  stopped: boolean;
  /** True when no pidfile / no live recorded supervisor was found (idempotent no-op). */
  alreadyStopped: boolean;
  /** Supervisor identity read from the pidfile, when one was present. */
  record: DevServerPidRecord | null;
  /**
   * How the server was stopped:
   *  - `watcher`  — SIGTERM to the recorded `tsx watch` ppid (the clean path);
   *                 on Windows, the end of its whole tree.
   *  - `listener` — fallback: killed the recorded child pid's listener tree
   *                 (watcher was already gone / not a tsx watcher).
   *  - `cli`      — SIGTERM to the `blocks dev` CLI whose dev server was still
   *                 starting (a {@link DevServerPidRecord.starting} record); on
   *                 Windows, also the end of the tree of the CLI that runs it.
   *  - `frontend` — the recorded dev server was gone (a SIGKILL of its group),
   *                 and its detached frontend group still held the frontend port:
   *                 stopped that group, which the next start would otherwise
   *                 refuse to start next to.
   *  - `none`     — nothing live was recorded.
   */
  via: 'watcher' | 'listener' | 'cli' | 'frontend' | 'none';
  /** PIDs signalled. */
  pids: number[];
  /** True when, after signalling, the front-door port is confirmed free (and, for `frontend`, the frontend port). */
  portFree: boolean;
  /**
   * When nothing of this app was stopped but the port is bound: the processes
   * holding it, which `dev stop` never signals. Empty otherwise.
   */
  holders: PortHolder[];
  /** The recorded frontend and its port that were stopped: for `frontend`, and for `watcher` when the runner was already dead. */
  frontend?: NonNullable<DevServerPidRecord['frontend']>;
  /**
   * For `via: 'watcher'`: the `tsx watch` did not exit on its SIGTERM with its
   * runner dead (a runner killed by a signal leaves tsx waiting forever), so it
   * was SIGKILLed.
   */
  killed?: true;
  /**
   * The `blocks sandbox` session whose dev server this was (see
   * {@link DevServerPidRecord.sandbox}): it ends with its dev server, stopping
   * its `cdk watch`, and the stop waited for it.
   */
  sandbox?: { pid: number };
}

/** Injectable seams for {@link stopDevServer} (real implementations by default). */
export interface StopDevServerDeps {
  /** Read a pidfile body, or null when absent/unreadable. */
  readPidfile: (path: string) => string | null;
  /** Remove the record `inspected` from the pidfile: never any other record (see reapDevPidfile). */
  removePidfile: (path: string, inspected: string) => void;
  /** True iff a signal can be delivered to `pid` (it exists). */
  isAlive: (pid: number) => boolean;
  /** The command line of `pid`, for confirming a ppid is really a `tsx` watcher. */
  commandOf: (pid: number) => string;
  /** Send a signal to a single pid (the watcher path). */
  signal: (pid: number, sig: NodeJS.Signals) => void;
  /** True iff the front-door port is currently bound. */
  probe: (port: number) => Promise<boolean>;
  /** PIDs of the listener(s) holding a port (fallback path only). */
  listPids: (port: number) => number[];
  /** Terminate a listener PID's tree, or with a recorded frontend's pgid, that whole group (POSIX group kill). */
  killTree: (pid: number, sig: NodeJS.Signals) => void;
  /** `pid`'s process group, or undefined when it can't be read: a frontend group is recorded by its pgid. */
  groupOf: (pid: number) => number | undefined;
  /** Windows: the running processes of `pids`, from one CIM query; a frontend's listeners are recorded by their creation time. */
  processes: (pids: readonly number[]) => ReadonlyMap<number, WindowsProcess>;
  /** Wait (bounded) for a port to be released. */
  waitFree: (port: number, timeoutMs?: number) => Promise<void>;
  /** Wait (bounded) for `pid` to exit; true once it has. */
  waitExit: (pid: number, timeoutMs: number) => Promise<boolean>;
  /** The platform: on Windows the session is ended from its top (see {@link windowsSessionRoot}). */
  platform: NodeJS.Platform;
}

function defaultStopDeps(): StopDevServerDeps {
  return {
    readPidfile: (p) => {
      try {
        return readFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    },
    removePidfile: (p, inspected) => reapDevPidfile(p, inspected),
    isAlive: (pid) => isPidAlive(pid),
    commandOf: (pid) => pidCommand(pid),
    signal: (pid, sig) => process.kill(pid, sig),
    probe: (p) => isPortOpen(p),
    listPids: (p) => findListenerPids(p),
    killTree: (pid, sig) => killListenerTree(pid, sig),
    groupOf: (pid) => processGroupOf(pid),
    processes: (pids) => windowsProcesses(pids),
    waitFree: (p, t) => waitForPortFree(p, t),
    waitExit: async (pid, timeoutMs) => {
      for (const deadline = Date.now() + timeoutMs; isPidAlive(pid); await sleep(50)) {
        if (Date.now() >= deadline) return false;
      }
      return true;
    },
    platform: process.platform,
  };
}

/**
 * How long {@link stopDevServer} waits for a starting `blocks dev` CLI to exit
 * after its SIGTERM: the CLI waits up to 10 s for its dev server's cleanup.
 */
const CLI_STOP_TIMEOUT_MS = 12_000;

/**
 * How long {@link stopDevServer} waits for a `tsx watch` whose runner is alive
 * to exit after its SIGTERM: tsx gives the runner 5 s, and the runner's own
 * cleanup stops the frontend within that.
 */
const WATCHER_EXIT_TIMEOUT_MS = 8000;

/**
 * How long {@link stopDevServer} waits for a `blocks sandbox` session to exit
 * once its dev server has: it stops its `cdk watch` (2 s) and its dev server
 * tree (6 s) at the same time, then exits.
 */
const SANDBOX_STOP_TIMEOUT_MS = 10_000;

/**
 * How long {@link stopDevServer} gives a `tsx watch` whose runner is already
 * dead before it SIGKILLs it: tsx waits for an exit that already happened, so
 * it would never exit on its own.
 */
const NO_RUNNER_WATCHER_GRACE_MS = 2000;

/** How long {@link stopDevServer} waits on Windows for the top of a session to exit after `taskkill /T /F`. */
const WINDOWS_TREE_EXIT_MS = 5000;

/**
 * The process at the top of the dev session `record` names, on Windows, which
 * `dev stop` ends with its whole tree: the `blocks dev` CLI that started the
 * session ({@link DevServerPidRecord.session}), while the recorded `tsx watch`
 * still descends from it; else that `tsx watch`, while the recorded runner
 * still descends from it. Undefined unless the recorded `ppid` is a `tsx watch`
 * that `processes` (CIM) proves: a pid that Windows has handed out again, or a
 * plain `node` start under the caller's shell, is never ended this way. Pure.
 */
export function windowsSessionRoot(
  record: DevServerPidRecord,
  processes: ReadonlyMap<number, WindowsProcess>,
): number | undefined {
  const watcher = processes.get(record.ppid);
  if (watcher === undefined || !isTsxWatcher(watcher.command)) return undefined;
  if (record.session && descendsFrom(processes, record.ppid, record.session.pid)) return record.session.pid;
  return descendsFrom(processes, record.pid, record.ppid) ? record.ppid : undefined;
}

/**
 * Stop the dev server recorded for `port` by SIGTERM-ing its `tsx watch`
 * supervisor — the only thing that actually ends `npm run dev` (killing just the
 * listener child leaves the watcher to relaunch on the next edit).
 *
 * Ownership is PROVEN, not guessed: this acts only on the pids the dev server
 * wrote to its own pidfile ({pid, ppid, port}). It never scans the port and
 * signals an arbitrary listener, so a stale pidfile or an unrelated same-port
 * process is never killed — the exact failure a `pkill -f`/port-scan stop has.
 *
 *  1. No pidfile, or neither recorded pid alive → nothing of ours is running
 *     (`alreadyStopped`, idempotent).
 *  2. Recorded `ppid` is alive AND its command is a `tsx watch` → SIGTERM it.
 *     tsx relays the signal to its child, whose own `cleanup()` drains the
 *     frontend and removes the pidfile. (A bare `node server.ts` start has the
 *     caller's SHELL as ppid, which is NOT a tsx watcher, so we never signal it —
 *     that would be the self-kill this command exists to prevent.)
 *  3. Watcher gone / not a tsx watcher but the recorded child `pid` still holds
 *     the port → fall back to SIGTERM→SIGKILL of that child's listener tree.
 *  4. A {@link DevServerPidRecord.starting} record: the `blocks dev` CLI whose
 *     dev server is still starting → SIGTERM the CLI, which stops what it
 *     started, and wait for it to exit.
 *  5. On Windows, a signal is `TerminateProcess`: a SIGTERM to `tsx watch` runs
 *     no cleanup, and what a shell started (the frontend) outlives its parent.
 *     So the session ends from its top ({@link windowsSessionRoot}: the
 *     `blocks dev` CLI, else `tsx watch`) with its whole tree (`taskkill /T /F`):
 *     the CLI does not start the dev server again on the next save. Then the
 *     stop waits for the ports to be free, and removes the record.
 *
 * The pidfile is removed only once the port is confirmed free (or no owner is
 * left alive), so a server that survived the signal keeps its singleton guard.
 * Dependencies are injected for tests; defaults wire the real seams. Never throws.
 */
export async function stopDevServer(
  port = 3000,
  deps: Partial<StopDevServerDeps> = {},
): Promise<StopResult> {
  const d = { ...defaultStopDeps(), ...deps };
  const pidfilePath = devPidfilePath(port);

  const body = d.readPidfile(pidfilePath);
  const record = body != null ? parsePidRecord(body) : null;

  const result = (via: StopResult['via'], pids: number[], portFree: boolean): StopResult => ({
    port,
    stopped: via !== 'none',
    alreadyStopped: via === 'none',
    record,
    via,
    pids,
    portFree,
    holders: [],
  });
  const nothingToStop = async (): Promise<StopResult> => {
    const portFree = !(await d.probe(port));
    const holders = portFree ? [] : d.listPids(port).map((pid) => ({ pid, command: d.commandOf(pid) }));
    return { ...result('none', [], portFree), holders };
  };

  /** Remove the record `raw` from the pidfile once nothing it names is alive: never a live record, nor another one. */
  const reapIfEnded = (raw: string): void => {
    const rec = parsePidRecord(raw);
    const live = rec && recordLiveness(rec, d.isAlive, d.commandOf);
    if (!(live && (live.pidAlive || live.watcherAlive))) d.removePidfile(pidfilePath, raw);
  };

  if (!record || body == null) {
    // An unreadable pidfile can't name anything to stop, and would keep `--all` listing this port.
    if (body != null) d.removePidfile(pidfilePath, body);
    return nothingToStop();
  }

  const watcherAlive = record.ppid > 1 && d.isAlive(record.ppid);
  // A recorded child whose pid now runs another command is gone (the pid was reused).
  const runnerAlive = (): boolean =>
    d.isAlive(record.pid) && (record.command === undefined || d.commandOf(record.pid) === record.command);
  const childAlive = runnerAlive();

  // A `blocks dev` CLI whose dev server has not taken the session over yet: it
  // stops what it started on a SIGTERM, and exits once all of it has.
  if (record.starting) {
    if (!childAlive) {
      reapIfEnded(body);
      return nothingToStop();
    }
    try {
      d.signal(record.pid, 'SIGTERM');
    } catch {
      /* raced away */
    }
    await d.waitExit(record.pid, CLI_STOP_TIMEOUT_MS);
    await d.waitFree(port, 3000);
    const portFree = !(await d.probe(port));
    // The dev server may have taken the record over, and ended before it could remove it.
    const left = d.readPidfile(pidfilePath);
    if (portFree && left != null) reapIfEnded(left);
    return result('cli', [record.pid], portFree);
  }

  /**
   * Stop the recorded frontend, once the dev server that ran it is gone, if it
   * still holds the frontend port: with the same ownership test as a start's
   * reclaim (see {@link ownsLeftoverFrontend}), so nothing but that group (POSIX),
   * or the trees of those listeners (Windows), is signalled. Null when the
   * record has none, or nothing of it holds the port.
   */
  const stopLeftFrontend = async (): Promise<{ frontend: NonNullable<DevServerPidRecord['frontend']>; reclaim: ReclaimResult } | null> => {
    const frontend = record.frontend;
    if (!frontend) return null;
    const reclaim = await reclaimPort(frontend.port, {
      probe: d.probe,
      listPids: d.listPids,
      owned: ownsLeftoverFrontend(frontend, d.groupOf, d.processes),
      commandOf: d.commandOf,
      killTree: (pid, sig) => d.killTree(frontend.pgid ?? pid, sig),
      waitFree: d.waitFree,
    });
    return reclaim.wasOpen && reclaim.pids.length > 0 ? { frontend, reclaim } : null;
  };

  // Nothing we recorded is alive — stale pidfile. A dev server that was
  // SIGKILLed can still leave its detached frontend group holding the frontend
  // port; that group is recorded, so stop it (and only it, as a start's reclaim
  // would), then clear the record. Otherwise report a no-op.
  if (!watcherAlive && !childAlive) {
    const left = await stopLeftFrontend();
    if (left) {
      if (left.reclaim.reclaimed) reapIfEnded(body);
      const portFree = !(await d.probe(port));
      return { ...result('frontend', left.reclaim.pids, portFree && left.reclaim.reclaimed), frontend: left.frontend };
    }
    reapIfEnded(body);
    return nothingToStop();
  }

  // Windows: end the session from its top, with its whole tree (see 5. above).
  if (d.platform === 'win32') {
    const top = windowsSessionRoot(
      record,
      d.processes([record.pid, record.ppid, ...(record.session ? [record.session.pid] : [])]),
    );
    if (top !== undefined) {
      d.killTree(top, 'SIGKILL');
      const exited = await d.waitExit(top, WINDOWS_TREE_EXIT_MS);
      await d.waitFree(port, 3000);
      if (record.frontend) await d.waitFree(record.frontend.port, 3000);
      // A frontend that a reload orphaned is not in the tree: stop it as a start's reclaim would.
      const left = await stopLeftFrontend();
      const sandbox = record.sandbox;
      const sandboxEnded = !sandbox || !d.isAlive(sandbox.pid) || (await d.waitExit(sandbox.pid, SANDBOX_STOP_TIMEOUT_MS));
      const portFree = !(await d.probe(port)) && (left === null || left.reclaim.reclaimed);
      if (portFree && exited) {
        reapIfEnded(body);
        // The dev server may have rewritten its record (its frontend) since it was read.
        const now = d.readPidfile(pidfilePath);
        if (now != null && now !== body) reapIfEnded(now);
      }
      return {
        ...result(
          top === record.session?.pid ? 'cli' : 'watcher',
          [top, ...(left?.reclaim.pids ?? [])],
          portFree && exited && sandboxEnded,
        ),
        ...(left ? { frontend: left.frontend } : {}),
        ...(sandbox ? { sandbox } : {}),
      };
    }
  }

  // Primary path: SIGTERM the recorded tsx watch supervisor, and wait for it to
  // exit: the port being free does not mean the session ended. `tsx watch`
  // relays the SIGTERM and gives its runner 5 s; a runner that a signal killed
  // (the OOM killer, a `kill -9`) never reports an exit tsx waits for, so tsx
  // then runs forever, out of reach of Ctrl-C. A watcher that is still there
  // with no runner is SIGKILLed, and so is one that outlives its runner.
  if (watcherAlive && isTsxWatcher(d.commandOf(record.ppid))) {
    try {
      d.signal(record.ppid, 'SIGTERM');
    } catch {
      /* raced away */
    }
    let exited = await d.waitExit(record.ppid, childAlive ? WATCHER_EXIT_TIMEOUT_MS : NO_RUNNER_WATCHER_GRACE_MS);
    let killed = false;
    if (!exited && !runnerAlive()) {
      try {
        d.signal(record.ppid, 'SIGKILL');
        killed = true;
      } catch {
        /* raced away */
      }
      exited = await d.waitExit(record.ppid, KILL_GRACE_MS);
    }
    // A runner that died by a signal ran no cleanup: its frontend is still up.
    const left = childAlive ? null : await stopLeftFrontend();
    await d.waitFree(port, 3000);
    // A `blocks sandbox` session ends with its dev server: it stops its `cdk watch` and exits. Wait for that.
    const sandbox = record.sandbox;
    const sandboxEnded = !sandbox || !d.isAlive(sandbox.pid) || (await d.waitExit(sandbox.pid, SANDBOX_STOP_TIMEOUT_MS));
    const portFree = !(await d.probe(port)) && (left === null || left.reclaim.reclaimed);
    if (portFree && exited) reapIfEnded(body);
    return {
      ...result('watcher', [record.ppid, ...(left?.reclaim.pids ?? [])], portFree && exited && sandboxEnded),
      ...(killed ? { killed: true } : {}),
      ...(left ? { frontend: left.frontend } : {}),
      ...(sandbox ? { sandbox } : {}),
    };
  }

  // Fallback: the watcher is gone (or ppid is not a tsx watcher), but the
  // recorded child still holds the port. Reap exactly that child's listener
  // tree — still ownership-scoped to the recorded pid, never an arbitrary scan.
  if (childAlive && (await d.probe(port)) && d.listPids(port).includes(record.pid)) {
    d.killTree(record.pid, 'SIGTERM');
    await d.waitFree(port, 2000);
    if (await d.probe(port)) {
      d.killTree(record.pid, 'SIGKILL');
      await d.waitFree(port, 2000);
    }
    const portFree = !(await d.probe(port));
    if (portFree) reapIfEnded(body);
    return result('listener', [record.pid], portFree);
  }

  // The recorded owner is alive but no longer holds the port (e.g. already
  // shutting down). Its record goes once it has ended.
  const none = await nothingToStop();
  if (none.portFree) reapIfEnded(body);
  return none;
}

/** True when {@link stopMessage} reports a problem (a warning, for stderr) rather than an outcome. */
export function isStopWarning(result: StopResult): boolean {
  return !result.alreadyStopped && !result.portFree;
}

/** Human-readable one-liner describing a {@link StopResult}, for the CLI. */
export function stopMessage(result: StopResult): string {
  if (result.alreadyStopped) {
    if (result.holders.length > 0) {
      return (
        `No dev server of this app is running on :${result.port}. The port is held by another process, ` +
        `which was not stopped: ${formatHolders(result.holders)}.`
      );
    }
    if (!result.portFree) {
      return `No dev server of this app is running on :${result.port}. The port is held by another process, which was not stopped.`;
    }
    return `No dev server was running on :${result.port} (nothing to stop).`;
  }
  const who = result.pids.length ? ` (pid${result.pids.length > 1 ? 's' : ''} ${result.pids.join(', ')})` : '';
  if (result.via === 'frontend' && result.frontend) {
    const left = `the frontend that this app's dev server left running on :${result.frontend.port}${who}`;
    return result.portFree
      ? `🛑 The dev server on :${result.port} had already stopped; stopped ${left}.`
      : `⚠️  Signalled ${left}, but a port of this app is still bound — it may still be shutting down.`;
  }
  if (result.portFree) {
    const how = result.killed ? '; its tsx watch had lost its runner and ignored SIGTERM, so it was killed' : '';
    if (result.sandbox) {
      return (
        `🛑 Stopped the blocks sandbox session on :${result.port}${who}: its dev server and its cdk watch${how}. ` +
        'Its AWS resources are still deployed; `npx --no -- blocks sandbox destroy` deletes them.'
      );
    }
    return `🛑 Stopped the dev server on :${result.port}${who}${how}.`;
  }
  if (result.sandbox) {
    return (
      `⚠️  Signalled the blocks sandbox session on :${result.port}${who}, but it has not ended yet: ` +
      'its dev server or its cdk watch may still be shutting down.'
    );
  }
  return (
    `⚠️  Signalled the dev server on :${result.port}${who}, but the port is still ` +
    `bound — it may still be shutting down, or another process now holds it.`
  );
}

/**
 * CLI entry for the `dev:stop` template script. Stops the dev server on the
 * front-door port (`--port N`, default 3000), prints one {@link stopMessage}
 * (a warning goes to stderr), and sets a non-zero exit code when the stop did
 * not free the port (agents read the exit status, not the emoji). Never throws.
 */
export async function runStopCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const port = parsePortArg(argv) ?? 3000;
  const r = await stopDevServer(port);
  (isStopWarning(r) ? console.error : console.log)(stopMessage(r));
  if (isStopWarning(r)) process.exitCode = 1;
}

/** Parse `--port <n>` / `--port=<n>` from argv; `null` when absent/invalid. Pure. */
export function parsePortArg(argv: readonly string[]): number | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' && i + 1 < argv.length) {
      const n = Number(argv[i + 1]);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    const m = /^--port=(\d+)$/.exec(a);
    if (m) {
      const n = Number(m[1]);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
  }
  return null;
}

/**
 * What the local API handler logs, from `BLOCKS_DEV_QUIET` (silences all of
 * it, as before) and `BLOCKS_LOG_LEVEL`:
 * - `traffic`: the per-call `[rpc-in]`/`[rpc-call]`/`[rpc-ok]` lines — the
 *   default level and `verbose`/`debug`; hidden at `quiet`/`normal`.
 * - `errors`: a failed call's name, message and `cause` — every level.
 * - `stacks`: its stack trace — the default level and `debug`.
 */
export function devRequestLogging(env: NodeJS.ProcessEnv = process.env): {
  traffic: boolean;
  errors: boolean;
  stacks: boolean;
} {
  if (env.BLOCKS_DEV_QUIET) return { traffic: false, errors: false, stacks: false };
  const level = resolveLogLevel(env);
  return { traffic: !isCuratedLevel(level), errors: true, stacks: level === 'legacy' || level === 'debug' };
}

// ── Local API handler ────────────────────────────────────────────────────────

/**
 * The dispatcher behind the local API: the same RawRoute and JSON-RPC handling
 * as the deployed handlers, with the dev server's CORS policy (reflect a
 * localhost origin, never refuse one), its request logging, and the available
 * APIs named in an unknown-namespace error.
 */
function createDevDispatcher(backend: unknown, bound: DevServerAddress): Dispatcher {
  return createDispatcher(backend, {
    cors: {
      rejects: () => false,
      headers: (origin, request) => buildDevCorsHeaders(origin, bound, request.headers().get('host') ?? undefined),
    },
    listApisWhenNotFound: true,
    // A request's unhandled rejection is logged with its method (see installDevRejectionHandler).
    runHandler: runDevRequest,
    rpcTrace: {
      parseError(response) {
        if (devRequestLogging().traffic) console.log('[rpc-out parse-error]', response);
      },
      call(apiNamespace, method, args) {
        if (devRequestLogging().traffic) {
          // redactToJson handles circulars and serialization failures itself.
          console.log('[rpc-call]', `${apiNamespace}.${method}`, redactToJson(args));
        }
      },
      result(apiNamespace, method, value) {
        if (devRequestLogging().traffic) {
          // Log a redacted copy of the response value — never the raw
          // payload, which can carry challenge `session` tokens, MFA shared
          // secrets, etc. that the client legitimately round-trips.
          const okLog = redactToJson(value);
          console.log('[rpc-ok]', `${apiNamespace}.${method}`,
            okLog.length > 800 ? okLog.slice(0, 800) + '…' : okLog);
        }
      },
    },
    logHandlerError(failure) {
      const logging = devRequestLogging();
      if (!logging.errors) return;
      const error: any = failure.error;
      if (failure.source === 'rpc') {
        console.log('[rpc-err]', `${failure.apiNamespace}.${failure.method}`, error?.name ?? 'Error', '-', error?.message);
        // A re-tagged/branded error carries a stable BB message; the raw driver/SDK
        // text lives on `cause` (server-side only). Surface it here so a SQL typo or
        // connection error shows useful text in the local terminal.
        if (error?.cause) console.log('  cause:', error.cause);
        if (logging.stacks && error?.stack) console.log(error.stack);
        return;
      }
      console.error('RawRoute Error:', error?.name ?? 'Error', '-', error?.message);
      // A branded error carries a stable BB message; the raw driver/SDK text
      // lives on `cause` (server-side only). Surface it here, matching the RPC
      // log above, so a developer debugging a raw-route failure sees it.
      if (error?.cause) console.error('  cause:', error.cause);
      if (logging.stacks && error?.stack) console.error(error.stack);
    },
  });
}

function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  dispatch: Dispatcher,
  bound: DevServerAddress,
): void {
  const isRpc = method === 'POST' && isRpcPath(url.pathname);
  if (isRpc || matchRoute(method, url.pathname)) {
    const signal = clientGoneSignal(res);
    // The server's request handler set these on `res`; a dispatcher 500 clears every header
    // set so far, so it is handed them again to keep the answer readable by the
    // browser.
    const corsHeaders = buildDevCorsHeaders(req.headers.origin || '', bound, req.headers.host);
    // JSON-RPC bodies are capped at MAX_RPC_BODY_BYTES, as in the deployed
    // handlers; RawRoute bodies are read whole.
    readBody(req, isRpc ? MAX_RPC_BODY_BYTES : Infinity).then(async (body) => {
      if (body === undefined) {
        // Drain the rest before answering, so the response isn't lost to a
        // reset, then answer with the JSON-RPC 413 envelope the dispatcher
        // gives (see parseRpcRequest).
        await discardRemainingBody(req);
        if (!req.complete) res.setHeader('Connection', 'close');
        const envelope = payloadTooLargeResponse();
        if (devRequestLogging().traffic) console.log('[rpc-out parse-error]', envelope);
        writeResponse(res, { status: 200, headers: rpcResponseHeaders(corsHeaders), cookies: [], body: envelope }, undefined, corsHeaders);
        return;
      }
      // Verbose request/response logging — useful when debugging cross-stack
      // wire format mismatches (e.g. native client codegen vs server). Set
      // BLOCKS_DEV_QUIET=1 to suppress (BLOCKS_LOG_LEVEL=quiet|normal keeps only
      // the error lines; see devRequestLogging). Sensitive fields (passwords, session
      // tokens, OTP codes) are redacted so they never reach the log stream.
      if (isRpc && devRequestLogging().traffic) {
        const text = body.toString('utf-8');
        let inLog: string;
        try {
          inLog = redactToJson(JSON.parse(text || '{}'));
        } catch {
          // Body isn't valid JSON (the dispatcher answers with a parse error) —
          // fall back to the raw text. A malformed body can't carry a structured
          // secret, but truncate it like before to keep logs readable.
          inLog = text;
        }
        console.log('[rpc-in]', inLog.length > 800 ? inLog.slice(0, 800) + '…' : inLog);
      }
      dispatch(toDispatchRequest(req, body, { path: url.pathname, signal })).then(
        (response) => writeResponse(res, response, undefined, corsHeaders),
        (error: unknown) => {
          console.error('Dev server error:', error);
          if (res.headersSent) res.destroy();
          else writeInternalServerError(res, corsHeaders);
        },
      );
    }, () => {
      // An aborted upload never emits 'end'; close the response instead of
      // leaving it open.
      res.destroy();
    });
    return;
  }

  // Anything that reaches here didn't match `POST /aws-blocks/api`. Returning a
  // bare empty 404 leaves a developer poking at the endpoint (e.g. opening it in
  // a browser, which sends a GET, or trying a REST-style URL) with no feedback.
  // Reply with a small JSON hint pointing at the one supported shape. When the
  // path was right but the method wasn't, say so explicitly.
  const wrongMethodOnApi = isRpcPath(url.pathname);
  const message = wrongMethodOnApi
    ? `The AWS Blocks JSON-RPC API expects POST, not ${method}.`
    : 'Not found. The AWS Blocks JSON-RPC API is served at POST /aws-blocks/api.';
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: message,
      // On an RPC path, echo the path the caller hit (e.g. `/aws-blocks/api/{namespace}`).
      expected: { method: 'POST', path: wrongMethodOnApi ? url.pathname : BLOCKS_RPC_PREFIX },
    }),
  );
}
