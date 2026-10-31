 // Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Agent, createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL, URL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { writeFileSync, mkdirSync, readFileSync, unlinkSync, renameSync, linkSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
  KILL_GRACE_MS,
  killFrontendTree,
  terminateProcessTree,
  findListenerPids,
  killListenerTree,
  waitForProcessGroupExit,
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
 * Resolve the CORS origin for the dev server.
 * Reflects back origins matching localhost/127.0.0.1; otherwise returns the fallback.
 */
export function resolveDevCorsOrigin(origin: string): string {
  return LOCALHOST_PATTERN.test(origin) ? origin : 'http://localhost:3000';
}

/**
 * Build the CORS response headers the dev server sets on every request.
 *
 * Mirrors the Lambda path's cache posture — same {@link CORS_MAX_AGE} and the
 * same `Vary: Origin` — so the reflected `Access-Control-Allow-Origin` can't be
 * served across origins by a shared cache, and so the two sites can't drift.
 */
export function buildDevCorsHeaders(requestOrigin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': resolveDevCorsOrigin(requestOrigin),
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

/** Outcome of {@link reclaimPort}. */
export interface ReclaimResult {
  /** Whether the port was bound when reclaim started. */
  wasOpen: boolean;
  /** Whether the port is free once reclaim finishes (true when it was never open). */
  reclaimed: boolean;
  /** Listener PIDs discovered (and signalled). Empty when the port was free, or no owner PID was found. */
  pids: number[];
}

/** Injectable seams for {@link reclaimPort} (real implementations by default). */
export interface ReclaimPortDeps {
  /** True iff the port is currently bound. */
  probe: (port: number) => Promise<boolean>;
  /** PIDs of the listener(s) holding the port. */
  listPids: (port: number) => number[];
  /** Terminate a listener PID's tree (POSIX group kill / Windows taskkill). */
  killTree: (pid: number, signal: NodeJS.Signals) => void;
  /** Wait (bounded) for the port to be released. */
  waitFree: (port: number, timeoutMs?: number) => Promise<void>;
}

/**
 * Free a port left bound by a crashed / SIGKILL'd predecessor so a fresh dev
 * server can bind the `:3000` front door — or spawn its `--strictPort` frontend
 * on `:3100` — instead of colliding on it and crashing.
 *
 * No-op when the port is already free. Otherwise it discovers the listener PID(s)
 * ({@link findListenerPids}, an `lsof`/`netstat` probe — the same fuser-style
 * mechanism `cleanup` uses), SIGTERMs each ({@link killListenerTree}, which
 * reuses the frontend process-group kill), waits (bounded) for release
 * ({@link waitForPortFree}), then escalates to SIGKILL if the port is still held.
 * This deliberately mirrors the respawn path (process-group kill + port-free
 * wait) rather than inventing a new teardown mechanism.
 *
 * The caller is responsible for NOT reclaiming a *healthy peer* dev server — the
 * singleton guard ({@link evaluateSingleton}) runs first and bows out when a live
 * peer owns the front door, so anything still holding these ports here is an
 * orphan. Dependencies are injected for tests; returns what it did for
 * logging/assertions. Best-effort: never throws.
 *
 * Probe contract: the default `probe` is {@link isPortOpen} with no host, which
 * checks BOTH `127.0.0.1` and `::1`, so an orphan holding the port on either
 * loopback family is detected (and thus reclaimed) — a single-family `localhost`
 * probe could miss it and no-op.
 */
export async function reclaimPort(port: number, deps: Partial<ReclaimPortDeps> = {}): Promise<ReclaimResult> {
  const probe = deps.probe ?? ((p) => isPortOpen(p));
  const listPids = deps.listPids ?? ((p) => findListenerPids(p));
  const killTree = deps.killTree ?? ((pid, sig) => killListenerTree(pid, sig));
  const waitFree = deps.waitFree ?? ((p, t) => waitForPortFree(p, t));

  if (!(await probe(port))) return { wasOpen: false, reclaimed: true, pids: [] };

  const pids = listPids(port);
  for (const pid of pids) killTree(pid, 'SIGTERM');
  await waitFree(port, 2000);

  if (await probe(port)) {
    // Still held after a graceful SIGTERM — escalate to SIGKILL. ALWAYS re-list
    // first: the owner set can change during the wait — the original process may
    // have exited and a NEW one grabbed the port, so SIGKILLing the stale `pids`
    // would miss the real owner. Fall back to the stale list only if the re-list
    // comes back empty (e.g. lsof was momentarily unavailable).
    const killPids = listPids(port);
    for (const pid of killPids.length ? killPids : pids) killTree(pid, 'SIGKILL');
    await waitFree(port, 2000);
  }

  return { wasOpen: true, reclaimed: !(await probe(port)), pids };
}

/**
 * Build the console message for a startup reclaim of a port that was in use,
 * distinguishing the three meaningfully different outcomes so the operator knows
 * what (if anything) to do next:
 *  - reclaimed → we freed it; startup continues.
 *  - not reclaimed but owner PID(s) known → tell the operator exactly which
 *    process(es) to stop and retry.
 *  - not reclaimed and no owner PID found → nothing to point at (lsof/netstat
 *    found no listener), so surface the generic "in use" message.
 * `subject` describes what was reclaimed (e.g. 'a stale/orphaned listener'). Pure.
 */
export function reclaimMessage(port: number, result: ReclaimResult, subject: string): string {
  if (result.reclaimed) {
    return `♻️  Reclaimed port ${port} from ${subject} before startup.`;
  }
  if (result.pids.length > 0) {
    return (
      `⚠️  Port ${port} held by pid(s) [${result.pids.join(', ')}] and could not be freed — ` +
      `stop that process and retry.`
    );
  }
  return `⚠️  Port ${port} is in use and could not be reclaimed automatically (no owner PID found).`;
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

/** Persisted identity of the dev server that owns a given front-door port. */
export interface DevServerPidRecord {
  /** The supervisor process's own pid. */
  pid: number;
  /** The supervisor's parent pid — the stable `tsx watch` watcher across reloads. */
  ppid: number;
  /** The front-door port this record guards. */
  port: number;
  /**
   * `pid`'s command line when the record was written (`''` where it can't be
   * read). A live `pid` counts as this dev server only while its command line
   * still matches, so a pid the OS has since reused never blocks a start.
   * Absent in a record written by an older version.
   */
  command?: string;
  /** `ppid`'s command line when the record was written; see {@link command}. */
  parentCommand?: string;
}

/** Parse a pidfile body into a {@link DevServerPidRecord}; `null` if absent/corrupt/incomplete. */
export function parsePidRecord(text: string): DevServerPidRecord | null {
  try {
    const o = JSON.parse(text);
    if (o && Number.isInteger(o.pid) && Number.isInteger(o.ppid) && Number.isInteger(o.port)) {
      const record: DevServerPidRecord = { pid: o.pid, ppid: o.ppid, port: o.port };
      if (typeof o.command === 'string') record.command = o.command;
      if (typeof o.parentCommand === 'string') record.parentCommand = o.parentCommand;
      return record;
    }
  } catch {
    // Corrupt / empty pidfile — treat as absent.
  }
  return null;
}

/** True iff a signal can be delivered to `pid` (exists). `EPERM` (exists, not ours) counts as alive. */
export function isPidAlive(pid: number, kill: (pid: number, signal: number) => void = (p, s) => process.kill(p, s)): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read `pid`'s full command line (`ps -ww -o command=`), '' on any failure or Windows. */
function pidCommand(pid: number): string {
  if (process.platform === 'win32') return '';
  try {
    const { stdout } = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 3000,
    });
    return (stdout ?? '').trim();
  } catch {
    return '';
  }
}

