 // Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL, URL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { writeFileSync, mkdirSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import httpProxy from 'http-proxy';
import { writeClientCode } from './generate-client.js';
import { ApiError } from '../errors.js';
import { BLOCKS_RPC_PREFIX, BLOCKS_SANDBOX_PREFIX } from '../constants.js';
import { BLOCKS_SANDBOX_DIR } from '../common/constants.js';
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
import { killFrontendTree, terminateProcessTree, findListenerPids, killListenerTree } from './process-tree.js';

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

/**
 * Single-shot TCP probe: resolves `true` iff a connection to `port` succeeds
 * within `timeoutMs`, else `false` (connection error or timeout). Never rejects.
 *
 * When `host` is omitted the port is probed on BOTH loopback families —
 * `127.0.0.1` (IPv4) and `::1` (IPv6) — and reported open if EITHER answers.
 * This matters because `server.listen(port, …)` (below) passes no host, so Node
 * binds dual-stack on `::` (all interfaces, both families). A single `localhost`
 * probe resolves to only one of `::1`/`127.0.0.1` on a given host, so an orphan
 * holding the port on the *other* family would be invisible — leaving the
 * startup/EADDRINUSE reclaim path blind to a port that `listen` will still
 * reject. Probing both families keeps every "is the port bound" check in
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
 * checks BOTH `127.0.0.1` and `::1`. `server.listen` binds dual-stack on `::`,
 * so an orphan holding the port on either loopback family is detected (and thus
 * reclaimed) — a single-family `localhost` probe could miss it and no-op.
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
  /** Re-attempt the bind (`server.listen(port, onListening)` in prod). */
  relisten: () => void;
  /** Schedule the next attempt after a backoff (`setTimeout` in prod). */
  scheduleRetry: (fn: () => void, delayMs: number) => void;
  /** Called once the attempt budget is exhausted (`process.exit(1)` in prod). */
  onExhausted: () => void;
  /** Warning/error sink (`console.error` in prod). */
  warn: (msg: string) => void;
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
      deps.warn(
        `\n❌ Port ${port} is still in use after ${policy.maxAttempts} ` +
        `attempts to reclaim it — another process is holding :${port}. Stop it (or run the ` +
        `cleanup script) and retry \`npm run dev\`.\n`,
      );
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
}

