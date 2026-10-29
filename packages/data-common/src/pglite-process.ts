// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keep a local PGlite engine from holding the Node.js process open, and shut
 * it down cleanly when the process is about to exit.
 *
 * PGlite runs PostgreSQL in-process via WASM. PostgreSQL's timeouts (the idle
 * stats flush, statement/lock timeouts, …) go through an emulated `setitimer`
 * that Emscripten implements with a plain, ref'd `setTimeout`, and PostgreSQL
 * re-arms it about every 10s. Nothing else holds the event loop for it, so a
 * short-lived script that imported a backend with a local database mock (a CLI
 * step, a seed script, a test) never exited, and — because the engine was never
 * closed — the next start found a stale `postmaster.pid`.
 *
 * Two pieces, used together by the PGlite-backed mock engines:
 *  - {@link pgliteUnrefTimersExtension} makes every timer PGlite's WASM arms
 *    `unref()`'d, so the engine never keeps the process alive by itself. A
 *    long-running process (the dev server) is unaffected: its HTTP server holds
 *    the loop, and an unref'd timer still fires on time while the loop is alive.
 *  - {@link closeOnProcessExit} closes the engine once the event loop has
 *    nothing left to do (`beforeExit`), so PostgreSQL shuts down cleanly and
 *    removes its `postmaster.pid`.
 *
 * Like `pglite-init.ts`, this module is PGlite-agnostic (structural types only)
 * so `data-common` need not depend on `@electric-sql/pglite`.
 */

let unrefDepth = 0;

/**
 * Run `fn` synchronously with `setTimeout` patched so every timer created
 * inside it is `unref()`'d. A callback of such a timer runs under the same
 * patch, so a timer that re-arms itself from its own callback stays unref'd.
 *
 * Only synchronous code inside `fn` is affected — the original `setTimeout` is
 * restored before this returns — so timers created by unrelated code are never
 * touched. Used around PGlite's WASM entry points, which run synchronously.
 *
 * @internal
 */
export function runWithUnrefTimers<T>(fn: () => T): T {
	if (unrefDepth > 0) return fn();
	const original = globalThis.setTimeout;
	const patched = (handler: unknown, timeout?: number, ...args: unknown[]) => {
		const callback =
			typeof handler === 'function'
				? (...cbArgs: unknown[]) => runWithUnrefTimers(() => handler(...cbArgs))
				: handler;
		const timer: unknown = Reflect.apply(original, globalThis, [callback, timeout, ...args]);
		if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
			timer.unref();
		}
		return timer;
	};
	Reflect.set(globalThis, 'setTimeout', patched);
	unrefDepth++;
	try {
		return fn();
	} finally {
		unrefDepth--;
		// Restore only our own patch — never clobber a replacement installed meanwhile.
		if (globalThis.setTimeout === (patched as unknown)) Reflect.set(globalThis, 'setTimeout', original);
	}
}

/** The slice of a PGlite instance {@link pgliteUnrefTimersExtension} wraps. */
interface PgliteSyncExec {
	execProtocolRawSync?: (message: Uint8Array) => Uint8Array;
}

/** The slice of PGlite's Emscripten module the extension wraps (`callMain` runs `initdb` and startup). */
interface EmscriptenModuleLike {
	callMain?: (args: string[]) => unknown;
}

/**
 * Structural shape of a PGlite extension (`new PGlite(dir, { extensions: { … } })`).
 *
 * @internal
 */
export interface PgliteExtensionLike {
	name: string;
	setup: (
		pg: unknown,
		emscriptenOpts: Record<string, unknown>,
	) => Promise<{ emscriptenOpts: Record<string, unknown> }>;
}

/**
 * A PGlite extension that `unref()`s every timer PGlite's WASM arms, so a local
 * PGlite never keeps the Node.js process alive by itself. Pass it when
 * constructing the instance:
 *
 * ```ts
 * new PGlite(dataDir, { extensions: { awsBlocksUnrefTimers: pgliteUnrefTimersExtension } });
 * ```
 *
 * It wraps the two synchronous ways into the WASM: the instance's
 * `execProtocolRawSync` (every query, and `close()`) and the module's
 * `callMain` (`initdb` and startup, which arm the timer on a fresh data dir).
 * Timer callbacks run under the same wrapper (see {@link runWithUnrefTimers}),
 * so PostgreSQL re-arming its timer from a timeout keeps it unref'd. If a
 * future PGlite renames either entry point, the wrapper is skipped and PGlite
 * behaves exactly as without the extension.
 *
 * @internal
 */
export const pgliteUnrefTimersExtension: PgliteExtensionLike = {
	name: 'aws-blocks-unref-timers',
	setup: async (pg, emscriptenOpts) => {
		const instance = pg as PgliteSyncExec;
		const exec = instance.execProtocolRawSync;
		if (typeof exec === 'function') {
			instance.execProtocolRawSync = function (this: unknown, message: Uint8Array) {
				return runWithUnrefTimers(() => exec.call(this, message));
			};
		}
		const preRun = emscriptenOpts.preRun;
		const previous: unknown[] = preRun == null ? [] : Array.isArray(preRun) ? preRun : [preRun];
		const wrapCallMain = (mod: EmscriptenModuleLike) => {
			const callMain = mod.callMain;
			if (typeof callMain !== 'function') return;
			mod.callMain = (args: string[]) => runWithUnrefTimers(() => callMain.call(mod, args));
		};
		return { emscriptenOpts: { ...emscriptenOpts, preRun: [...previous, wrapCallMain] } };
	},
};

const pendingClosers = new Set<() => Promise<void>>();
let listening = false;

function closePendingOnBeforeExit(): void {
	if (pendingClosers.size === 0) return;
	const closers = [...pendingClosers];
	pendingClosers.clear();
	for (const close of closers) {
		// Best effort: the process is exiting anyway. Closing schedules work, so
		// Node runs it and emits `beforeExit` again; with nothing left, it exits.
		close().catch(() => {});
	}
}

/**
 * Run `close` once the process's event loop has nothing left to do (Node's
 * `beforeExit`), so a local engine shuts down cleanly instead of being torn
 * down mid-flight. Runs at most once per registration; returns a function
 * that cancels it (call it when the engine is closed explicitly).
 *
 * `beforeExit` is not emitted for `process.exit()` or a fatal signal, so a dev
 * server stopped with Ctrl-C still leaves `postmaster.pid` behind; the engines
 * remove a stale one on the next start, as before.
 *
 * @internal
 */
export function closeOnProcessExit(close: () => Promise<void>): () => void {
	pendingClosers.add(close);
	if (!listening && typeof process !== 'undefined' && typeof process.on === 'function') {
		listening = true;
		process.on('beforeExit', closePendingOnBeforeExit);
	}
	return () => {
		pendingClosers.delete(close);
	};
}
