// Step 3's bridge to the agent-user boundary. 3-build-and-test.sh is the trusted supervisor (runner
// uid): it alone writes GITHUB_OUTPUT and reads evidence. Every process that runs the agent's app or
// its dependencies (package.json probes, npm install + lifecycle scripts, build, dev server,
// Playwright against the app) is started through this helper, as the agent user with the scrubbed env
// (no credentials, no GITHUB_* file-command paths, no RUNNER_TEMP). The supervisor opens the
// stdout/stderr redirects, so logs land in runner-owned files.
//
//   node agent-exec.mjs preflight <workspace>         enter the boundary (reap, ACL, lock + verify)
//   node agent-exec.mjs run <cwd> [K=V …] -- <cmd>    run <cmd> (bash -c) as the agent user
//   node agent-exec.mjs reap                          kill every agent-user process; verify none left
//   node agent-exec.mjs read-file <src> <dst>         copy an agent-written file without following
//                                                     symlinks (regular file, ≤ 20 MiB) to <dst>
// Exit codes: run → the command's; others 0 ok / 1 failure.
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { buildAgentSpawn, enterAgentPhase, isolationAvailable, reapAgentProcesses } from './isolation.mjs';
import { buildShellEnv } from './secrets.mjs';

const MAX_READ_BYTES = 20 * 1024 * 1024;
const [mode, ...rest] = process.argv.slice(2);

function fail(msg) {
	process.stderr.write(`[agent-exec] ${msg}\n`);
	process.exit(1);
}

if (mode === 'preflight') {
	const phase = enterAgentPhase(rest[0] ?? fail('preflight needs a workspace'));
	if (phase.error) fail(phase.error);
	process.stderr.write(`[agent-exec] agent isolation: ${phase.isolated ? 'ACTIVE' : 'BARE (local dev opt-in)'}\n`);
} else if (mode === 'run') {
	const sep = rest.indexOf('--');
	if (sep < 1 || sep !== rest.length - 2) fail('usage: run <cwd> [K=V …] -- <command>');
	const cwd = rest[0];
	/** @type {Record<string, string>} */
	const overrides = {};
	for (const kv of rest.slice(1, sep)) {
		const i = kv.indexOf('=');
		if (i < 1) fail(`bad override ${JSON.stringify(kv)}`);
		overrides[kv.slice(0, i)] = kv.slice(i + 1);
	}
	const env = buildShellEnv(process.env, { overrides });
	let spawnSpec;
	try {
		spawnSpec = buildAgentSpawn(rest[sep + 1], cwd, isolationAvailable(), env);
	} catch (err) {
		fail(err?.message ?? String(err));
	}
	const child = spawn(spawnSpec.file, spawnSpec.args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
	// Forward a TERM/INT from the supervisor (the agent-user group is reaped separately).
	for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
	child.on('error', (err) => fail(err.message));
	child.on('exit', (code, sig) => process.exit(code ?? (sig ? 128 : 1)));
} else if (mode === 'reap') {
	if (!reapAgentProcesses()) fail('agent-user processes survived the reap');
} else if (mode === 'read-file') {
	const [src, dst] = rest;
	if (!src || !dst) fail('usage: read-file <src> <dst>');
	let fd;
	try {
		fd = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (err) {
		fail(`cannot open ${src} without following links: ${err?.code ?? err}`);
	}
	const st = fstatSync(fd);
	if (!st.isFile() || st.size > MAX_READ_BYTES) fail(`${src} is not a regular file of at most 20 MiB`);
	const buf = Buffer.alloc(st.size);
	let off = 0;
	while (off < st.size) {
		const n = readSync(fd, buf, off, st.size - off, off);
		if (n === 0) break;
		off += n;
	}
	closeSync(fd);
	rmSync(dst, { force: true });
	writeFileSync(dst, buf.subarray(0, off), { flag: 'wx', mode: 0o644 });
} else {
	fail('usage: agent-exec.mjs preflight|run|reap|read-file …');
}
