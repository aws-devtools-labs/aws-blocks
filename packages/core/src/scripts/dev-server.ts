// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import httpProxy from 'http-proxy';
import { registerBuiltinRoutes } from '../builtin-routes.js';
import { BLOCKS_RPC_PREFIX, BLOCKS_SANDBOX_PREFIX } from '../constants.js';
import { ApiError } from '../errors.js';
import { lockRouteRegistry, matchRoute } from '../raw-route.js';
import { redactToJson } from '../redact.js';
import { errorResponseFromCatch, methodNotFoundResponse, parseRpcRequest, successResponse } from '../rpc.js';
import { buildAndSendEvent } from '../telemetry/client.js';
import { applyDevMigrations } from './external-migrations-step.js';
import { writeClientCode } from './generate-client.js';
import { killFrontendTree, terminateProcessTree } from './process-tree.js';

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
			socket.on('error', () => {
				socket.destroy();
				resolve(false);
			});
			socket.setTimeout(300, () => {
				socket.destroy();
				resolve(false);
			});
		});
		if (connected) return;
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
		const open = await new Promise<boolean>((resolve) => {
			const socket = createConnection({ port, host: 'localhost' }, () => {
				socket.destroy();
				resolve(true);
			});
			socket.on('error', () => {
				socket.destroy();
				resolve(false);
			});
			socket.setTimeout(200, () => {
				socket.destroy();
				resolve(false);
			});
		});
		if (!open) return;
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
	return !!child && child === current && child.exitCode === null && child.signalCode === null;
}

export async function startDevServer(options: DevServerOptions) {
	const { port = 3000, backendPath, frontendCommand, frontendPort = 3100 } = options;
	const devStartTime = Date.now();

	// Load .env.local if present (connection strings, project refs, etc.)
	try {
		process.loadEnvFile('.env.local');
	} catch (e: any) {
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

	// ── Start listening ────────────────────────────────────────────────────
	server.listen(port, async () => {
		console.log(`AWS Blocks local server running on http://localhost:${port}`);
		buildAndSendEvent({ command: 'dev', state: 'SUCCESS', duration: Date.now() - devStartTime });

		// Spawn frontend dev server after Blocks server is ready
		if (frontendCommand) {
			const child = spawnFrontend(frontendCommand);
			await announceFrontendReady(child);
		} else {
			console.log(`\n  ➜  http://localhost:${port}/\n`);
		}
	});

	server.on('error', (err: NodeJS.ErrnoException) => {
		const errorCode = err.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'UNKNOWN';
		buildAndSendEvent({
			command: 'dev',
			state: 'FAIL',
			duration: Date.now() - devStartTime,
			error: { code: errorCode, phase: 'startup' },
		});
	});

	// ── Cleanup ────────────────────────────────────────────────────────────
	const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
	let cleaningUp = false;
	const cleanup = async () => {
		if (cleaningUp) return; // idempotent — a second signal must not re-enter
		cleaningUp = true;
		isShuttingDown = true; // stop the supervisor from respawning the frontend
		console.log('\nShutting down...');

		if (respawnTimer) {
			clearTimeout(respawnTimer);
			respawnTimer = null;
		}
		// Detach our own listeners so repeated signals can't pile up handlers.
		for (const sig of signals) process.removeListener(sig, cleanup);

		// Kill the frontend process *group* and wait for the port to free before
		// we exit, so a tsx-watch restart can rebind `:3100` cleanly.
		const child = frontendProcess;
		frontendProcess = null;
		await terminateFrontend(child);

		if (typeof backend.__cleanup === 'function') {
			try {
				await backend.__cleanup();
			} catch {}
		}
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
		req.on('data', (chunk) => (body += chunk));
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
						get status() {
							return responseStatus;
						},
						set status(code: number) {
							responseStatus = code;
						},
						send: (b: any) => {
							responseBody = b;
						},
					},
				};

				const apiHandler = apis.get(apiNamespace);
				if (!apiHandler) {
					res.writeHead(200, rpcHeaders);
					res.end(
						methodNotFoundResponse(
							`API '${apiNamespace}' not found. Available: ${Array.from(apis.keys()).join(', ')}`,
							rpcId,
						),
					);
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
					console.log(
						'[rpc-ok]',
						`${apiNamespace}.${rpcMethod}`,
						okLog.length > 800 ? okLog.slice(0, 800) + '…' : okLog,
					);
				}
				res.writeHead(responseStatus, headerObj);
				res.end(successPayload);
			} catch (error: any) {
				const errPayload = errorResponseFromCatch(error, rpcId);
				if (!process.env.BLOCKS_DEV_QUIET) {
					console.log(
						'[rpc-err]',
						`${apiNamespace}.${rpcMethod}`,
						error?.name ?? 'Error',
						'-',
						error?.message,
					);
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
		req.on('data', (chunk: string) => (body += chunk));
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
						get status() {
							return responseStatus;
						},
						set status(code: number) {
							responseStatus = code;
						},
						send: (b: any) => {
							responseBody = b;
						},
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
				res.end(
					responseBody !== undefined
						? typeof responseBody === 'string'
							? responseBody
							: JSON.stringify(responseBody)
						: '',
				);
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