/** Parse a pidfile body into a {@link DevServerPidRecord}; `null` if absent/corrupt/incomplete. */
export function parsePidRecord(text: string): DevServerPidRecord | null {
  try {
    const o = JSON.parse(text);
    if (o && Number.isInteger(o.pid) && Number.isInteger(o.ppid) && Number.isInteger(o.port)) {
      return { pid: o.pid, ppid: o.ppid, port: o.port };
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

/** Result of {@link evaluateSingleton}: proceed with startup, or exit cleanly (a live peer owns the port). */
export type SingletonDecision = { action: 'proceed' } | { action: 'exit'; reason: string };

/**
 * Decide whether a *new* dev-server invocation should start, or bow out because
 * another supervisor already owns `port`. This is the singleton guard that stops
 * the "two fighting supervisors" restart loop — a second `npm run dev` racing the
 * first on `:3000`/`:3100` — WITHOUT breaking `tsx watch`'s own restart of the
 * *same* supervisor on a file change.
 *
 * - **No / corrupt pidfile** → proceed (first start; startup reclaim covers any orphan socket).
 * - **Same pid** → proceed (defensive; the record is our own).
 * - **Same parent (`ppid`)** → proceed. `tsx watch` is the stable parent across
 *   reloads, so a matching parent means the watcher is relaunching OUR OWN script
 *   — not a competitor. A second `npm run dev` runs under a *different* watcher,
 *   so it never matches here. This carve-out is what preserves hot reload.
 * - **Different, still-live owner actually holding the port** → exit cleanly with
 *   a clear message (do not spawn a competing supervisor).
 * - **Otherwise** (recorded owner is dead → stale pidfile, or the port is free)
 *   → proceed; startup reclaim frees any orphaned socket.
 */
export function evaluateSingleton(
  existing: DevServerPidRecord | null,
  self: { pid: number; ppid: number },
  portInUse: boolean,
  isAlive: (pid: number) => boolean,
): SingletonDecision {
  if (!existing) return { action: 'proceed' };
  if (existing.pid === self.pid) return { action: 'proceed' };
  if (existing.ppid === self.ppid) return { action: 'proceed' }; // tsx-watch relaunch of our own supervisor
  const ownerAlive = isAlive(existing.pid) || (existing.ppid > 1 && isAlive(existing.ppid));
  if (ownerAlive && portInUse) {
    return { action: 'exit', reason: `dev server already running on :${existing.port} (pid ${existing.pid})` };
  }
  return { action: 'proceed' };
}

export async function startDevServer(options: DevServerOptions) {
  const {
    port = 3000,
    backendPath,
    frontendCommand,
    frontendPort = 3100,
  } = options;
  const devStartTime = Date.now();

  // ── Singleton guard ─────────────────────────────────────────────────────
  // Prevent two fighting supervisors: a second `npm run dev` must not spawn a
  // competing supervisor that races the first on :3000/:3100 (backend + Vite
  // EADDRINUSE → mutual Vite kills → restart loop). We record {pid, ppid, port}
  // in a per-port pidfile and consult it here. The `ppid` (stable `tsx watch`
  // watcher) lets us tell a hot-reload relaunch of OUR OWN script apart from a
  // genuine second invocation — see {@link evaluateSingleton}. A stale pidfile
  // (dead owner) never blocks startup.
  const pidfilePath = join(BLOCKS_SANDBOX_DIR, `dev-server.${port}.pid`);
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
      // Snapshot belongs to a successor — restore it and leave its guard intact.
      // Residual (astronomically narrow) window: between this rename-away and
      // rename-back the canonical path briefly has no pidfile, so a THIRD
      // concurrent start could momentarily see "no guard" and proceed — the same
      // benign "weakened guard, never broken startup" degradation the write path
      // already tolerates. tsx-watch drains the old supervisor before relaunching,
      // so overlap here does not occur in practice.
      try { renameSync(claimPath, pidfilePath); return; } catch { /* fall through to cleanup */ }
    }
    try { unlinkSync(claimPath); } catch { /* already gone */ }
  };
  {
    mkdirSync(BLOCKS_SANDBOX_DIR, { recursive: true });
    let existing: DevServerPidRecord | null = null;
    try { existing = parsePidRecord(readFileSync(pidfilePath, 'utf-8')); } catch { /* absent */ }
    const portInUse = await isPortOpen(port);
    const decision = evaluateSingleton(existing, { pid: process.pid, ppid: process.ppid }, portInUse, isPidAlive);
    if (decision.action === 'exit') {
      console.error(
        `\n⚠️  ${decision.reason}.\n` +
        `   Not starting a second dev server. Stop the other process (or run the ` +
        `cleanup script) and retry \`npm run dev\`.\n`,
      );
      process.exit(0);
    }
    try {
      writeFileSync(pidfilePath, JSON.stringify({ pid: process.pid, ppid: process.ppid, port }));
    } catch { /* best-effort — a missing pidfile only weakens the guard, never breaks startup */ }
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
  // Generic HTTP dev-route handlers: a dev attachment can push
  // `{ method, pathname, handle(req,res,url) }` here to own a path (e.g. an SSE stream) that
  // the inline request handler can't express via the buffered RPC/RawRoute layer. Checked
  // before API/frontend routing. Kept generic — not tied to any specific BB.
  (globalThis as any).__BLOCKS_DEV_ROUTE_HANDLERS__ = [];

  // 2. Import backend (sync construction phase — BBs register plugins via globals)
  console.log('Loading backend...');
  const backend = await import(backendUrl);

  // 3. Read collected dev attachments and clean up
  const devAttachments: string[] = (globalThis as any).__BLOCKS_DEV_ATTACHMENTS__;
  delete (globalThis as any).__BLOCKS_DEV_ATTACHMENTS__;
  // Dev route handlers are populated during attach() (below), so keep the array live and
  // read it per-request rather than snapshotting here.
  const devRouteHandlers: Array<{
    method: string;
    pathname: string;
    handle: (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;
  }> = (globalThis as any).__BLOCKS_DEV_ROUTE_HANDLERS__;

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
   * (via the shared {@link terminateProcessTree}), then poll until `:3100` is
   * released. tsx-watch gives us ~5s before it force-kills us, so this budget is
   * safe. Crucially the port-free wait runs on *both* paths — including when the
   * shell has already exited — so the post-exit branch no longer drops the
   * "wait for the port to free" guarantee.
   */
  const terminateFrontend = async (child: ChildProcess | null): Promise<void> => {
    if (!child) return;
    // SIGTERM→SIGKILL the whole tree, reaping the detached Vite grandchild even
    // when the shell has already exited (post-exit group kill — see policy).
    await terminateProcessTree(child, 1500);
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

    // ── Dev route handlers (e.g. SSE streams that can't use the buffered RPC layer) ──
    const devRoute = devRouteHandlers.find((h) => h.method === method && h.pathname === url.pathname);
    if (devRoute) {
      Promise.resolve(devRoute.handle(req, res, url)).catch((err) => {
        console.error(`[dev-route] ${method} ${url.pathname} failed:`, err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        } else {
          res.end();
        }
      });
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
    (r3000.reclaimed ? console.log : console.error)(reclaimMessage(port, r3000, 'a stale/orphaned listener'));
  }
  if (frontendCommand) {
    const rFrontend = await reclaimPort(frontendPort);
    if (rFrontend.wasOpen) {
      (rFrontend.reclaimed ? console.log : console.error)(reclaimMessage(frontendPort, rFrontend, 'a stale/orphaned dev server'));
    }
  }

  // ── Start listening ────────────────────────────────────────────────────
  const onListening = async (): Promise<void> => {
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
    relisten: () => server.listen(port, onListening),
    scheduleRetry: (fn, delayMs) => { setTimeout(fn, delayMs).unref?.(); },
    onExhausted: () => process.exit(1),
    warn: (msg) => console.error(msg),
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
    console.error(`\n❌ Dev server failed to start: ${err.message}\n`);
    process.exit(1);
  });

  server.listen(port, onListening);

  // ── Cleanup ────────────────────────────────────────────────────────────
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let cleaningUp = false;
  const cleanup = async () => {
    if (cleaningUp) return; // idempotent — a second signal must not re-enter
    cleaningUp = true;
    isShuttingDown = true; // stop the supervisor from respawning the frontend
    console.log('\nShutting down...');

    if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
    // Detach our own listeners so repeated signals can't pile up handlers.
    for (const sig of signals) process.removeListener(sig, cleanup);

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
    // Release our singleton pidfile on any exit path (crash, uncaught exception)
    // that bypassed cleanup(), so it never lingers and blocks the next start.
    removeOwnPidfile();
    const child = frontendProcess;
    if (!child) return;
    killFrontendTree(child, 'SIGKILL');
  });
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