/** True iff `command` looks like a `tsx watch` supervisor (not a bare shell). */
function isTsxWatcher(command: string): boolean {
  return /\btsx\b/.test(command) && /\bwatch\b/.test(command);
}

/** Which of a record's processes are still the ones it recorded. */
export interface RecordLiveness {
  /** The recorded dev server is alive, with the command line it had. */
  pidAlive: boolean;
  /** Its `tsx watch` parent is alive, with the command line it had: the session goes on across a reload. */
  watcherAlive: boolean;
}

/**
 * Check a record's processes against the live system. A pid counts only while
 * its command line still matches the recorded one (when the record has one),
 * and the parent only while it is a `tsx watch` supervisor: a plain
 * `node server.ts` start has the caller's shell as its parent, which outlives
 * the dev server and must not keep a stale record alive.
 */
export function recordLiveness(
  record: DevServerPidRecord,
  isAlive: (pid: number) => boolean,
  commandOf: (pid: number) => string,
): RecordLiveness {
  const pidAlive =
    isAlive(record.pid) && (record.command === undefined || commandOf(record.pid) === record.command);
  let watcherAlive = false;
  if (record.ppid > 1 && isAlive(record.ppid)) {
    const parent = commandOf(record.ppid);
    watcherAlive = isTsxWatcher(parent) && (record.parentCommand === undefined || parent === record.parentCommand);
  }
  return { pidAlive, watcherAlive };
}

