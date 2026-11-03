// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Windows regression check of the `blocks dev` session, run by templates-e2e.mjs
// on the Windows lane against the scaffolded `default` app (a backend and a Vite
// frontend). Each template's `test:e2e` tears its dev server down with
// `taskkill /T /F` from the top, which hides what a user runs:
//   1. `blocks dev` → HTTP 200 → a backend edit (a `tsx watch` restart) → still 200;
//   2. `blocks dev stop` → no node/tsx/vite/esbuild process of the app is left,
//      both ports are free, and the pidfile is gone;
//   3. a hard kill of the `blocks dev` CLI (as Task Manager does), then a new
//      `blocks dev` that starts, and stops cleanly;
//   4. a first start whose port another process holds exits non-zero.
// Every wait is bounded. Ports 4510/4610, so a developer's 3000/3100 are never touched.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 4510;
const FRONTEND_PORT = 4610;

/** Poll `predicate` every 500 ms until it holds; false after `ms`. */
async function waitFor(predicate, ms) {
	for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(500)) {
		if (await predicate()) return true;
	}
	return false;
}

async function status(url) {
	try {
		return (await fetch(url, { signal: AbortSignal.timeout(3000) })).status;
	} catch {
		return 0;
	}
}

/** The node, tsx, vite and esbuild processes whose command line names the app directory. */
function appProcesses(app) {
	const { stdout } = spawnSync(
		'powershell.exe',
		[
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
		],
		{ encoding: 'utf-8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
	);
	const all = [JSON.parse(stdout || '[]')].flat();
	const dir = app.toLowerCase();
	return all.filter(
		(p) =>
			/node|tsx|vite|esbuild/i.test(p.Name ?? '') &&
			String(p.CommandLine ?? '').toLowerCase().includes(dir) &&
			p.ProcessId !== process.pid,
	);
}

/** True when something listens on `port`, IPv4 or IPv6. */
function listening(port) {
	const { stdout } = spawnSync('netstat', ['-ano'], { encoding: 'utf-8', windowsHide: true });
	return (stdout ?? '').split(/\r?\n/).some((line) => {
		const cols = line.trim().split(/\s+/);
		return cols[0] === 'TCP' && cols[1]?.endsWith(`:${port}`) && /^(0\.0\.0\.0|\[::\]):0$/.test(cols[2] ?? '');
	});
}

/** Check the Windows `blocks dev` lifecycle in `app`; throws on the first failure. */
export async function checkDevLifecycle(app, env, logDir) {
	const bin = join(app, 'node_modules', '@aws-blocks', 'blocks', 'dist', 'cli', 'bin.js');
	const pidfile = join(app, '.blocks-sandbox', `dev-server.${PORT}.pid`);
	const record = () => {
		try {
			return JSON.parse(readFileSync(pidfile, 'utf-8'));
		} catch {
			return null;
		}
	};
	const devArgs = [bin, 'dev', '--port', String(PORT), '--frontend-port', String(FRONTEND_PORT)];
	let run = 0;
	const sessions = [];
	/** Start `blocks dev` as a user does, its output in a log file; resolves `exit` with its exit code. */
	const startDev = () => {
		const log = join(logDir, `dev-lifecycle-${++run}.log`);
		writeFileSync(log, '');
		const child = spawn(process.execPath, devArgs, { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => appendFileSync(log, chunk));
		const exit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
		const session = { child, log, exit };
		sessions.push(session);
		return session;
	};
	const fail = (message, session) => {
		const output = session ? `\n--- ${session.log} ---\n${readFileSync(session.log, 'utf-8')}` : '';
		throw new Error(`dev lifecycle: ${message}${output}`);
	};
	const ready = async (session) => {
		if (!(await waitFor(async () => (await status(`http://localhost:${PORT}/.blocks-sandbox/config.json`)) === 200, 120_000)))
			fail('blocks dev did not answer HTTP 200 within 120 s', session);
		if (!(await waitFor(async () => (await status(`http://localhost:${PORT}/`)) === 200, 60_000)))
			fail('the frontend did not answer through the dev server within 60 s', session);
		// On Windows the dev server records its frontend's listeners once they listen (one CIM query).
		if (!(await waitFor(() => (record()?.frontend?.listeners?.length ?? 0) > 0, 30_000)))
			fail(`the pidfile names no frontend listener: ${JSON.stringify(record())}`, session);
	};
	const stopped = async (session) => {
		const stop = spawnSync(process.execPath, [bin, 'dev', 'stop', '--port', String(PORT)], {
			cwd: app,
			env,
			encoding: 'utf-8',
			timeout: 60_000,
		});
		console.log(`  blocks dev stop: exit ${stop.status}\n${stop.stdout}${stop.stderr}`);
		if (stop.status !== 0) fail(`blocks dev stop exited ${stop.status}`, session);
		const clean = await waitFor(
			() => appProcesses(app).length === 0 && !listening(PORT) && !listening(FRONTEND_PORT) && !existsSync(pidfile),
			30_000,
		);
		if (!clean) {
			const left = appProcesses(app).map((p) => `  pid=${p.ProcessId} ${p.Name}: ${p.CommandLine}`);
			fail(
				`30 s after blocks dev stop: ${left.length} process(es) left, :${PORT} ${listening(PORT) ? 'bound' : 'free'}, ` +
					`:${FRONTEND_PORT} ${listening(FRONTEND_PORT) ? 'bound' : 'free'}, pidfile ${existsSync(pidfile) ? 'present' : 'gone'}\n${left.join('\n')}`,
				session,
			);
		}
		// A save after the stop must not start the dev server again.
		appendFileSync(join(app, 'aws-blocks', 'index.ts'), '\n// edited after dev stop\n');
		await sleep(5000);
		if ((await status(`http://localhost:${PORT}/.blocks-sandbox/config.json`)) !== 0)
			fail('a backend save after blocks dev stop started the dev server again', session);
	};

	try {
		console.log('\n--- dev lifecycle 1: blocks dev, a backend edit, blocks dev stop ---');
		const first = startDev();
		await ready(first);
		const before = record()?.pid;
		appendFileSync(join(app, 'aws-blocks', 'index.ts'), '\n// edited by the dev lifecycle check\n');
		if (!(await waitFor(() => (record()?.pid ?? before) !== before, 60_000)))
			fail('the backend edit did not restart the dev server within 60 s', first);
		await ready(first);
		await stopped(first);

		console.log('\n--- dev lifecycle 2: a hard kill of the blocks dev CLI, then blocks dev again ---');
		const killed = startDev();
		await ready(killed);
		// Task Manager's End task: TerminateProcess of the CLI alone, not its tree.
		spawnSync('taskkill', ['/PID', String(killed.child.pid), '/F'], { stdio: 'ignore' });
		await killed.exit;
		const restarted = startDev();
		await ready(restarted);
		await stopped(restarted);

		console.log('\n--- dev lifecycle 3: a failed first start exits non-zero ---');
		const holder = createServer();
		await new Promise((resolve, reject) => holder.once('error', reject).listen(PORT, '127.0.0.1', resolve));
		try {
			const failing = startDev();
			const code = await Promise.race([failing.exit, sleep(90_000, 'timeout')]);
			if (code === 'timeout') fail('blocks dev with its port held did not exit within 90 s', failing);
			if (code === 0) fail('blocks dev with its port held exited 0', failing);
			console.log(`  blocks dev with :${PORT} held exited ${code}`);
		} finally {
			holder.close();
		}
		console.log('  ✓ dev lifecycle passed');
	} finally {
		for (const { child } of sessions) {
			if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
		}
	}
}
