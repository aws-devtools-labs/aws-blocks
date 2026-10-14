// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Shared cross-platform process + local-registry mechanics for the CI template
// drivers (templates-e2e.mjs, the per-PR local loop; windows-template-e2e.mjs,
// the scheduled deploy smoke). Both forked the same spawn/kill/registry logic;
// this is the single definition so the OS-specific plumbing can't drift between
// them. Behaviour that legitimately differs between the two drivers is an
// explicit argument here, never a second copy.

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/** True on Windows, which has no POSIX process groups (so no `kill(-pid)`). */
export const isWin = process.platform === 'win32';

/**
 * Kill a process tree cross-platform. On Windows `taskkill /T` walks the child
 * tree (there are no process groups); on POSIX the child is spawned detached so
 * `kill(-pid)` signals the whole group. Never throws — an already-dead pid is
 * the normal case during shutdown.
 */
export function killTree(pid) {
	if (!pid) return;
	try {
		if (isWin) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
		else process.kill(-pid, 'SIGKILL');
	} catch {
		/* already gone */
	}
}

/**
 * Run a one-shot command to completion, inheriting stdio.
 *
 * `shell: isWin` is required so Windows resolves the `.cmd` shims (npm,
 * create-blocks-app). NOTE: with `shell:true`, spawnSync does NOT auto-quote
 * args, so a path argument containing a space breaks the Windows command line.
 * Both callers derive their only path args from RUNNER_TEMP, which on GitHub
 * windows-latest has no spaces; a Windows host whose temp dir contains a space
 * would need those args quoted or `shell:true` dropped.
 *
 * @param log when false, suppress the `$ <cmd>` banner (a caller that prints
 *   its own banner, e.g. a best-effort cleanup wrapper, passes false to avoid a
 *   duplicate line). Default true.
 * @returns the spawnSync result (`{status, error, ...}`). Callers decide how a
 *   non-zero status is handled — {@link runBool} for a boolean, {@link runOrThrow}
 *   to throw — so the two drivers keep their existing control flow.
 */
export function runSpawn(cmd, args, opts = {}, root, { log = true } = {}) {
	if (log) console.log(`\n$ ${cmd} ${args.join(' ')}  (cwd: ${opts.cwd ?? root})`);
	return spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, ...opts });
}

/** {@link runSpawn} that returns true on exit 0, false otherwise; never throws. */
export function runBool(cmd, args, opts = {}, root) {
	return runSpawn(cmd, args, opts, root).status === 0;
}

/** {@link runSpawn} that throws on a spawn error or non-zero exit. */
export function runOrThrow(cmd, args, opts = {}, root) {
	const r = runSpawn(cmd, args, opts, root);
	if (r.error) throw r.error;
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

/**
 * Probe a URL once. Returns false on any network error (never throws).
 *
 * @param okOnly when true, only a 2xx response counts as up (matches the old
 *   `curl -sf`: the registry metadata is actually served). When false, any HTTP
 *   response — including a 4xx — counts, which the deploy smoke's dev-server
 *   probe relies on. Default true.
 */
export async function httpUp(url, { okOnly = true } = {}) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
		return okOnly ? res.ok : res.status > 0;
	} catch {
		return false;
	}
}

/**
 * Spawn the local file-based registry and poll until it serves package
 * metadata. The child is detached on POSIX so {@link killTree} can reap its
 * group. Fails fast if the child exits before becoming ready (e.g. the port is
 * already bound, or dist-registry is malformed) so the real cause surfaces
 * instead of the full timeout.
 *
 * The port named in the error messages is derived from `registryUrl`, so it
 * cannot disagree with the URL the probe actually hits.
 *
 * Readiness is a 2xx-only check ({@link httpUp}'s default `okOnly`), matching
 * the old `curl -sf`. The windows-template-e2e driver's inline probe previously
 * accepted any HTTP response (`status > 0`) and had no fail-fast; routing it
 * through here converges it onto that stricter, more-correct behaviour.
 *
 * @returns the registry child process (push it onto your `children[]` and
 *   {@link killTree} it on shutdown).
 */
export async function startRegistry({ root, registryUrl, children, maxTries = 31 }) {
	const port = new URL(registryUrl).port || '(default)';
	const registry = spawn(process.execPath, ['--import', 'tsx', 'scripts/publish/serve-local-registry.ts'], {
		cwd: root,
		stdio: 'inherit',
		detached: !isWin,
	});
	children.push(registry);
	for (let i = 0; ; i++) {
		if (await httpUp(`${registryUrl}@aws-blocks/blocks`)) break;
		if (registry.exitCode !== null) {
			throw new Error(`Local registry process exited (${registry.exitCode}) before becoming ready on :${port}`);
		}
		// maxTries bounds the retry index: i runs 0..maxTries, one 1s sleep
		// between probes, so the default 31 is 32 attempts over ~31s (the same
		// count the old inline `i > 30` loop ran).
		if (i >= maxTries) throw new Error(`Local registry did not start on :${port}`);
		await sleep(1000);
	}
	return registry;
}