/** Result of {@link evaluateSingleton}: proceed with startup, or exit (a live peer owns the port). */
export type SingletonDecision = { action: 'proceed' } | { action: 'exit'; reason: string };

/**
 * Decide whether a *new* dev-server invocation may take over an existing
 * pidfile, or must bow out because another session already owns `port`. This
 * is the singleton guard that stops two supervisors fighting over
 * `:3000`/`:3100`, WITHOUT breaking `tsx watch`'s own restart of the *same*
 * supervisor on a file change.
 *
 * - **No / corrupt pidfile** → proceed.
 * - **Same pid** → proceed (defensive; the record is our own).
 * - **Same parent (`ppid`) and the recorded child is gone** → proceed: `tsx
 *   watch` is the stable parent across reloads, and it relaunches after the old
 *   child exits. (Two jobs started from one shell also share a parent, so a
 *   live recorded child still goes through the owner check below.)
 * - **The recorded dev server, or its `tsx watch` session, is still alive**
 *   (see {@link recordLiveness}) → exit with a clear message. A session between
 *   two reloads has no live child but a live watcher, and still owns the port.
 * - **Otherwise** the record is stale → proceed.
 */
export function evaluateSingleton(
  existing: DevServerPidRecord | null,
  self: { pid: number; ppid: number },
  liveness: RecordLiveness,
): SingletonDecision {
  if (!existing) return { action: 'proceed' };
  if (existing.pid === self.pid) return { action: 'proceed' };
  if (existing.ppid === self.ppid && !liveness.pidAlive) return { action: 'proceed' }; // tsx-watch relaunch after old child exit
  if (liveness.pidAlive || liveness.watcherAlive) {
    const pid = liveness.pidAlive ? existing.pid : existing.ppid;
    return { action: 'exit', reason: `a dev server is already running on :${existing.port} (pid ${pid})` };
  }
  return { action: 'proceed' };
}

/** Injectable seams for {@link claimDevPidfile} (real file system and process table by default). */
export interface ClaimPidfileDeps {
  /** Create `path` holding `body` only if it doesn't exist; false when it does. Atomic: no reader sees it half-written. */
  createExclusive: (path: string, body: string) => boolean;
  /** The file's body, or null when it doesn't exist. */
  read: (path: string) => string | null;
  /** Rename `from` to `to`; false when `from` doesn't exist. */
  rename: (from: string, to: string) => boolean;
  /** Delete `path` if it exists. */
  remove: (path: string) => void;
  isAlive: (pid: number) => boolean;
  commandOf: (pid: number) => string;
}

/** Outcome of {@link claimDevPidfile}. */
export type PidfileClaim =
  | {
      acquired: true;
      /** The stale record this start took over (a crashed predecessor, or our own `tsx watch` predecessor), if any. */
      previous: DevServerPidRecord | null;
    }
  | { acquired: false; reason: string };

/** Write `body` to `path` only if `path` doesn't exist, atomically (temp file + hard link; `wx` where links fail). */
function createFileExclusive(path: string, body: string): boolean {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // A file system without hard links: fall back to an exclusive create.
    try {
      writeFileSync(path, body, { flag: 'wx' });
      return true;
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e2;
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

function defaultClaimDeps(): ClaimPidfileDeps {
  return {
    createExclusive: createFileExclusive,
    read: (p) => {
      try { return readFileSync(p, 'utf-8'); } catch { return null; }
    },
    rename: (from, to) => {
      try { renameSync(from, to); return true; } catch { return false; }
    },
    remove: (p) => {
      try { unlinkSync(p); } catch { /* already gone */ }
    },
    isAlive: (pid) => isPidAlive(pid),
    commandOf: (pid) => pidCommand(pid),
  };
}

/** How many times {@link claimDevPidfile} retries when other starts keep changing the pidfile under it. */
const CLAIM_ATTEMPTS = 5;

/**
 * Take the per-port pidfile for `self`, so exactly one dev server runs on a
 * port even when several start at the same moment.
 *
 * The pidfile is created exclusively, so of two simultaneous starts only one
 * creates it. When it already exists, {@link evaluateSingleton} decides: a live
 * owner makes this start bow out; a stale (or unreadable) record is taken over.
 * The takeover first renames the old pidfile to a private path — of two starts
 * that both found it stale, only one rename succeeds — then checks that what
 * it took is the record it judged (a racer may have replaced it, in which case
 * that record is put back and judged again), then creates the pidfile afresh.
 */
export function claimDevPidfile(
  path: string,
  self: DevServerPidRecord,
  deps: Partial<ClaimPidfileDeps> = {},
): PidfileClaim {
  const d = { ...defaultClaimDeps(), ...deps };
  const body = JSON.stringify(self);
  const judge = (record: DevServerPidRecord | null): SingletonDecision =>
    record ? evaluateSingleton(record, self, recordLiveness(record, d.isAlive, d.commandOf)) : { action: 'proceed' };
  let previous: DevServerPidRecord | null = null;
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    if (d.createExclusive(path, body)) return { acquired: true, previous };
    const text = d.read(path);
    if (text === null) continue; // removed since: create again
    const existing = parsePidRecord(text);
    const decision = judge(existing);
    if (decision.action === 'exit') return { acquired: false, reason: decision.reason };
    const claimPath = `${path}.${self.pid}.gc`;
    if (!d.rename(path, claimPath)) continue; // another start took it first
    const claimedText = d.read(claimPath);
    const claimed = claimedText === null ? null : parsePidRecord(claimedText);
    if (claimedText !== text) {
      const again = judge(claimed);
      if (again.action === 'exit') {
        // A racer's live record: put it back unless yet another start has created one since.
        if (claimedText !== null && !d.createExclusive(path, claimedText)) { /* the newer one stays */ }
        d.remove(claimPath);
        return { acquired: false, reason: again.reason };
      }
    }
    d.remove(claimPath);
    previous = claimed ?? previous;
  }
  return { acquired: false, reason: `other dev servers kept starting on :${self.port}` };
}

/**
 * The environment variable naming a file the dev server writes a one-line
 * reason to when it can't start (another dev server owns the port, the port is
 * taken, the bind fails). `blocks dev` sets it, so it can tell this failure
 * apart from a requested stop: both end its `tsx watch` with a signal.
 */
export const DEV_FAILURE_FILE_ENV = 'BLOCKS_DEV_FAILURE_FILE';

/** `blocks dev stop`, with `--port` when the port isn't the default. */
function devStopCommand(port: number): string {
  return port === 3000 ? 'blocks dev stop' : `blocks dev stop --port ${port}`;
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
  // pid. A stale pidfile (dead owner) never blocks startup.
  const pidfilePath = devPidfilePath(port);
  const removeOwnPidfile = (): void => {
    // Close the read-check-then-delete TOCTOU: a naive `read → if mine → unlink`
    // could delete a tsx-watch SUCCESSOR's pidfile if it wrote between our read
    // and our unlink. Instead we atomically `rename` the current pidfile to a
    // pid-private path (rename(2) is atomic — a concurrent writer can't observe a
    // half-state), THEN inspect the snapshot:
    //   • it's ours        → unlink the private copy (done; a successor that
    //                         writes a fresh pidfile afterwards is untouched
    //                         because we never unlink the canonical path).
    //   • it's a successor → we grabbed its file (it wrote before our rename);
    //                         put it back so the live successor keeps its guard.
    // We only ever unlink the private claim, never the canonical path, so a
    // successor's fresh pidfile is never destroyed.
    const claimPath = `${pidfilePath}.${process.pid}.gc`;
    try {
      renameSync(pidfilePath, claimPath);
    } catch {
      return; // No pidfile to remove (already gone / never written).
    }
    let rec: DevServerPidRecord | null = null;
    try { rec = parsePidRecord(readFileSync(claimPath, 'utf-8')); } catch { /* unreadable snapshot */ }
    if (rec && rec.pid !== process.pid) {
      // Snapshot belongs to a successor — restore it (unless a newer one exists) and leave its guard intact.
      try { linkSync(claimPath, pidfilePath); } catch { /* a newer pidfile stays */ }
    }
    try { unlinkSync(claimPath); } catch { /* already gone */ }
  };
  {
    mkdirSync(BLOCKS_SANDBOX_DIR, { recursive: true });
    const claim = claimDevPidfile(pidfilePath, {
      pid: process.pid,
      ppid: process.ppid,
      port,
      command: pidCommand(process.pid),
      parentCommand: pidCommand(process.ppid),
    });
    if (!claim.acquired) {
      failDevStartup(claim.reason, `Not starting a second one. Stop it with \`${devStopCommand(port)}\`, or use another --port.`);
      return;
    }
  }

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
  const dispatch = createDevDispatcher(backend);

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
      }
      console.log(`\n  ➜  http://localhost:${port}/${suffix}\n`);
    } catch (e) {
      console.error(`⚠️  Frontend did not start: ${(e as Error).message}`);
      console.log(`\n  ➜  http://localhost:${port}/  (API only — frontend unavailable)\n`);
    }
  };

  const spawnFrontend = (command: string): ChildProcess => {
    const child = spawn(command, {
      shell: true,
      // Own process group on POSIX so we can reap the Vite grandchild too.
      detached: usePosixProcessGroups,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    frontendProcess = child;

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
    for (const [name, value] of Object.entries(buildDevCorsHeaders(requestOrigin))) {
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
      res.end(JSON.stringify(blocksConfig));
      return;
    }

    // ── API/RawRoute requests ──────────────────────────────────────────
    if (isApiRequest(method, url.pathname)) {
      if (isSandbox && apiProxy) {
        apiProxy.web(req, res);
        return;
      }
      handleApiRequest(req, res, url, method, dispatch);
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

  (globalThis as any).__BLOCKS_REALTIME_WS_URL__ = `ws://localhost:${port}/realtime`;
  (globalThis as any).__BLOCKS_DEV_SERVER_PORT__ = port;

  // Config already written during startup (local mode overwrites, sandbox mode preserves).

  // Generate client code — skip in sandbox mode because sandbox.ts already
  // generated it with --conditions=aws-runtime (correct aws-middleware).
  // Re-generating here without that condition would overwrite with mock-middleware.
  if (!isSandbox) {
    const awsBlocksDir = dirname(resolvedPath);
    const clientPath = join(awsBlocksDir, 'client.js');
    log.progress('📝 Generating client code...');
    await writeClientCode(resolvedPath, clientPath);
  }

  // Type-safe getSecret/getConfig: generate + watch the key augmentation so the
  // getters autocomplete and reject typos, regenerating on save — all under this
  // one `npm run dev`. Auto-detected (no-op unless the app uses secret()/config())
  // and non-fatal.
  const stopTypegen = options.typegen === false ? undefined : await startTypegenWatch();

  // ── Startup reclaim ──────────────────────────────────────────────────────
  // Free any port left bound by a crashed / SIGKILL'd predecessor before we bind
  // the front door or spawn the `--strictPort` frontend. tsx-watch only gives the
  // previous process ~5s to run cleanup(); if it was SIGKILL'd or crashed, its
  // detached Vite grandchild (or an orphaned backend) can still hold :3100/:3000
  // and a fresh `--strictPort` start would collide and crash. The singleton guard
  // above already ruled out a live *peer* supervisor, so anything still holding
  // these ports is an orphan — reclaim it (see {@link reclaimPort}).
  // A successful reclaim (♻️) is an informational confirmation → stdout; a
  // failed reclaim (⚠️) is a warning the operator must act on → stderr. Keeping
  // healthy-startup output off stderr avoids false alarms in CI pipelines that
  // treat any stderr line as a failure.
  const r3000 = await reclaimPort(port);
  if (r3000.wasOpen) {
    (r3000.reclaimed ? log.progress : console.error)(reclaimMessage(port, r3000, 'a stale/orphaned listener'));
  }
  if (frontendCommand) {
    const rFrontend = await reclaimPort(frontendPort);
    if (rFrontend.wasOpen) {
      (rFrontend.reclaimed ? log.progress : console.error)(reclaimMessage(frontendPort, rFrontend, 'a stale/orphaned dev server'));
    }
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
    console.log(`AWS Blocks local server running on http://localhost:${port}`);
    buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: Date.now() - devStartTime });

    // Spawn frontend dev server after Blocks server is ready
    if (frontendCommand) {
      const child = spawnFrontend(frontendCommand);
      await announceFrontendReady(child);
    } else {
      console.log(`\n  ➜  http://localhost:${port}/\n`);
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
    reclaim: (p) => reclaimPort(p),
    relisten: () => server.listen(port, host, onListening),
    scheduleRetry: (fn, delayMs) => { scheduleBindRetry(fn, delayMs); },
    onExhausted: () => failDevStartup(`port ${port} is still in use`, 'Stop the process that holds it, or use another --port.'),
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
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return; // idempotent — a second signal must not re-enter
    cleaningUp = true;
    isShuttingDown = true; // stop the supervisor from respawning the frontend
    log.progress('\nShutting down...');

    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
    stopTypegen?.(); // tear down the typegen watcher (unref'd, but close it cleanly)
    // Keep the listeners until we exit. A Ctrl-C or a group SIGTERM reaches us
    // directly and again as `tsx watch` relays it; tsx's preflight exits the
    // process on a signal that has no other listener, which would cut this
    // cleanup short and leave the frontend running.

    // Kill the frontend process *group* and wait for the port to free before
    // we exit, so a tsx-watch restart can rebind `:3100` cleanly.
    const child = frontendProcess;
    frontendProcess = null;
    await terminateFrontend(child);

    if (typeof backend.__cleanup === 'function') {
      try { await backend.__cleanup(); } catch {}
    }
    // Release the singleton pidfile so the next `npm run dev` isn't blocked by
    // our own stale record (only removed if it still points at us — a hot-reload
    // successor may already own it).
    removeOwnPidfile();
    frontendProxy?.close();
    frontendAgent?.destroy();
    apiProxy?.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };

  for (const sig of signals) process.on(sig, cleanup);

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
    removeOwnPidfile();
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

/** The per-port pidfile path a dev server records its supervisor identity in. */
export function devPidfilePath(port: number): string {
  return join(BLOCKS_SANDBOX_DIR, `dev-server.${port}.pid`);
}

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
   *  - `watcher`  — SIGTERM to the recorded `tsx watch` ppid (the clean path).
   *  - `listener` — fallback: killed the recorded child pid's listener tree
   *                 (watcher was already gone / not a tsx watcher).
   *  - `none`     — nothing live was recorded.
   */
  via: 'watcher' | 'listener' | 'none';
  /** PIDs signalled. */
  pids: number[];
  /** True when, after signalling, the front-door port is confirmed free. */
  portFree: boolean;
}

/** Injectable seams for {@link stopDevServer} (real implementations by default). */
export interface StopDevServerDeps {
  /** Read a pidfile body, or null when absent/unreadable. */
  readPidfile: (path: string) => string | null;
  /** Delete the pidfile. */
  removePidfile: (path: string) => void;
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
  /** Terminate a listener PID's tree (fallback path only). */
  killTree: (pid: number, sig: NodeJS.Signals) => void;
  /** Wait (bounded) for a port to be released. */
  waitFree: (port: number, timeoutMs?: number) => Promise<void>;
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
    removePidfile: (p) => {
      try {
        unlinkSync(p);
      } catch {
        /* already gone */
      }
    },
    isAlive: (pid) => isPidAlive(pid),
    commandOf: (pid) => pidCommand(pid),
    signal: (pid, sig) => process.kill(pid, sig),
    probe: (p) => isPortOpen(p),
    listPids: (p) => findListenerPids(p),
    killTree: (pid, sig) => killListenerTree(pid, sig),
    waitFree: (p, t) => waitForPortFree(p, t),
  };
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
  });

  if (!record) return result('none', [], !(await d.probe(port)));

  const watcherAlive = record.ppid > 1 && d.isAlive(record.ppid);
  const childAlive = d.isAlive(record.pid);

  // Nothing we recorded is alive — stale pidfile. Clear it, report no-op.
  if (!watcherAlive && !childAlive) {
    d.removePidfile(pidfilePath);
    return result('none', [], !(await d.probe(port)));
  }

  // Primary path: SIGTERM the recorded tsx watch supervisor.
  if (watcherAlive && isTsxWatcher(d.commandOf(record.ppid))) {
    try {
      d.signal(record.ppid, 'SIGTERM');
    } catch {
      /* raced away */
    }
    await d.waitFree(port, 3000);
    const portFree = !(await d.probe(port));
    if (portFree) d.removePidfile(pidfilePath);
    return result('watcher', [record.ppid], portFree);
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
    if (portFree) d.removePidfile(pidfilePath);
    return result('listener', [record.pid], portFree);
  }

  // The recorded owner is alive but no longer holds the port (e.g. already
  // shutting down). Clear the pidfile if the port is free.
  const portFree = !(await d.probe(port));
  if (portFree) d.removePidfile(pidfilePath);
  return result('none', [], portFree);
}

/** Human-readable one-liner describing a {@link StopResult}, for the CLI. */
export function stopMessage(result: StopResult): string {
  if (result.alreadyStopped) {
    return `No dev server was running on :${result.port} (nothing to stop).`;
  }
  const who = result.pids.length ? ` (pid${result.pids.length > 1 ? 's' : ''} ${result.pids.join(', ')})` : '';
  if (result.portFree) {
    return `🛑 Stopped the dev server on :${result.port}${who}.`;
  }
  return (
    `⚠️  Signalled the dev server on :${result.port}${who}, but the port is still ` +
    `bound — it may still be shutting down, or another process now holds it.`
  );
}

/**
 * CLI entry for the `dev:stop` template script. Stops the dev server on the
 * front-door port (`--port N`, default 3000), prints one {@link stopMessage},
 * and sets a non-zero exit code when the stop did not free the port (agents read
 * the exit status, not the emoji). Never throws.
 */
export async function runStopCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const port = parsePortArg(argv) ?? 3000;
  const r = await stopDevServer(port);
  console.log(stopMessage(r));
  if (!r.alreadyStopped && !r.portFree) process.exitCode = 1;
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
function createDevDispatcher(backend: unknown): Dispatcher {
  return createDispatcher(backend, {
    cors: { rejects: () => false, headers: buildDevCorsHeaders },
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
): void {
  const isRpc = method === 'POST' && isRpcPath(url.pathname);
  if (isRpc || matchRoute(method, url.pathname)) {
    const signal = clientGoneSignal(res);
    // The server's request handler set these on `res`; a dispatcher 500 clears every header
    // set so far, so it is handed them again to keep the answer readable by the
    // browser.
    const corsHeaders = buildDevCorsHeaders(req.headers.origin || '');
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
